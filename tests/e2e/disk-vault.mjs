import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { parseMarkdownFile, serializeMarkdownFile } from "./yaml-frontmatter.mjs";

// main.ts gates five code paths on `file instanceof TFile`. The vault must hand out
// real TFile instances or those branches are unreachable and silently untested.
const { TFile } = createRequire(import.meta.url)("./obsidian-harness.cjs");

export class DiskTFile extends TFile {
  /** @param {string} vaultRoot @param {string} path */
  constructor(vaultRoot, path) {
    super(path.replace(/\\/g, "/"));
    this.vaultRoot = vaultRoot;
    this.path = path.replace(/\\/g, "/");
    this.name = this.path.split("/").pop() ?? this.path;
    const dot = this.name.lastIndexOf(".");
    this.extension = dot >= 0 ? this.name.slice(dot + 1) : "";
    this.basename = dot >= 0 ? this.name.slice(0, dot) : this.name;
    const parts = this.path.split("/");
    this.parent = parts.length > 1 ? { name: parts.at(-2) ?? "" } : null;
  }

  get absPath() {
    return join(this.vaultRoot, this.path);
  }
}

export async function createDiskVault() {
  const root = await mkdtemp(join(tmpdir(), "sb-e2e-vault-"));
  /** @type {Map<string, { tags: { tag: string }[], inlineTags: string[] }>} */
  const cache = new Map();

  async function ensureDir(filePath) {
    await mkdir(dirname(filePath), { recursive: true });
  }

  /** @param {string} relPath @param {Record<string, unknown>} [frontmatter] @param {string} body */
  async function writeNote(relPath, body, frontmatter = {}, inlineTags = []) {
    const abs = join(root, relPath);
    await ensureDir(abs);
    const content = serializeMarkdownFile(frontmatter, body);
    await writeFile(abs, content, "utf8");
    cache.set(relPath, {
      tags: inlineTags.map((tag) => ({ tag: tag.startsWith("#") ? tag : `#${tag}` })),
      inlineTags,
    });
    return new DiskTFile(root, relPath);
  }

  async function readNoteRaw(relPath) {
    return readFile(join(root, relPath), "utf8");
  }

  function refreshCache(relPath) {
    return readNoteRaw(relPath).then((raw) => {
      const parsed = parseMarkdownFile(raw);
      const meta = cache.get(relPath) ?? { tags: [], inlineTags: [] };
      cache.set(relPath, { ...meta, frontmatter: parsed.frontmatter });
      return parsed;
    });
  }

  function makeApp(activeFile = null) {
    /** @type {DiskTFile | null} */
    let active = activeFile;
    const files = new Map();

    // Real vault event plumbing. Obsidian fires "modify" whenever a file changes on
    // disk INCLUDING the plugin's own frontmatter writes — that is precisely why
    // main.ts keeps a self-write guard. A no-op on() made that guard untestable.
    const listeners = new Map();
    const inflight = new Set();
    function on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
      return { unload() { listeners.get(name)?.delete(handler); } };
    }
    function emit(name, ...args) {
      for (const handler of [...(listeners.get(name) ?? [])]) {
        const task = Promise.resolve().then(() => handler(...args));
        inflight.add(task);
        task.catch(() => {}).finally(() => inflight.delete(task));
      }
    }
    async function settle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    }

    /** @type {ReturnType<typeof makeApp>} */
    const app = {
      vault: {
        root,
        async read(file) {
          return readFile(file.absPath, "utf8");
        },
        getMarkdownFiles() {
          return [...files.values()];
        },
        getAbstractFileByPath(path) {
          return files.get(path) ?? null;
        },
        on,
        _emit: emit,
        _settle: settle,
        _listenerCount(name) { return listeners.get(name)?.size ?? 0; },
        async createFolder() {},
        async create() {},
        registerFile(file) {
          files.set(file.path, file);
        },
      },
      metadataCache: {
        /** @type {Map<string, Record<string, unknown>>} */
        _fm: new Map(),
        getFileCache(file) {
          const fm = this._fm.get(file.path);
          const meta = cache.get(file.path) ?? { tags: [], inlineTags: [] };
          return {
            frontmatter: fm ?? {},
            tags: meta.tags,
          };
        },
        async reloadFromDisk(file) {
          const raw = await readNoteRaw(file.path);
          const { frontmatter } = parseMarkdownFile(raw);
          this._fm.set(file.path, frontmatter);
          return frontmatter;
        },
      },
      fileManager: {
        async processFrontMatter(file, callback) {
          const raw = await readFile(file.absPath, "utf8");
          const { frontmatter, body } = parseMarkdownFile(raw);
          const clone = structuredClone(frontmatter);
          callback(clone);
          const next = serializeMarkdownFile(clone, body);
          await writeFile(file.absPath, next, "utf8");
          app.metadataCache._fm.set(file.path, clone);
          // A real write fires "modify"; the plugin must recognise it as its own.
          emit("modify", file);
        },
      },
      workspace: {
        _lastModal: null,
        getActiveFile() { return active; },
        setActiveFile(file) { active = file; },
        onLayoutReady(cb) { cb(); },
        on() { return { unload() {} }; },
        getLeavesOfType() { return []; },
        getRightLeaf() { return null; },
      },
    };
    return app;
  }

  async function destroy() {
    await rm(root, { recursive: true, force: true });
  }

  return {
    root,
    writeNote,
    readNoteRaw,
    refreshCache,
    makeApp,
    destroy,
  };
}
