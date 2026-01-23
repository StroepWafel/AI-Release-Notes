# AI Release Notes Generator

A GitHub Action that automatically generates release notes using AI (powered by Groq) based on code changes since the previous release.

## Quick Start

1. **Set up the action repository** (see [SETUP.md](SETUP.md) for detailed instructions)
2. **Get a Groq API key** from [console.groq.com/keys](https://console.groq.com/keys)
3. **Add `GROQ_API_KEY` as a GitHub secret** in your project repository
4. **Use the action** in your workflow (see examples below)

## Features

- 🤖 **AI-Powered**: Uses Groq's API to generate intelligent release notes
- 📝 **Automatic Analysis**: Analyzes git commits, diffs, and file changes
- 🎯 **Smart Categorization**: Organizes changes into Features, Improvements, Bug Fixes, Breaking Changes, etc.
- 📦 **File Attachments**: Supports attaching files to releases
- 🔄 **Auto-Update**: Updates existing releases if they already exist

## Usage

### Basic Example

```yaml
name: Create Release

on:
  workflow_dispatch:
    inputs:
      release_version:
        description: 'Release version'
        required: true
        type: string

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Required to fetch all tags and history

      - name: Generate Release Notes
        uses: your-username/ai-release-notes@v1
        with:
          groq_api_key: ${{ secrets.GROQ_API_KEY }}
          tag_name: v${{ github.event.inputs.release_version }}
          release_name: Release v${{ github.event.inputs.release_version }}
          draft: false
          prerelease: false
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Advanced Example

```yaml
name: Create Release

on:
  workflow_dispatch:
    inputs:
      release_version:
        description: 'Release version'
        required: true
        type: string
      release_channel:
        description: 'Release channel'
        required: true
        type: choice
        options:
          - stable
          - beta
          - alpha

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Determine if draft/prerelease
        id: flags
        run: |
          if [ "${{ github.event.inputs.release_channel }}" == "stable" ]; then
            echo "draft=false" >> $GITHUB_OUTPUT
            echo "prerelease=false" >> $GITHUB_OUTPUT
          else
            echo "draft=false" >> $GITHUB_OUTPUT
            echo "prerelease=true" >> $GITHUB_OUTPUT
          fi

      - name: Build application
        run: |
          # Your build steps here
          echo "Building..."

      - name: Generate Release Notes
        uses: your-username/ai-release-notes@v1
        with:
          groq_api_key: ${{ secrets.GROQ_API_KEY }}
          tag_name: ${{ github.event.inputs.release_version }}-${{ github.event.inputs.release_channel }}
          release_name: "[${{ github.event.inputs.release_channel }}] v${{ github.event.inputs.release_version }}"
          draft: ${{ steps.flags.outputs.draft }}
          prerelease: ${{ steps.flags.outputs.prerelease }}
          model: llama-3.1-70b-versatile
          files: dist/app.exe,dist/app.dmg
          body_template: |
            ## What's New:
            ### Features:
            - 
            ### Under The Hood:
            - 
            ## Bugs Squashed:
            - 
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `groq_api_key` | Your Groq API key | Yes | - |
| `tag_name` | Tag name for the release | Yes | - |
| `release_name` | Name of the release | No | `tag_name` |
| `draft` | Create as draft release | No | `false` |
| `prerelease` | Create as prerelease | No | `false` |
| `model` | Groq model to use | No | `llama-3.1-70b-versatile` |
| `previous_tag` | Previous tag to compare against | No | Latest tag |
| `files` | Comma-separated list of files to attach | No | - |
| `body_template` | Optional template for release notes structure | No | - |

## Outputs

| Output | Description |
|--------|-------------|
| `release_id` | The ID of the created release |
| `release_url` | The URL of the created release |
| `release_notes` | The generated release notes |

## Setup

### 1. Get a Groq API Key

1. Visit [Groq Console](https://console.groq.com/keys)
2. Sign up or log in
3. Create a new API key
4. Add it as a secret in your GitHub repository: `Settings > Secrets and variables > Actions > New repository secret`
   - Name: `GROQ_API_KEY`
   - Value: Your API key

### 2. Configure Your Workflow

Make sure to:
- Use `actions/checkout@v4` with `fetch-depth: 0` to fetch all git history
- Set `GITHUB_TOKEN` in the environment (usually `${{ secrets.GITHUB_TOKEN }}`)

## How It Works

1. **Fetches Git Information**: Gets all tags and determines the previous release tag
2. **Analyzes Changes**: Collects git diff, commit messages, and changed files
3. **Generates Notes**: Sends the information to Groq's API to generate structured release notes
4. **Creates Release**: Creates or updates the GitHub release with the generated notes
5. **Attaches Files**: Uploads any specified files to the release

## Available Groq Models

You can use any available Groq model. Popular options include:
- `llama-3.1-70b-versatile` (default)
- `llama-3.1-8b-instant`
- `mixtral-8x7b-32768`
- `gemma2-9b-it`

Check [Groq's documentation](https://console.groq.com/docs/models) for the latest available models.

## Building the Action

To build this action for distribution:

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Package for distribution (creates dist/ folder with bundled code)
npm run package
```

The `dist/` folder will contain the bundled action code that can be committed to your repository.

## Development

1. Clone the repository
2. Install dependencies: `npm install`
3. Make your changes to `src/index.ts`
4. Build: `npm run build`
5. Package: `npm run package`
6. Commit the changes including the `dist/` folder

## License

MIT
