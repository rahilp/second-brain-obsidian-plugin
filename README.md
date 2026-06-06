# Second Brain Sync

Sync your Obsidian notes to your own AI memory. Pull memories back into your vault as notes. Search everything with semantic search — from inside Obsidian, or from any AI tool that supports MCP.

Built on [Cloudflare Workers + Vectorize](https://github.com/rahilp/second-brain-cloudflare). Your data stays on your own infrastructure.

---

## What it does

- Sync any note to your Second Brain with one click or a hotkey
- Bulk sync all notes with a specific tag
- Auto-sync tagged notes every time you save
- **Import memories from your Second Brain back into Obsidian as notes**
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

You can also use inline tags anywhere in the note body:

```
#brain
```

Then sync it:
- Click the brain icon in the ribbon to sync the current note
- `Ctrl/Cmd + P` → "Sync current note"
- `Ctrl/Cmd + P` → "Sync all tagged notes"
- Or turn on auto-sync in settings and forget about it

---

## Importing memories into Obsidian

You can pull memories from your Second Brain back into Obsidian as Markdown notes. This is useful for surfacing things Claude, ChatGPT, or other AI tools have remembered on your behalf.

**How to set it up:**

1. In your Second Brain, tag the memories you want to import. You choose the tag — for example `obsidian-inbox`, or any existing tag you already use.
2. In **Settings → Import behavior**, set the **Import tag** to match that tag exactly.
3. Run `Ctrl/Cmd + P` → "Import memories" to pull them in.

Each imported memory becomes a Markdown note in your configured import folder (default: `_Second Brain/Inbox`) with frontmatter metadata:

```yaml
---
external_memory_id: "abc123..."
external_memory_source: "claude"
external_memory_created_at: "1748000000000"
imported_at: "2026-06-06T12:00:00.000Z"
tags:
  - obsidian-inbox
---
```

Already-imported memories are skipped automatically on subsequent runs. You can reset the cache in settings if you need to re-import.

---

## Settings

### Connection
| Setting | Description | Default |
|---|---|---|
| Worker URL | Your Cloudflare Worker URL | — |
| Auth token | Your AUTH_TOKEN secret | — |

### Sync behaviour
| Setting | Description | Default |
|---|---|---|
| Sync mode | Sync all notes, or only tagged ones | Tagged only |
| Sync tag | The tag that marks a note for sync (frontmatter or inline) | `brain` |
| Auto-sync on save | Sync automatically when you save | Off |
| Auto-sync delay | How long to wait after you stop typing | 5s |

### Chunking
| Setting | Description | Default |
|---|---|---|
| Chunk size | Max characters per chunk | 1600 |
| Chunk overlap | Overlap between chunks to preserve context | 200 |

### Import behavior
| Setting | Description | Default |
|---|---|---|
| Import folder | Where imported memories are saved in your vault | `_Second Brain/Inbox` |
| Import tag | Tag used to filter which memories to import — must match a tag on your memories | `obsidian-inbox` |
| Import limit | Max memories to fetch per import run | 20 |
| Pull on startup | Automatically import when Obsidian opens | Off |
| Reset imported IDs cache | Clear the list of already-imported memories | — |

### Display
| Setting | Description | Default |
|---|---|---|
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
