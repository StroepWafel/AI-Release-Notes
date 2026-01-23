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

async function getPreviousTag(currentTag: string, previousTag?: string): Promise<{ tag: string | null; commit: string | null }> {
  try {
    let tagToUse: string | null = null;
    
    if (previousTag) {
      // Verify the tag exists and get its commit SHA
      try {
        execSync(`git rev-parse --verify ${previousTag}`, { stdio: 'ignore' });
        tagToUse = previousTag;
      } catch {
        core.warning(`Previous tag ${previousTag} not found`);
        return { tag: null, commit: null };
      }
    } else {
      // Get all tags sorted by version
      const tags = execSync('git tag --sort=-version:refname', { encoding: 'utf-8' })
        .trim()
        .split('\n')
        .filter(tag => tag && tag !== currentTag);

      if (tags.length > 0) {
        tagToUse = tags[0];
      }
    }

    if (!tagToUse) {
      return { tag: null, commit: null };
    }

    // Get the commit SHA that the tag points to
    const commitSha = execSync(`git rev-parse ${tagToUse}`, { encoding: 'utf-8' }).trim();
    return { tag: tagToUse, commit: commitSha };
  } catch (error) {
    core.warning(`Could not find previous tag: ${error}`);
    return { tag: null, commit: null };
  }
}

function getGitDiff(previousCommit: string | null, currentTag: string): string {
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
      // If no previous commit, get diff from root to current
      const stat = execSync(`git diff --stat ${currentCommit}`, { encoding: 'utf-8' });
      // Also get a summary of what changed
      const summary = execSync(`git log --oneline ${currentCommit} | head -20`, { encoding: 'utf-8' });
      return `Summary:\n${summary}\n\nFile changes:\n${stat}`;
    }

    // Get diff between the two commits
    // First get the stat summary
    const stat = execSync(`git diff --stat ${previousCommit}..${currentCommit}`, { encoding: 'utf-8' });
    
    // Get a brief summary of actual code changes (limited to avoid token limits)
    let codeDiff = '';
    try {
      // Get a sample of actual changes (first 50 lines of diff)
      codeDiff = execSync(`git diff ${previousCommit}..${currentCommit} | head -50`, { encoding: 'utf-8' });
    } catch {
      // If that fails, just use stat
    }
    
    return `File changes summary:\n${stat}\n\nSample code changes:\n${codeDiff || '(too large to display)'}`;
  } catch (error) {
    core.warning(`Could not get git diff: ${error}`);
    return '';
  }
}

function getCommitMessages(previousCommit: string | null, currentTag: string): string {
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
      // If no previous commit, get all commits up to current
      return execSync(`git log --pretty=format:"%h - %s (%an)" ${currentCommit}`, { encoding: 'utf-8' });
    }

    // Get commit messages between commits (exclusive of previous, inclusive of current)
    return execSync(`git log ${previousCommit}..${currentCommit} --pretty=format:"%h - %s (%an)"`, { encoding: 'utf-8' });
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

async function generateReleaseNotes(
  groqClient: Groq,
  model: string,
  diff: string,
  commits: string,
  changedFiles: string,
  tagName: string,
  previousTag: string | null,
  template?: string
): Promise<string> {
  // Truncate long outputs to avoid token limits
  const maxDiffLength = 2000;
  const maxCommitsLength = 1000;
  const truncatedDiff = diff.length > maxDiffLength ? diff.substring(0, maxDiffLength) + '\n... (truncated)' : diff;
  const truncatedCommits = commits.length > maxCommitsLength ? commits.substring(0, maxCommitsLength) + '\n... (truncated)' : commits;
  
  const prompt = `You are a technical writer creating release notes for a software project. 

IMPORTANT: Only include changes that are ACTUALLY present in the diff and commit messages below. Do not make up or infer changes that aren't explicitly shown.

**Current Release Tag:** ${tagName}
**Previous Release Tag:** ${previousTag || 'N/A (first release)'}

**Changed Files (only files that actually changed):**
\`\`\`
${changedFiles || 'No files changed'}
\`\`\`

**Git Diff Summary (showing only what changed between releases):**
\`\`\`
${truncatedDiff || 'No changes detected'}
\`\`\`

**Commit Messages (only commits between the two releases):**
\`\`\`
${truncatedCommits || 'No commits'}
\`\`\`

Based ONLY on the information above, generate release notes in markdown format. Include:
1. **Features** - Only if new functionality was actually added (based on commit messages and file changes)
2. **Improvements** - Only if existing features were enhanced
3. **Bug Fixes** - Only if bugs were explicitly fixed
4. **Breaking Changes** - Only if there are actual breaking changes (rare, usually omit)
5. **Other** - Any other notable changes

CRITICAL: 
- Only mention changes that are clearly visible in the diff and commit messages
- If a category has no changes, completely omit that section
- Do not infer or assume changes that aren't explicitly shown
- Be concise and specific
- Focus on user-visible changes when possible

${template ? `\n**Template to follow:**\n${template}\n` : ''}

Generate the release notes now:`;

  try {
    const completion = await groqClient.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You are a technical writer specializing in creating clear, concise, and informative release notes for software projects. You analyze code changes and commit messages to create well-structured release notes.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      model: model,
      temperature: 0.7,
      max_tokens: 2000
    });

    const notes = completion.choices[0]?.message?.content || 'No release notes generated.';
    return notes.trim();
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
  files?: string[]
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
      
      // Get existing release
      const releases = await octokit.rest.repos.listReleases({ owner, repo });
      const existingRelease = releases.data.find(r => r.tag_name === tagName);
      
      if (existingRelease) {
        const updated = await octokit.rest.repos.updateRelease({
          owner,
          repo,
          release_id: existingRelease.id,
          name: releaseName,
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
    const releaseName = core.getInput('release_name') || tagName;
    const draft = core.getBooleanInput('draft');
    const prerelease = core.getBooleanInput('prerelease');
    const model = core.getInput('model') || 'meta-llama/llama-4-maverick-17b-128e-instruct';
    const previousTagInput = core.getInput('previous_tag');
    const filesInput = core.getInput('files');
    const bodyTemplate = core.getInput('body_template');

    const files = filesInput ? filesInput.split(',').map(f => f.trim()).filter(f => f) : undefined;

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

    // Get previous tag and its commit SHA
    const previousTagInfo = await getPreviousTag(tagName, previousTagInput || undefined);
    const previousTag = previousTagInfo.tag;
    const previousCommit = previousTagInfo.commit;
    core.info(`Previous tag: ${previousTag || 'None (first release)'}`);
    if (previousCommit) {
      core.info(`Previous commit: ${previousCommit.substring(0, 7)}`);
    }

    // Get git information using commit SHAs for accurate diffing
    core.info('Collecting git information...');
    const diff = getGitDiff(previousCommit, tagName);
    const commits = getCommitMessages(previousCommit, tagName);
    const changedFiles = getChangedFiles(previousCommit, tagName);
    
    // Log what we found
    core.info(`Found ${commits.split('\n').filter(c => c.trim()).length} commits`);
    core.info(`Changed files: ${changedFiles.split('\n').filter(f => f.trim()).length}`);

    if (!commits && !diff) {
      core.warning('No commits or changes found. Creating release with default notes.');
    }

    // Generate release notes using AI
    core.info('Generating release notes with AI...');
    const releaseNotes = await generateReleaseNotes(
      groqClient,
      model,
      diff,
      commits,
      changedFiles,
      tagName,
      previousTag,
      bodyTemplate
    );

    core.info('Generated release notes:');
    core.info(releaseNotes);

    // Create GitHub release
    core.info('Creating GitHub release...');
    const release = await createRelease(
      octokit,
      tagName,
      releaseName,
      releaseNotes,
      draft,
      prerelease,
      files
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

