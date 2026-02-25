import * as core from '@actions/core';
import * as github from '@actions/github';
import { execSync } from 'child_process';
import Groq from 'groq-sdk';

interface ReleaseNotesResponse {
  features: string[];
  improvements: string[];
  bugFixes: string[];
  breakingChanges: string[];
  other: string[];
}

/**
 * Parse tag for x.x.x-channel format (semantic versioning with channel).
 * Returns { version, channel } or null if not in that format.
 */
function parseTagWithChannel(tag: string): { version: string; channel: string } | null {
  const match = tag.match(/^(.+)-([A-Za-z]+)$/);
  if (match) {
    return { version: match[1], channel: match[2] };
  }
  return null;
}

function getSameChannelTags(candidates: string[], currentTag: string): string[] {
  const parsed = parseTagWithChannel(currentTag);
  if (!parsed) return candidates;

  return candidates.filter(tag => {
    const p = parseTagWithChannel(tag);
    return p && p.channel === parsed.channel;
  });
}

async function getPreviousTag(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  currentTag: string,
  previousTag?: string
): Promise<{ tag: string | null; commit: string | null }> {
  try {
    let tagToUse: string | null = null;

    if (previousTag && previousTag.trim()) {
      // If explicitly provided, use it
      try {
        execSync(`git rev-parse --verify "${previousTag}"`, { stdio: 'ignore' });
        tagToUse = previousTag.trim();
      } catch {
        core.warning(`Previous tag ${previousTag} not found`);
        return { tag: null, commit: null };
      }
    } else {
      // Try to get the latest release from GitHub API
      try {
        core.info('Fetching latest release from GitHub API...');
        const releases = await octokit.rest.repos.listReleases({
          owner,
          repo,
          per_page: 20
        });

        const candidates = releases.data
          .map(r => r.tag_name)
          .filter(tag => tag !== currentTag);

        // For x.x.x-channel format: prefer same-channel tags
        const sameChannel = getSameChannelTags(candidates, currentTag);
        const toSearch = sameChannel.length > 0 ? sameChannel : candidates;

        if (toSearch.length > 0) {
          tagToUse = toSearch[0];
          core.info(`Found previous release tag: ${tagToUse}`);
        } else {
          core.info('No previous release found via API, falling back to git tags');
        }
      } catch (apiError) {
        core.warning(`Failed to fetch releases from GitHub API: ${apiError}. Falling back to git tags.`);
      }

      // Fallback to git tags if API didn't work or didn't find a release
      if (!tagToUse) {
        core.info('Using git tags as fallback...');
        const tags = execSync('git tag --sort=-version:refname', { encoding: 'utf-8' })
          .trim()
          .split('\n')
          .filter(tag => tag && tag !== currentTag);

        // For x.x.x-channel: prefer same-channel tags
        const sameChannel = getSameChannelTags(tags, currentTag);
        const toUse = sameChannel.length > 0 ? sameChannel : tags;

        if (toUse.length > 0) {
          tagToUse = toUse[0];
          core.info(`Found previous git tag: ${tagToUse}`);
        }
      }
    }

    if (!tagToUse) {
      core.info('No previous tag found');
      return { tag: null, commit: null };
    }

    // Get the commit SHA that the tag points to
    const commitSha = execSync(`git rev-parse "${tagToUse}"`, { encoding: 'utf-8' }).trim();
    return { tag: tagToUse, commit: commitSha };
  } catch (error) {
    core.warning(`Could not find previous tag: ${error}`);
    return { tag: null, commit: null };
  }
}

interface Limits {
  diffLimit: number;
  commitsLimit: number;
}

function resolveLimits(
  detailLevel: string,
  diffLimitInput: string,
  commitsLimitInput: string
): Limits {
  const presets: Record<string, { diff: number; commits: number }> = {
    brief: { diff: 60, commits: 25 },
    standard: { diff: 120, commits: 60 },
    detailed: { diff: 250, commits: 120 }
  };
  const preset = presets[detailLevel.toLowerCase()] || presets.standard;
  return {
    diffLimit: diffLimitInput ? parseInt(diffLimitInput, 10) || preset.diff : preset.diff,
    commitsLimit: commitsLimitInput ? parseInt(commitsLimitInput, 10) || preset.commits : preset.commits
  };
}

function getReleaseMetadata(currentTag: string): { commitHash: string; releaseDate: string } {
  try {
    let currentCommit: string;
    try {
      currentCommit = execSync(`git rev-parse ${currentTag}`, { encoding: 'utf-8' }).trim();
    } catch {
      currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    }
    const shortHash = execSync(`git rev-parse --short ${currentCommit}`, { encoding: 'utf-8' }).trim();
    const dateStr = execSync(`git log -1 --format=%ci ${currentCommit}`, { encoding: 'utf-8' }).trim();
    const releaseDate = dateStr ? dateStr.split(' ')[0] : new Date().toISOString().split('T')[0];
    return { commitHash: shortHash, releaseDate };
  } catch {
    return { commitHash: 'unknown', releaseDate: new Date().toISOString().split('T')[0] };
  }
}

function getGitDiff(previousCommit: string | null, currentTag: string, diffLimit: number): string {
  try {
    // Get the commit SHA that the current tag points to
    let currentCommit: string;
    try {
      currentCommit = execSync(`git rev-parse ${currentTag}`, { encoding: 'utf-8' }).trim();
    } catch {
      // If tag doesn't exist, use HEAD
      currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    }

    if (!previousCommit) {
      const stat = execSync(`git diff --stat ${currentCommit}`, { encoding: 'utf-8' });
      const summary = execSync(`git log --oneline ${currentCommit}`, { encoding: 'utf-8' });
      const summaryLines = summary.trim().split('\n').slice(0, diffLimit).join('\n');
      return `Summary:\n${summaryLines}\n\nFile changes:\n${stat}`;
    }

    const stat = execSync(`git diff --stat ${previousCommit}..${currentCommit}`, { encoding: 'utf-8' });

    let codeDiff = '';
    try {
      const fullDiff = execSync(`git diff ${previousCommit}..${currentCommit}`, {
        encoding: 'utf-8',
        maxBuffer: 2 * 1024 * 1024
      });
      const lines = fullDiff.trim().split('\n');
      const limit = Math.min(diffLimit, lines.length);
      codeDiff = lines.slice(0, limit).join('\n');
      if (lines.length > limit) {
        codeDiff += '\n... (truncated)';
      }
    } catch {
      // If that fails, just use stat
    }

    return `File changes summary:\n${stat}\n\nSample code changes:\n${codeDiff || '(too large to display)'}`;
  } catch (error) {
    core.warning(`Could not get git diff: ${error}`);
    return '';
  }
}

function getCommitMessages(previousCommit: string | null, currentTag: string, commitsLimit: number): string {
  try {
    let currentCommit: string;
    try {
      currentCommit = execSync(`git rev-parse ${currentTag}`, { encoding: 'utf-8' }).trim();
    } catch {
      currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    }

    let commits: string;
    if (!previousCommit) {
      commits = execSync(`git log --pretty=format:"%h - %s (%an)" ${currentCommit}`, { encoding: 'utf-8' });
    } else {
      commits = execSync(`git log ${previousCommit}..${currentCommit} --pretty=format:"%h - %s (%an)"`, { encoding: 'utf-8' });
    }

    const lines = commits.trim().split('\n');
    const limited = lines.slice(0, commitsLimit).join('\n');
    return lines.length > commitsLimit ? limited + '\n... (truncated)' : limited;
  } catch (error) {
    core.warning(`Could not get commit messages: ${error}`);
    return '';
  }
}

function getChangedFiles(previousCommit: string | null, currentTag: string): string {
  try {
    // Get the commit SHA that the current tag points to
    let currentCommit: string;
    try {
      currentCommit = execSync(`git rev-parse ${currentTag}`, { encoding: 'utf-8' }).trim();
    } catch {
      // If tag doesn't exist, use HEAD
      currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    }

    if (!previousCommit) {
      // If no previous commit, get all changed files up to current
      return execSync(`git diff --name-only ${currentCommit}`, { encoding: 'utf-8' });
    }

    // Get changed files between commits
    return execSync(`git diff --name-only ${previousCommit}..${currentCommit}`, { encoding: 'utf-8' });
  } catch (error) {
    core.warning(`Could not get changed files: ${error}`);
    return '';
  }
}

function getContributors(previousCommit: string | null, currentTag: string): { current: Set<string>; previous: Set<string> } {
  try {
    // Get the commit SHA that the current tag points to
    let currentCommit: string;
    try {
      currentCommit = execSync(`git rev-parse ${currentTag}`, { encoding: 'utf-8' }).trim();
    } catch {
      // If tag doesn't exist, use HEAD
      currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    }

    // Get contributors from commits in this release
    let currentContributors = new Set<string>();
    try {
      const currentCommits = previousCommit
        ? execSync(`git log ${previousCommit}..${currentCommit} --pretty=format:"%an"`, { encoding: 'utf-8' })
        : execSync(`git log ${currentCommit} --pretty=format:"%an"`, { encoding: 'utf-8' });
      
      currentCommits.split('\n').forEach(name => {
        const trimmed = name.trim();
        if (trimmed) {
          currentContributors.add(trimmed);
        }
      });
    } catch (error) {
      core.warning(`Could not get current contributors: ${error}`);
    }

    // Get contributors from previous releases (all commits before previous commit)
    let previousContributors = new Set<string>();
    if (previousCommit) {
      try {
        const previousCommits = execSync(`git log ${previousCommit} --pretty=format:"%an"`, { encoding: 'utf-8' });
        previousCommits.split('\n').forEach(name => {
          const trimmed = name.trim();
          if (trimmed) {
            previousContributors.add(trimmed);
          }
        });
      } catch (error) {
        core.warning(`Could not get previous contributors: ${error}`);
      }
    }

    return { current: currentContributors, previous: previousContributors };
  } catch (error) {
    core.warning(`Could not get contributors: ${error}`);
    return { current: new Set(), previous: new Set() };
  }
}

async function generateReleaseNotes(
  groqClient: Groq,
  model: string,
  diff: string,
  commits: string,
  changedFiles: string,
  tagName: string,
  releaseName: string,
  previousTag: string | null,
  newContributors: string[],
  metadata: { commitHash: string; releaseDate: string },
  stats: { commitCount: number; contributorCount: number; filesChanged: number },
  compatibility: string,
  maxTokens: number,
  limits: Limits,
  template?: string
): Promise<string> {
  // Conservative char limits to stay under Groq input token limits (~6k for on_demand tier)
  const maxDiffLength = limits.diffLimit * 35;
  const maxCommitsLength = limits.commitsLimit * 25;
  const truncatedDiff = diff.length > maxDiffLength ? diff.substring(0, maxDiffLength) + '\n... (truncated)' : diff;
  const truncatedCommits = commits.length > maxCommitsLength ? commits.substring(0, maxCommitsLength) + '\n... (truncated)' : commits;

  const metadataBlock = `Available metadata to use: Release Date ${metadata.releaseDate}, Build ${metadata.commitHash}, Commits ${stats.commitCount}, Contributors ${stats.contributorCount}, Files changed ${stats.filesChanged}${compatibility ? `, Compatibility ${compatibility}` : ''}${newContributors.length > 0 ? `, New contributors: ${newContributors.join(', ')}` : ''}.`;

  const formatInstructions = template
    ? `\n**Template to follow:**\n${template}\n${metadataBlock}\n`
    : `

**Output format (follow this structure):**

\`\`\`
${tagName} — ${releaseName}

Release Date: ${metadata.releaseDate}
Build: ${metadata.commitHash}
${compatibility ? `Compatibility: ${compatibility}` : ''}

## Overview
Short executive summary. Use emojis where appropriate: 🚀 Major feature, ⚡ Performance, 🐛 Stability, 💥 Breaking.
This release focuses on: [bullet points]

## What's New
[Feature Name] with brief explanation, key capabilities, limitations if any.

## Improvements
### Performance Improvements
[Concrete details with how/why if relevant]

### UX / Quality Improvements
[Clearer errors, better logging, UI changes, etc.]

## Fixes
[Bug fixes with enough context to be useful. If severe, briefly explain impact.]

## Breaking Changes
[Only if there are actual breaking changes. Use Old/New format. Migration steps if needed.]

## Dependency Updates
[Package upgrades if visible in diff/commits. Omit if none.]

## Internal Changes
[For contributors: refactoring, tests, CI - only if present in changes]

## Stats
Commits: ${stats.commitCount} | Contributors: ${stats.contributorCount} | Files changed: ${stats.filesChanged}
${newContributors.length > 0 ? `\nNew contributors: ${newContributors.join(', ')}` : ''}
\`\`\``;

  const prompt = `You are a technical writer creating in-depth release notes for a software project.

CRITICAL: Only list changes that are explicitly present in the diffs and commit messages below. Do not invent, assume, or infer changes not directly shown. Every change must be directly relevant to the released program.
Do not mention documentation, README, CI, or workflow updates unless they materially affect the release contents or behavior.

**Current Release Tag:** ${tagName}
**Previous Release Tag:** ${previousTag || 'N/A (first release)'}

**Changed Files:**
\`\`\`
${changedFiles || 'No files changed'}
\`\`\`

**Git Diff (what changed between releases):**
\`\`\`
${truncatedDiff || 'No changes detected'}
\`\`\`

**Commit Messages:**
\`\`\`
${truncatedCommits || 'No commits'}
\`\`\`

Based ONLY on the information above, generate detailed release notes. Go in-depth on changes - explain what was done and why it matters when the diff/commits support it. Omit sections that have no changes.
${formatInstructions}

Generate the release notes now:`;

  try {
    const completion = await groqClient.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You are a technical writer specializing in creating detailed, well-structured release notes. You analyze code changes and commit messages to produce comprehensive release notes with clear sections: overview, features, improvements, fixes, breaking changes, dependency updates. Be specific and in-depth. Only include what is explicitly supported by the provided diff and commits.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      model: model,
      temperature: 0.7,
      max_tokens: maxTokens
    });

    const notes = completion.choices[0]?.message?.content || 'No release notes generated.';
    return notes.trim();
  } catch (error) {
    core.setFailed(`Failed to generate release notes: ${error}`);
    throw error;
  }
}

/**
 * Extract release name from the first line of generated notes.
 * Expected format: "tagName — Release Name" or "tagName - Release Name"
 */
function extractReleaseNameFromNotes(notes: string, tagName: string): string | null {
  const firstLine = notes.split('\n')[0]?.trim();
  if (!firstLine) return null;
  // Match tag followed by em dash, en dash, or regular dash
  const match = firstLine.match(new RegExp(`^${escapeRegex(tagName)}\\s*[—–-]\\s*(.+)$`));
  return match ? match[1].trim() : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function createRelease(
  octokit: ReturnType<typeof github.getOctokit>,
  tagName: string,
  releaseName: string,
  body: string,
  draft: boolean,
  prerelease: boolean,
  files?: string[],
  releaseNameWasProvided?: boolean
): Promise<{ id: number; url: string }> {
  const { owner, repo } = github.context.repo;

  try {
    // Create the release
    const release = await octokit.rest.repos.createRelease({
      owner,
      repo,
      tag_name: tagName,
      name: releaseName,
      body: body,
      draft: draft,
      prerelease: prerelease
    });

    const releaseId = release.data.id;
    const releaseUrl = release.data.html_url;

    // Upload files if provided
    if (files && files.length > 0) {
      for (const filePath of files) {
        try {
          const fs = require('fs');
          const path = require('path');
          
          if (!fs.existsSync(filePath)) {
            core.warning(`File not found: ${filePath}`);
            continue;
          }

          const fileName = path.basename(filePath);
          const fileContent = fs.readFileSync(filePath);
          const fileSize = fs.statSync(filePath).size;

          core.info(`Uploading ${fileName} (${fileSize} bytes)...`);

          await octokit.rest.repos.uploadReleaseAsset({
            owner,
            repo,
            release_id: releaseId,
            name: fileName,
            data: fileContent as any,
            headers: {
              'content-type': 'application/octet-stream',
              'content-length': fileSize
            }
          });

          core.info(`Successfully uploaded ${fileName}`);
        } catch (error) {
          core.warning(`Failed to upload ${filePath}: ${error}`);
        }
      }
    }

    return { id: releaseId, url: releaseUrl };
  } catch (error: any) {
    if (error.status === 422 && error.message?.includes('already exists')) {
      core.info(`Release ${tagName} already exists. Updating...`);

      const releases = await octokit.rest.repos.listReleases({ owner, repo });
      const existingRelease = releases.data.find(r => r.tag_name === tagName);

      if (existingRelease) {
        // Only update name if user provided one, or if existing release has no custom name (defaults to tag)
        const existingName = existingRelease.name || tagName;
        const nameToUse =
          releaseNameWasProvided || existingName === tagName || existingName === ''
            ? releaseName
            : existingName;

        const updated = await octokit.rest.repos.updateRelease({
          owner,
          repo,
          release_id: existingRelease.id,
          name: nameToUse,
          body: body,
          draft: draft,
          prerelease: prerelease
        });

        return { id: updated.data.id, url: updated.data.html_url };
      }
    }
    
    core.setFailed(`Failed to create release: ${error}`);
    throw error;
  }
}

async function run(): Promise<void> {
  try {
    const groqApiKey = core.getInput('groq_api_key', { required: true });
    const tagName = core.getInput('tag_name', { required: true });
    const releaseNameInput = core.getInput('release_name');
    const draft = core.getBooleanInput('draft');
    const prerelease = core.getBooleanInput('prerelease');
    const model = core.getInput('model') || 'meta-llama/llama-4-maverick-17b-128e-instruct';
    const previousTagInput = core.getInput('previous_tag');
    const filesInput = core.getInput('files');
    const bodyTemplate = core.getInput('body_template');
    const maxTokensInput = core.getInput('max_tokens');
    const diffLimitInput = core.getInput('diff_limit');
    const commitsLimitInput = core.getInput('commits_limit');
    const detailLevel = core.getInput('detail_level');
    const compatibility = core.getInput('compatibility');

    const files = filesInput ? filesInput.split(',').map(f => f.trim()).filter(f => f) : undefined;
    const limits = resolveLimits(detailLevel, diffLimitInput, commitsLimitInput);
    const maxTokens = maxTokensInput ? parseInt(maxTokensInput, 10) || 8000 : 8000;

    core.info(`Generating release notes for tag: ${tagName}`);
    core.info(`Using model: ${model}`);

    // Initialize Groq client
    const groqClient = new Groq({
      apiKey: groqApiKey
    });

    // Get GitHub token and octokit
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      core.setFailed('GITHUB_TOKEN is required. Make sure to set it in your workflow.');
      return;
    }
    const octokit = github.getOctokit(token);

    // Fetch tags
    core.info('Fetching tags...');
    execSync('git fetch --tags --force', { stdio: 'inherit' });

    // Get repository info
    const { owner, repo } = github.context.repo;

    // Get previous tag and its commit SHA
    const previousTagInfo = await getPreviousTag(octokit, owner, repo, tagName, previousTagInput?.trim() || undefined);
    const previousTag = previousTagInfo.tag;
    const previousCommit = previousTagInfo.commit;
    core.info(`Previous tag: ${previousTag || 'None (first release)'}`);
    if (previousCommit) {
      core.info(`Previous commit: ${previousCommit.substring(0, 7)}`);
    }

    // Get git information using commit SHAs for accurate diffing
    core.info('Collecting git information...');
    const diff = getGitDiff(previousCommit, tagName, limits.diffLimit);
    const commits = getCommitMessages(previousCommit, tagName, limits.commitsLimit);
    const changedFiles = getChangedFiles(previousCommit, tagName);

    // Get contributors and identify new ones
    core.info('Identifying new contributors...');
    const contributors = getContributors(previousCommit, tagName);
    const newContributors = Array.from(contributors.current).filter(
      contributor => !contributors.previous.has(contributor)
    );

    const metadata = getReleaseMetadata(tagName);
    const stats = {
      commitCount: commits.split('\n').filter(c => c.trim()).length,
      contributorCount: contributors.current.size,
      filesChanged: changedFiles.split('\n').filter(f => f.trim()).length
    };

    core.info(`Found ${stats.commitCount} commits`);
    core.info(`Changed files: ${stats.filesChanged}`);
    core.info(`New contributors: ${newContributors.length > 0 ? newContributors.join(', ') : 'None'}`);

    if (!commits && !diff) {
      core.warning('No commits or changes found. Creating release with default notes.');
    }

    // Generate release notes using AI
    core.info('Generating release notes with AI...');
    const releaseNameForPrompt = releaseNameInput || tagName;
    const releaseNotes = await generateReleaseNotes(
      groqClient,
      model,
      diff,
      commits,
      changedFiles,
      tagName,
      releaseNameForPrompt,
      previousTag,
      newContributors,
      metadata,
      stats,
      compatibility,
      maxTokens,
      limits,
      bodyTemplate
    );

    core.info('Generated release notes:');
    core.info(releaseNotes);

    // Derive release name when not provided: extract from first line of notes or fall back to tag
    let releaseName = releaseNameInput;
    if (!releaseName || releaseName.trim() === '') {
      const extracted = extractReleaseNameFromNotes(releaseNotes, tagName);
      releaseName = extracted || tagName;
      if (extracted) {
        core.info(`Using derived release name: ${releaseName}`);
      }
    }

    // Create GitHub release
    core.info('Creating GitHub release...');
    const release = await createRelease(
      octokit,
      tagName,
      releaseName,
      releaseNotes,
      draft,
      prerelease,
      files,
      !!(releaseNameInput && releaseNameInput.trim())
    );

    // Set outputs
    core.setOutput('release_id', release.id.toString());
    core.setOutput('release_url', release.url);
    core.setOutput('release_notes', releaseNotes);

    core.info(`Release created successfully: ${release.url}`);
  } catch (error) {
    core.setFailed(`Action failed: ${error}`);
  }
}

run();

