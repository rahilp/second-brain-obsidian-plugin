# Second Brain Sync — Obsidian Plugin

Sync your Obsidian notes to your self-hosted [Second Brain MCP server](https://github.com/rahilp/second-brain-cloudflare) on Cloudflare Workers. Search your brain from inside Obsidian.

---

## Features

- Sync the current note with one click or hotkey
- Sync all notes tagged with your sync tag in bulk
- Auto-sync tagged notes on save
- Search your second brain from an Obsidian sidebar panel
- Chunking for long notes — splits automatically so each part gets a clean embedding
- Status bar showing last sync time
- Test connection button to verify your setup

---

## Prerequisites

You need a running Second Brain Worker. Deploy one at:
→ https://github.com/rahilp/second-brain-cloudflare

---

## Installation

### Manual (local development)

```bash
# 1. Clone into your vault's plugins folder
cd /path/to/your/vault/.obsidian/plugins
git clone https://github.com/rahilp/second-brain-obsidian second-brain-sync
cd second-brain-sync

# 2. Install dependencies and build
npm install
npm run build

# 3. Enable in Obsidian
# Settings → Community Plugins → toggle on "Second Brain Sync"
```

### From Obsidian Community Plugins

Search for "Second Brain Sync" in Settings → Community Plugins → Browse.

[Second Brain Sync in Obsidian Community](https://community.obsidian.md/plugins/second-brain-sync)

---

## Setup

1. Open Settings → Second Brain Sync
2. Enter your **Worker URL** (e.g. `https://second-brain.yourname.workers.dev`)
3. Enter your **Auth token** (the `AUTH_TOKEN` secret you set in Cloudflare)
4. Click **Test** to verify the connection
5. Set your **Sync tag** (default: `brain`)

---

## Usage

### Syncing notes

Tag any note for sync by adding to its frontmatter:

```yaml
---
tags:
  - brain
---
```

Then either:
- Click the brain icon in the ribbon to sync the current note
- Use the command palette: "Sync current note to Second Brain"
- Use the command palette: "Sync all tagged notes to Second Brain"
- Enable auto-sync in settings to sync tagged notes on every save

### Searching

Click the search icon in the ribbon or run "Open Second Brain search" from the command palette. A sidebar panel opens with a search box that queries your Worker's semantic search.

---

## Settings reference

| Setting | Description | Default |
|---|---|---|
| Worker URL | Your Cloudflare Worker URL | — |
| Auth token | Your AUTH_TOKEN secret | — |
| Sync tag | Frontmatter tag that marks a note for sync | `brain` |
| Auto-sync on save | Sync tagged notes automatically on save | Off |
| Chunk size | Max characters per chunk (~400 tokens = 1600 chars) | 1600 |
| Chunk overlap | Overlap between chunks to preserve context | 200 |
| Show sync status | Show last sync time in status bar | On |

---

## How chunking works

Long notes are split into overlapping segments before being sent to the Worker. Each segment gets its own embedding in Vectorize so long notes don't produce diluted search results.

Short notes (under the chunk size) are stored as a single entry — no change in behavior.

The overlap ensures that sentences at chunk boundaries don't lose context.

---

## Development

```bash
npm run dev   # Watch mode — rebuilds on changes
npm run build # Production build
```

Copy `main.js` and `manifest.json` to your vault's plugin folder after building.
