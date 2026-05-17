# Second Brain Sync

Sync your Obsidian notes to your own AI memory. Search them back with semantic search — from inside Obsidian, or from any AI tool that supports MCP.

Built on [Cloudflare Workers + Vectorize](https://github.com/rahilp/second-brain-cloudflare). Your data stays on your own infrastructure.

---

## What it does

- Sync any note to your Second Brain with one click or a hotkey
- Bulk sync all notes with a specific tag
- Auto-sync tagged notes every time you save
- Chunk long notes automatically so embeddings stay clean
- Status bar shows the last time you synced

---

## Getting started

You need a running Second Brain Worker before this plugin is useful. Deploy one for free at:

→ [github.com/rahilp/second-brain-cloudflare](https://github.com/rahilp/second-brain-cloudflare)

Once your Worker is running:

1. Open **Settings → Second Brain Sync**
2. Paste your **Worker URL** (e.g. `https://second-brain.yourname.workers.dev`)
3. Paste your **Auth token** (the `AUTH_TOKEN` secret you set in Cloudflare)
4. Hit **Test** to confirm the connection works
5. Set your **Sync tag** — any note with this tag in its frontmatter will sync (default: `brain`)

---

## Syncing notes

Tag a note for sync by adding the tag to its frontmatter:

```yaml
---
tags:
  - brain
---
```

Then sync it:
- Click the brain icon in the ribbon to sync the current note
- `Ctrl/Cmd + P` → "Sync current note to Second Brain"
- `Ctrl/Cmd + P` → "Sync all tagged notes to Second Brain"
- Or turn on auto-sync in settings and forget about it

---

## Settings

| Setting | Description | Default |
|---|---|---|
| Worker URL | Your Cloudflare Worker URL | — |
| Auth token | Your AUTH_TOKEN secret | — |
| Sync mode | Sync all notes, or only tagged ones | Tagged only |
| Sync tag | The frontmatter tag that marks a note for sync | `brain` |
| Auto-sync on save | Sync automatically when you save | Off |
| Auto-sync delay | How long to wait after you stop typing | 5s |
| Chunk size | Max characters per chunk | 1600 |
| Chunk overlap | Overlap between chunks to preserve context | 200 |
| Show sync status | Show last sync time in the status bar | On |

---

## How chunking works

Notes under the chunk size get stored as a single entry. Longer notes get split into overlapping segments — each one gets its own embedding in Vectorize, so long notes don't produce diluted search results. The overlap keeps sentences at chunk boundaries from losing context.

---

## Support

If this is useful to you, you can buy me a coffee:

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?style=flat&logo=buy-me-a-coffee)](https://www.buymeacoffee.com/rahilp)

---

## Development

```bash
npm run dev     # watch mode
npm run build   # production build
```

The plugin source is at [github.com/rahilp/second-brain-obsidian-plugin](https://github.com/rahilp/second-brain-obsidian-plugin).
