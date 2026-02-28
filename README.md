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
| `model` | Groq model to use | No | `openai/gpt-oss-120b` |
| `previous_tag` | Previous tag to compare against | No | Latest tag |
| `files` | Comma-separated list of files to attach | No | - |
| `body_template` | Optional template for release notes structure | No | - |
| `max_tokens` | Max AI completion tokens (prevents truncation) | No | `8000` |
| `diff_limit` | Max diff lines sent to AI (higher = more depth; keep low for Groq free tier) | No | `120` |
| `commits_limit` | Max commit messages sent to AI | No | `60` |
| `detail_level` | Shortcut: `brief`, `standard`, or `detailed` | No | `standard` |
| `compatibility` | e.g. "Node 18+, Python 3.10+" for Compatibility field | No | - |
| `show_diff_section` | Append diff section at bottom of release notes | No | `false` |
| `diff_section_limit` | Max lines of inline diff in release body | No | `500` |
| `summarizer_model` | Model for per-file summarization in two-stage mode (empty = use `model`) | No | - |
| `two_stage_char_limit` | Use two-stage summarization when diff is under this size (chars). Set `0` to disable | No | `40000` |

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

See [HOW_IT_WORKS.md](HOW_IT_WORKS.md) for an in-depth flow diagram and step-by-step breakdown.

## Available Groq Models

You can use any available Groq model. Recommended options include:

- `openai/gpt-oss-120b` (default) - OpenAI's flagship open MoE model, excellent for structured writing
- `llama-3.3-70b-versatile` - Powerful 70B model, great for complex analysis
- `groq/compound` - Groq's optimized model, good balance of speed and quality
- `llama-3.1-8b-instant` - Fast and lightweight, good for quick summaries
- `qwen/qwen3-32b` - Excellent for longer outputs (40k completion tokens)

**Current Default:** `openai/gpt-oss-120b` - OpenAI's flagship open-weight MoE model (120B params) with strong benchmark performance for instruction following and structured output.

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
