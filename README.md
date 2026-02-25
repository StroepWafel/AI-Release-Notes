# AI Release Notes Generator

A GitHub Action that automatically generates release notes using AI (powered by Groq) based on code changes since the previous release.

## Quick Start

1. **Get a Groq API key** from [console.groq.com/keys](https://console.groq.com/keys)
2. **Add `GROQ_API_KEY` as a GitHub secret** in your project repository
3. **Use the action** from [StroepWafel/AI-Release-Notes](https://github.com/StroepWafel/AI-Release-Notes/) in your workflow (see examples below)

To host your own copy of the action, see [SETUP.md](SETUP.md).

## Features

- 🤖 **AI-Powered**: Uses Groq's API to generate intelligent release notes
- 📝 **Automatic Analysis**: Analyzes git commits, diffs, and file changes
- 🎯 **Smart Categorization**: Organizes changes into Features, Improvements, Bug Fixes, Breaking Changes, etc.
- 📦 **File Attachments**: Supports attaching files to releases
- 🔄 **Auto-Update**: Updates existing releases if they already exist

## Usage

### Basic Example

Copy this workflow to `.github/workflows/` in **any** repo. Supports both modes:

**Two tags** (explicit range): provide `from_tag` + `to_tag`  
**Legacy** (auto-detect previous): provide `version` only (e.g. `1.0.0` or `v1.0.0`)

```yaml
name: Create Release Notes

on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Version (legacy; e.g., 1.0.0) - auto-detects previous'
        required: false
        type: string
      from_tag:
        description: 'Previous tag (e.g., v1.0.0) - use with to_tag'
        required: false
        type: string
      to_tag:
        description: 'Release tag (e.g., v2.0.0) - use with from_tag'
        required: false
        type: string

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Determine tags
        id: tags
        run: |
          if [ -n "${{ github.event.inputs.from_tag }}" ] && [ -n "${{ github.event.inputs.to_tag }}" ]; then
            echo "tag_name=${{ github.event.inputs.to_tag }}" >> $GITHUB_OUTPUT
            echo "previous_tag=${{ github.event.inputs.from_tag }}" >> $GITHUB_OUTPUT
          elif [ -n "${{ github.event.inputs.version }}" ]; then
            ver="${{ github.event.inputs.version }}"
            [[ "$ver" == v* ]] || ver="v$ver"
            echo "tag_name=$ver" >> $GITHUB_OUTPUT
            echo "previous_tag=" >> $GITHUB_OUTPUT
          else
            echo "Provide either (from_tag AND to_tag) OR version"
            exit 1
          fi

      - name: Generate Release Notes
        uses: StroepWafel/AI-Release-Notes@v1
        with:
          groq_api_key: ${{ secrets.GROQ_API_KEY }}
          tag_name: ${{ steps.tags.outputs.tag_name }}
          previous_tag: ${{ steps.tags.outputs.previous_tag }}
          release_name: ${{ steps.tags.outputs.tag_name }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Advanced Example (with release channel)

Same backwards compatibility: use `version` (legacy) or `from_tag`/`to_tag`:

```yaml
name: Create Release

on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Version (legacy; e.g., 1.0.0)'
        required: false
        type: string
      from_tag:
        description: 'Previous tag - use with to_tag'
        required: false
        type: string
      to_tag:
        description: 'Release tag - use with from_tag'
        required: false
        type: string
      release_channel:
        description: 'Release channel'
        required: false
        default: 'stable'
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

      - name: Determine tags
        id: tags
        run: |
          if [ -n "${{ github.event.inputs.from_tag }}" ] && [ -n "${{ github.event.inputs.to_tag }}" ]; then
            echo "tag_name=${{ github.event.inputs.to_tag }}" >> $GITHUB_OUTPUT
            echo "previous_tag=${{ github.event.inputs.from_tag }}" >> $GITHUB_OUTPUT
          elif [ -n "${{ github.event.inputs.version }}" ]; then
            ver="${{ github.event.inputs.version }}"
            [[ "$ver" == v* ]] || ver="v$ver"
            echo "tag_name=$ver" >> $GITHUB_OUTPUT
            echo "previous_tag=" >> $GITHUB_OUTPUT
          else
            echo "Provide either (from_tag AND to_tag) OR version"
            exit 1
          fi

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
        run: echo "Building..."

      - name: Generate Release Notes
        uses: StroepWafel/AI-Release-Notes@v1
        with:
          groq_api_key: ${{ secrets.GROQ_API_KEY }}
          tag_name: ${{ steps.tags.outputs.tag_name }}
          previous_tag: ${{ steps.tags.outputs.previous_tag }}
          release_name: "[${{ github.event.inputs.release_channel }}] ${{ steps.tags.outputs.tag_name }}"
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
| `model` | Groq model to use | No | `meta-llama/llama-4-maverick-17b-128e-instruct` |
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

You can use any available Groq model. Recommended options include:

- `meta-llama/llama-4-maverick-17b-128e-instruct` (default) - Latest Llama 4 model, excellent for structured writing
- `llama-3.3-70b-versatile` - Powerful 70B model, great for complex analysis
- `groq/compound` - Groq's optimized model, good balance of speed and quality
- `llama-3.1-8b-instant` - Fast and lightweight, good for quick summaries
- `qwen/qwen3-32b` - Excellent for longer outputs (40k completion tokens)

**Current Default:** `meta-llama/llama-4-maverick-17b-128e-instruct` - Latest Llama 4 model optimized for instruction following and structured output.

Check [Groq's API](https://api.groq.com/openai/v1/models) for the latest available models.

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
