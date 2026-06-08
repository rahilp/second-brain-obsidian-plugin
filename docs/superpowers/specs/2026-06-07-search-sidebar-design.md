# Second Brain Search Sidebar — Design

**Goal:** Replace the existing modal-based memory search (`SearchModal`) with a persistent sidebar view (`ItemView`) opened via a ribbon icon, and let users view a memory's full content (not just a truncated snippet) inline.

**Background:** The current implementation (issue #2) opens a `Modal` via the `search-memories` command. Results show a 220-char truncated `snippet` (`buildSnippet()`), and there is no way to see the full memory content — the API (`/recall`) actually returns full, untruncated content from D1; the truncation is purely a plugin-side display choice. Users want a more persistent, native-feeling search experience and a way to see full content.

---

## Architecture

Replace `SearchModal` with `SearchView extends ItemView`, registered as a custom view type and opened either via a new ribbon icon or the repurposed `search-memories` command. The view reuses all existing data-layer code (`recallMemories`, `buildSnippet`, `generateMemoryTitle`, `parseMemoryTags`, `NormalizedRecallResult`) — only the rendering/interaction layer changes from one-shot modal markup to persistent panel markup. Per-result expand/collapse state is added so the full content (already present in `NormalizedRecallResult`, stored alongside the snippet) can be revealed instantly with no extra API call.

## Components

### 1. View registration & lifecycle
- New constant `VIEW_TYPE_SEARCH = "second-brain-search"`.
- `onload()`:
  - `this.registerView(VIEW_TYPE_SEARCH, (leaf) => new SearchView(leaf, this))`
  - `this.addRibbonIcon("search", "Search Second Brain memories", () => this.activateSearchView())`
- New plugin method `activateSearchView()`:
  - If a leaf of `VIEW_TYPE_SEARCH` already exists, reveal/focus it (`workspace.revealLeaf`).
  - Otherwise create one via `workspace.getRightLeaf(false)`, set its view state to `VIEW_TYPE_SEARCH`, and reveal it.
- The `search-memories` command's callback changes from `new SearchModal(this.app, this).open()` to `this.activateSearchView()`.
- `onunload()` adds `this.app.workspace.detachLeavesOfType(VIEW_TYPE_SEARCH)`.

### 2. `NormalizedRecallResult` — add `content`
- Add a `content: string` field holding the full, untruncated memory text (already available as `item.content` when `recallMemories` builds each normalized result — just needs to also be stored, alongside the existing `snippet`).

### 3. `SearchView` structure & state
`SearchView extends ItemView`:
- `getViewType()` → `VIEW_TYPE_SEARCH`
- `getDisplayText()` → `"Second Brain search"`
- `getIcon()` → `"search"`
- Instance state: `query: string`, `results: NormalizedRecallResult[]`, `insight: string | null`, `expandedIds: Set<string>`, `isLoading: boolean`, `errorMessage: string | null`
- `onOpen()` builds the static shell once (query input, search button, results container); subsequent searches re-render only the results container (preserves scroll position, avoids rebuilding the input).
- `onClose()` performs any cleanup (e.g. clearing in-flight request guards).

### 4. Interaction flow
- User types a query and presses Enter or clicks "Search" → calls `this.plugin.recallMemories(query)`.
- While in flight: disable the search button, show a "Searching…" indicator. Guard against overlapping requests — if the user re-searches before a prior request resolves, the stale response is ignored (e.g. via a request-token counter checked on resolution).
- On success with results: render the `insight` callout (if present) above the list, then each result row (title, score badge, tags, truncated `snippet` by default).
- Clicking a result row toggles its id in/out of `expandedIds` and re-renders that row: expanded rows show the full `content` (whitespace-flattened, no truncation) in place of the snippet, with a visual affordance (e.g. chevron rotation / "Show less") indicating expanded state.
- Re-running a search clears `expandedIds` (fresh results start collapsed).

### 5. Error & empty states
Reuses the existing discriminated-union pattern from `recallMemories`:
- `{ ok: false, error }` → inline error message in the results area (e.g. missing Worker URL/auth token, empty query, 400/401/network failure messages — same copy as today).
- `{ ok: true, results: [] }` → "No memories found for that search." message.
- `insight` present → rendered as a callout above the results list.

### 6. Removing the modal
- Delete `SearchModal` entirely.
- Remove `Modal` from the `obsidian` import (verified unused elsewhere in `main.ts`).
- Add `ItemView` and `WorkspaceLeaf` to the `obsidian` import.

## Testing
- Manual testing in Obsidian (per project convention — this plugin has no automated test suite): verify ribbon icon opens/focuses the view, command palette entry opens/focuses the view, search returns and displays results with insight, expand/collapse works and shows full untruncated content, error states render correctly (bad config, empty query, API failure), empty-results state renders, and `onunload` cleanly detaches the view (no leftover leaves after disabling the plugin).

## Out of Scope
- Live/debounced search-as-you-type (explicitly rejected — semantic search + LLM insight generation is too costly per-keystroke).
- User-configurable sidebar side (right sidebar is the fixed default).
- Separate detail pane or opening memories as notes/leaves (inline expand was chosen for simplicity and space efficiency).
