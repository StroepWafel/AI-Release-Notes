# Setup Guide

This guide will walk you through setting up and using the AI Release Notes Generator GitHub Action.

## Part 1: Setting Up the Action Repository

### Step 1: Create and Push Your Repository

1. **Create a new GitHub repository** (e.g., `ai-release-notes` or `your-username/ai-release-notes`)

2. **Clone and initialize locally:**
   ```bash
   git clone <your-repo-url>
   cd ai-release-notes
   ```

3. **Copy all the action files** to this repository

4. **Build the action:**
   ```bash
   npm install
   npm run package
   ```
   
   This creates the `dist/` folder with the bundled code.

5. **Commit and push:**
   ```bash
   git add .
   git commit -m "Initial commit: AI Release Notes Generator"
   git push origin main
   ```

### Step 2: Create a Release Tag

GitHub Actions need a version tag to reference. Create your first release:

1. **Create a tag:**
   ```bash
   git tag -a v1.0.0 -m "Initial release"
   git push origin v1.0.0
   ```

   Or create it via GitHub:
   - Go to your repository → **Releases** → **Create a new release**
   - Tag: `v1.0.0`
   - Release title: `v1.0.0`
   - Click **Publish release**

### Step 3: Make the Action Public (Optional)

If you want others to use your action, make the repository public. If it's private, only you can use it.

---

## Part 2: Using the Action in Your Project

### Step 1: Get a Groq API Key

1. Go to [Groq Console](https://console.groq.com/keys)
2. Sign up or log in
3. Click **Create API Key**
4. Copy your API key (you'll need it in the next step)

### Step 2: Add Groq API Key as a Secret

In the repository where you want to use the action:

1. Go to your repository → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Name: `GROQ_API_KEY`
4. Value: Paste your Groq API key
5. Click **Add secret**

### Step 3: Create a Workflow File

Create `.github/workflows/release.yml` in your project:

```yaml
name: Create Release

on:
  workflow_dispatch:
    inputs:
      release_version:
        description: 'Release version (e.g., 1.0.0)'
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
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0  # IMPORTANT: Required to fetch all tags and history

      - name: Determine release flags
        id: flags
        run: |
          if [ "${{ github.event.inputs.release_channel }}" == "stable" ]; then
            echo "draft=false" >> $GITHUB_OUTPUT
            echo "prerelease=false" >> $GITHUB_OUTPUT
          else
            echo "draft=false" >> $GITHUB_OUTPUT
            echo "prerelease=true" >> $GITHUB_OUTPUT
          fi

      # Optional: Build your application
      # - name: Build
      #   run: |
      #     echo "Building application..."
      #     # Your build commands here

      - name: Generate and Create Release
        id: release
        uses: YOUR_USERNAME/ai-release-notes@v1.0.0
        with:
          groq_api_key: ${{ secrets.GROQ_API_KEY }}
          tag_name: ${{ github.event.inputs.release_version }}-${{ github.event.inputs.release_channel }}
          release_name: "[${{ github.event.inputs.release_channel }}] v${{ github.event.inputs.release_version }}"
          draft: ${{ steps.flags.outputs.draft }}
          prerelease: ${{ steps.flags.outputs.prerelease }}
          # Optional: Attach files
          # files: dist/app.exe,dist/app.dmg
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Display Release URL
        run: |
          echo "Release created: ${{ steps.release.outputs.release_url }}"
```

**Important:** Replace `YOUR_USERNAME/ai-release-notes@v1.0.0` with:
- Your GitHub username or organization name
- Your repository name
- The version tag you created (e.g., `v1.0.0`)

### Step 4: Run the Workflow

1. Go to your repository → **Actions** tab
2. Select **Create Release** workflow
3. Click **Run workflow**
4. Fill in:
   - **Release version**: e.g., `1.0.0`
   - **Release channel**: Choose `stable`, `beta`, or `alpha`
5. Click **Run workflow**

The action will:
1. Analyze code changes since the last release
2. Generate AI-powered release notes using Groq
3. Create a GitHub release with the notes

---

## Using a Specific Branch or Commit

Instead of using a tag, you can reference a specific branch or commit:

```yaml
uses: YOUR_USERNAME/ai-release-notes@main  # Use main branch
# or
uses: YOUR_USERNAME/ai-release-notes@abc1234  # Use specific commit SHA
```

However, **using tags is recommended** for stability.

---

## Example: Simple Release Workflow

For a simpler workflow without channels:

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Version number'
        required: true

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: YOUR_USERNAME/ai-release-notes@v1.0.0
        with:
          groq_api_key: ${{ secrets.GROQ_API_KEY }}
          tag_name: v${{ github.event.inputs.version }}
          release_name: Release v${{ github.event.inputs.version }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## Troubleshooting

### "Could not find previous tag"
- This is normal for the first release
- The action will generate notes based on all commits

### "GITHUB_TOKEN is required"
- Make sure you have `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` in your workflow
- This token is automatically provided by GitHub Actions

### "Action not found"
- Check that you're using the correct format: `username/repo-name@tag`
- Make sure the tag exists in your action repository
- If the repo is private, ensure you have access

### "No commits or changes found"
- Make sure you're using `fetch-depth: 0` in checkout
- Verify there are actually commits between releases

---

## Updating the Action

When you update the action code:

1. Make your changes
2. Build: `npm run package`
3. Commit and push:
   ```bash
   git add .
   git commit -m "Update action"
   git push
   ```
4. Create a new tag:
   ```bash
   git tag -a v1.0.1 -m "Update release"
   git push origin v1.0.1
   ```
5. Update workflows to use the new version: `@v1.0.1`

