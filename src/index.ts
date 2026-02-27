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

/**
 * Get raw unified diff string between two commits (for parsing, two-stage, etc.).
 * Returns empty string if previousCommit is null or on error.
 */
function getRawDiff(previousCommit: string | null, currentCommit: string): string {
  if (!previousCommit) return '';
  try {
    return execSync(`git diff ${previousCommit}..${currentCommit}`, {
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Get raw git diff between commits for display (no stat/formatting).
 * Optionally truncated by line count.
 */
function getFullDiff(
  previousCommit: string | null,
  currentTag: string,
  lineLimit?: number
): { diff: string; wasTruncated: boolean } {
  try {
    let currentCommit: string;
    try {
      currentCommit = execSync(`git rev-parse ${currentTag}`, { encoding: 'utf-8' }).trim();
    } catch {
      currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    }

    if (!previousCommit) {
      const summary = execSync(`git log --oneline ${currentCommit}`, { encoding: 'utf-8' });
      const stat = execSync(`git diff --stat ${currentCommit}`, { encoding: 'utf-8' });
      const content = `Summary:\n${summary}\n\nFile changes:\n${stat}`;
      return { diff: content, wasTruncated: false };
    }

    let fullDiff: string;
    try {
      fullDiff = execSync(`git diff ${previousCommit}..${currentCommit}`, {
        encoding: 'utf-8',
        maxBuffer: 2 * 1024 * 1024
      });
    } catch {
      return { diff: '(diff too large or unavailable)', wasTruncated: false };
    }

    if (!lineLimit || lineLimit <= 0) {
      return { diff: fullDiff.trim(), wasTruncated: false };
    }

    const lines = fullDiff.trim().split('\n');
    const wasTruncated = lines.length > lineLimit;
    const truncated = lines.slice(0, lineLimit).join('\n');
    return { diff: truncated + (wasTruncated ? '\n... (truncated)' : ''), wasTruncated };
  } catch (error) {
    core.warning(`Could not get full diff: ${error}`);
    return { diff: '', wasTruncated: false };
  }
}

/**
 * Append the diff comparison section to the release body.
 * Includes GitHub compare link and inline diff when show_diff_section is true.
 */
function appendDiffSection(
  body: string,
  previousTag: string | null,
  currentTag: string,
  previousCommit: string | null,
  diffSectionLimit: number,
  owner: string,
  repo: string
): string {
  const { diff, wasTruncated } = getFullDiff(previousCommit, currentTag, diffSectionLimit);
  if (!diff) return body;

  const compareUrl =
    previousTag && previousCommit
      ? `https://github.com/${owner}/${repo}/compare/${previousTag}...${currentTag}`
      : null;

  const lines: string[] = ['', '', '## Changes (diff)', ''];
  if (compareUrl) {
    lines.push(`[View full diff on GitHub](${compareUrl})`, '');
  }
  lines.push('```diff', diff, '```');

  return body + lines.join('\n');
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

/**
 * Parse a unified diff into per-file chunks.
 * Splits by "diff --git a/path b/path" lines.
 */
function parsePerFileDiffs(fullDiff: string): { path: string; diff: string }[] {
  const chunks: { path: string; diff: string }[] = [];
  const regex = /^diff --git a\/(.+?) b\/\1$/m;
  const parts = fullDiff.split(/\n(?=diff --git )/);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const match = trimmed.match(regex);
    if (match) {
      const path = match[1];
      // The diff content is everything after the first line (the diff --git line)
      const rest = trimmed.split('\n').slice(1).join('\n').trim();
      chunks.push({ path, diff: rest || '(no changes)' });
    }
  }
  return chunks;
}

const PER_FILE_DIFF_CAP = 8000; // chars per file to avoid huge single-file context

/**
 * Summarize code changes in a single file using AI.
 */
async function summarizeFileChanges(
  groqClient: Groq,
  model: string,
  filePath: string,
  fileDiff: string
): Promise<string> {
  const capped = fileDiff.length > PER_FILE_DIFF_CAP
    ? fileDiff.substring(0, PER_FILE_DIFF_CAP) + '\n... (truncated)'
    : fileDiff;

  const prompt = `Summarize the code changes in this file in 2-4 concise bullet points.
Focus on user-visible behavior, new logic, or notable edits. Be specific.

File: ${filePath}

Diff:
\`\`\`
${capped}
\`\`\`

Output only the bullet points, one per line, starting with "-". No other text.`;

  try {
    const completion = await groqClient.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model,
      temperature: 0.3,
      max_tokens: 256
    });
    const text = completion.choices[0]?.message?.content?.trim() || '- No significant changes detected';
    return text;
  } catch (error) {
    core.warning(`Failed to summarize ${filePath}: ${error}`);
    return `- (Summarization failed: ${error})`;
  }
}

/**
 * Run summarizer for all files with limited concurrency (3 at a time).
 */
async function summarizeAllFiles(
  groqClient: Groq,
  model: string,
  fileDiffs: { path: string; diff: string }[]
): Promise<string> {
  const CONCURRENCY = 3;
  const results: string[] = [];

  for (let i = 0; i < fileDiffs.length; i += CONCURRENCY) {
    const batch = fileDiffs.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(({ path, diff }) => summarizeFileChanges(groqClient, model, path, diff))
    );
    results.push(...batchResults);
  }

  return fileDiffs
    .map((fd, i) => `**${fd.path}**:\n${results[i] || ''}`)
    .join('\n\n');
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
  template?: string,
  perFileSummaries?: string | null
): Promise<{ notes: string; suggestedReleaseTitle: string | null }> {
  // Conservative char limits to stay under Groq input token limits (~6k for on_demand tier)
  const maxDiffLength = limits.diffLimit * 35;
  const maxCommitsLength = limits.commitsLimit * 25;
  const truncatedDiff = diff.length > maxDiffLength ? diff.substring(0, maxDiffLength) + '\n... (truncated)' : diff;
  const truncatedCommits = commits.length > maxCommitsLength ? commits.substring(0, maxCommitsLength) + '\n... (truncated)' : commits;

  // When per-file summaries exist, use them as primary source and omit or reduce raw diff
  const hasSummaries = !!perFileSummaries && perFileSummaries.trim().length > 0;
  const diffBlock = hasSummaries
    ? `**Per-file change summaries (use these as the primary source for what changed):**
\`\`\`
${perFileSummaries}
\`\`\`

**Git Diff (reference only, summaries above are authoritative):**
\`\`\`
${truncatedDiff.substring(0, Math.min(truncatedDiff.length, 2000))}${truncatedDiff.length > 2000 ? '\n... (truncated)' : ''}
\`\`\``
    : `**Git Diff (what changed between releases):**
\`\`\`
${truncatedDiff || 'No changes detected'}
\`\`\``;

  const metadataBlock = `Available metadata to use: Release Date ${metadata.releaseDate}, Build ${metadata.commitHash}, Commits ${stats.commitCount}, Contributors ${stats.contributorCount}, Files changed ${stats.filesChanged}${compatibility ? `, Compatibility ${compatibility}` : ''}${newContributors.length > 0 ? `, New contributors: ${newContributors.join(', ')}` : ''}.`;

  const formatInstructions = template
    ? `\n**The FIRST line of your output MUST be: Release Title: [short descriptive phrase, e.g. "add multiple languages"]. Then a blank line. Then follow this template (output raw markdown, no \`\`\` code blocks):**\n${template}\n${metadataBlock}\n`
    : `

**Output format:** The FIRST line of your output MUST be exactly: Release Title: [short descriptive phrase summarizing the main changes, e.g. "add multiple languages" or "performance improvements and bug fixes"]. Keep it concise, lowercase. Then a blank line. Then ## Overview (we add the header with Release Date/Build automatically). Output raw markdown only - do NOT wrap in \`\`\` code blocks. Include these sections as applicable:

## Overview
Short executive summary. Use emojis where appropriate. This release focuses on: [bullet points]

## What's New
[Feature Name] with brief explanation, key capabilities, limitations if any.

## Improvements
### Performance Improvements
### UX / Quality Improvements

## Fixes
## Breaking Changes (only if applicable)
## Dependency Updates (if any)
## Internal Changes (optional)
## Stats
End with: Commits: X | Contributors: Y | Files changed: Z (use the actual counts from the data above).${newContributors.length > 0 ? ` Include: New contributors: [list names from data above].` : ''}`;

  const prompt = `You are a technical writer creating in-depth release notes for a software project.

CRITICAL: Only list changes that are explicitly present in the diffs, per-file summaries (if provided), and commit messages below. Do not invent, assume, or infer changes not directly shown. Every change must be directly relevant to the released program. When per-file summaries are provided, use them as the primary source for what changed.
Do not mention documentation, README, CI, or workflow updates unless they materially affect the release contents or behavior.

**Current Release Tag:** ${tagName}
**Previous Release Tag:** ${previousTag || 'N/A (first release)'}

**Changed Files:**
\`\`\`
${changedFiles || 'No files changed'}
\`\`\`

${diffBlock}

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

    let notes = completion.choices[0]?.message?.content || 'No release notes generated.';
    notes = notes.trim();
    // Strip surrounding markdown code fences if model wrapped output
    const fenceMatch = notes.match(/^```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```\s*$/);
    if (fenceMatch) {
      notes = fenceMatch[1].trim();
    }
    // Parse AI-generated release title from first line: "Release Title: add multiple languages"
    let suggestedReleaseTitle: string | null = null;
    const titleMatch = notes.match(/^Release Title:\s*(.+?)(?:\n|$)/im);
    if (titleMatch) {
      suggestedReleaseTitle = titleMatch[1].trim();
      notes = notes.replace(/^Release Title:\s*.+?\n?\n?/im, '');
    }
    // Prepend header with actual metadata; use AI-generated title when available
    const displayName = suggestedReleaseTitle ? `${tagName} - ${suggestedReleaseTitle}` : releaseName;
    const headerLines = [
      `${tagName} — ${displayName}`,
      '',
      `Release Date: ${metadata.releaseDate}`,
      `Build: ${metadata.commitHash}`,
      ...(compatibility ? [`Compatibility: ${compatibility}`] : []),
      '',
      ''
    ];
    const header = headerLines.join('\n');
    // Strip any header AI may have generated (lines before ## Overview)
    const overviewIndex = notes.search(/^## Overview/m);
    const body = overviewIndex >= 0 ? notes.substring(overviewIndex) : notes;
    return { notes: header + body, suggestedReleaseTitle };
  } catch (error) {
    core.setFailed(`Failed to generate release notes: ${error}`);
    throw error;
  }
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
    const showDiffSectionInput = core.getInput('show_diff_section');
    const showDiffSection = showDiffSectionInput === '' || showDiffSectionInput.toLowerCase() === 'true';
    const diffSectionLimitInput = core.getInput('diff_section_limit');
    const summarizerModelInput = core.getInput('summarizer_model');
    const twoStageCharLimitInput = core.getInput('two_stage_char_limit');

    const diffSectionLimit = diffSectionLimitInput ? parseInt(diffSectionLimitInput, 10) || 500 : 500;
    const twoStageCharLimit = twoStageCharLimitInput ? parseInt(twoStageCharLimitInput, 10) : 40000;
    const summarizerModel = summarizerModelInput?.trim() || model;

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

    // Resolve current commit for raw diff / two-stage
    let currentCommit: string;
    try {
      currentCommit = execSync(`git rev-parse ${tagName}`, { encoding: 'utf-8' }).trim();
    } catch {
      currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    }

    // Get git information using commit SHAs for accurate diffing
    core.info('Collecting git information...');
    const diff = getGitDiff(previousCommit, tagName, limits.diffLimit);
    const commits = getCommitMessages(previousCommit, tagName, limits.commitsLimit);
    const changedFiles = getChangedFiles(previousCommit, tagName);

    // Two-stage summarization: when diff is under threshold, summarize per-file first
    let perFileSummaries: string | null = null;
    if (previousCommit && twoStageCharLimit > 0) {
      const rawDiff = getRawDiff(previousCommit, currentCommit);
      if (rawDiff && rawDiff.length <= twoStageCharLimit) {
        const fileDiffs = parsePerFileDiffs(rawDiff);
        if (fileDiffs.length > 0) {
          core.info(`Using two-stage summarization (${fileDiffs.length} files, ${rawDiff.length} chars)`);
          perFileSummaries = await summarizeAllFiles(groqClient, summarizerModel, fileDiffs);
        }
      }
    }

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
    const { notes: releaseNotes, suggestedReleaseTitle } = await generateReleaseNotes(
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
      bodyTemplate,
      perFileSummaries
    );

    core.info('Generated release notes:');
    core.info(releaseNotes);

    // Use AI-generated title when release_name not provided: "v1.10.3 - add multiple languages"
    let releaseName = releaseNameInput;
    if (!releaseName || releaseName.trim() === '') {
      if (suggestedReleaseTitle) {
        releaseName = `${tagName} - ${suggestedReleaseTitle}`;
        core.info(`Using AI-generated release name: ${releaseName}`);
      } else {
        releaseName = tagName;
      }
    }

    // Append diff section at bottom when enabled
    let finalBody = releaseNotes;
    if (showDiffSection) {
      finalBody = appendDiffSection(
        releaseNotes,
        previousTag,
        tagName,
        previousCommit,
        diffSectionLimit,
        owner,
        repo
      );
    }

    // Create GitHub release
    core.info('Creating GitHub release...');
    const release = await createRelease(
      octokit,
      tagName,
      releaseName,
      finalBody,
      draft,
      prerelease,
      files,
      !!(releaseNameInput && releaseNameInput.trim())
    );

    // Set outputs
    core.setOutput('release_id', release.id.toString());
    core.setOutput('release_url', release.url);
    core.setOutput('release_notes', finalBody);

    core.info(`Release created successfully: ${release.url}`);
  } catch (error) {
    core.setFailed(`Action failed: ${error}`);
  }
}

run();

