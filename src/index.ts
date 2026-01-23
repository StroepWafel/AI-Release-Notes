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

async function getPreviousTag(currentTag: string, previousTag?: string): Promise<string | null> {
  try {
    if (previousTag) {
      // Verify the tag exists
      execSync(`git rev-parse --verify ${previousTag}`, { stdio: 'ignore' });
      return previousTag;
    }

    // Get all tags sorted by version
    const tags = execSync('git tag --sort=-version:refname', { encoding: 'utf-8' })
      .trim()
      .split('\n')
      .filter(tag => tag && tag !== currentTag);

    return tags.length > 0 ? tags[0] : null;
  } catch (error) {
    core.warning(`Could not find previous tag: ${error}`);
    return null;
  }
}

function getGitDiff(previousTag: string | null, currentTag: string): string {
  try {
    if (!previousTag) {
      // If no previous tag, get all changes from the initial commit
      return execSync('git diff --stat', { encoding: 'utf-8' });
    }

    // Check if current tag exists, if not use HEAD
    let currentRef = currentTag;
    try {
      execSync(`git rev-parse --verify ${currentTag}`, { stdio: 'ignore' });
    } catch {
      currentRef = 'HEAD';
    }

    // Get diff between tags
    return execSync(`git diff ${previousTag}..${currentRef} --stat`, { encoding: 'utf-8' });
  } catch (error) {
    core.warning(`Could not get git diff: ${error}`);
    return '';
  }
}

function getCommitMessages(previousTag: string | null, currentTag: string): string {
  try {
    // Check if current tag exists, if not use HEAD
    let currentRef = currentTag;
    try {
      execSync(`git rev-parse --verify ${currentTag}`, { stdio: 'ignore' });
    } catch {
      currentRef = 'HEAD';
    }

    if (!previousTag) {
      // If no previous tag, get all commits
      return execSync(`git log --pretty=format:"%h - %s (%an)"`, { encoding: 'utf-8' });
    }

    // Get commit messages between tags
    return execSync(`git log ${previousTag}..${currentRef} --pretty=format:"%h - %s (%an)"`, { encoding: 'utf-8' });
  } catch (error) {
    core.warning(`Could not get commit messages: ${error}`);
    return '';
  }
}

function getChangedFiles(previousTag: string | null, currentTag: string): string {
  try {
    // Check if current tag exists, if not use HEAD
    let currentRef = currentTag;
    try {
      execSync(`git rev-parse --verify ${currentTag}`, { stdio: 'ignore' });
    } catch {
      currentRef = 'HEAD';
    }

    if (!previousTag) {
      // If no previous tag, get all changed files
      return execSync('git diff --name-only', { encoding: 'utf-8' });
    }

    return execSync(`git diff --name-only ${previousTag}..${currentRef}`, { encoding: 'utf-8' });
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
  const prompt = `You are a technical writer creating release notes for a software project. 

Based on the following information about code changes, generate comprehensive release notes in markdown format.

**Current Release Tag:** ${tagName}
**Previous Release Tag:** ${previousTag || 'N/A (first release)'}

**Changed Files:**
\`\`\`
${changedFiles}
\`\`\`

**Git Diff Summary:**
\`\`\`
${diff}
\`\`\`

**Commit Messages:**
\`\`\`
${commits}
\`\`\`

Please generate release notes that include:
1. **Features** - New functionality added
2. **Improvements** - Enhancements to existing features
3. **Bug Fixes** - Issues that were resolved
4. **Breaking Changes** - If any (only include if there are actual breaking changes)
5. **Other** - Any other notable changes

Format the output as clean markdown. Be specific about what changed based on the commit messages and file changes. If there are no changes in a category, omit that section.

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
    const model = core.getInput('model') || 'llama-3.1-70b-versatile';
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

    // Get previous tag
    const previousTag = await getPreviousTag(tagName, previousTagInput || undefined);
    core.info(`Previous tag: ${previousTag || 'None (first release)'}`);

    // Get git information
    core.info('Collecting git information...');
    const diff = getGitDiff(previousTag, tagName);
    const commits = getCommitMessages(previousTag, tagName);
    const changedFiles = getChangedFiles(previousTag, tagName);

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

