import Module from "node:module";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mainPath = resolve(root, "main.js");
const obsidianHarnessPath = resolve(root, "tests/e2e/obsidian-harness.cjs");

let pluginLoaded = false;
/** @type {typeof import("../../main.js").default | null} */
let SecondBrainPlugin = null;

export function ensureBuilt() {
  execSync("npm run build", { cwd: root, stdio: "pipe" });
}

export function loadBuiltPlugin() {
  if (pluginLoaded && SecondBrainPlugin) return SecondBrainPlugin;

  ensureBuilt();

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return createRequire(obsidianHarnessPath)(obsidianHarnessPath);
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const req = createRequire(import.meta.url);
    const mod = req(mainPath);
    SecondBrainPlugin = mod.default ?? mod;
    pluginLoaded = true;
    return SecondBrainPlugin;
  } finally {
    Module._load = originalLoad;
  }
}

export const DEFAULT_SETTINGS = {
  workerUrl: "",
  authToken: "e2e-test-token",
  syncMode: "all",
  syncTag: "brain",
  autoSync: false,
  autoSyncDelay: 5000,
  chunkSize: 1600,
  chunkOverlap: 200,
  showSyncStatus: false,
  lastSyncTime: null,
  importFolder: "_Second Brain/Inbox",
  importTag: "obsidian-inbox",
  importLimit: 20,
  pullOnStartup: false,
  importedIds: [],
  defaultDestination: { workspace: "personal" },
};

export function installBrowserGlobals() {
  // Timers must be genuinely DEFERRED, not fired inline. main.ts guards against reacting
  // to its own frontmatter writes by marking a path, then clearing that mark on a 2500ms
  // timer (processFrontMatterGuarded). A stub that invokes the callback synchronously
  // clears the guard before processFrontMatter even runs, making the sync-loop protection
  // inert and untestable. Real timers keep that window open exactly as Obsidian does.
  // They are unref'd so a pending 2500ms guard never holds the test process open.
  const pending = new Set();
  globalThis.window = {
    setTimeout(callback, ms = 0) {
      const handle = setTimeout(() => {
        pending.delete(handle);
        callback();
      }, ms);
      if (typeof handle.unref === "function") handle.unref();
      pending.add(handle);
      return handle;
    },
    clearTimeout(handle) {
      if (!handle) return;
      clearTimeout(handle);
      pending.delete(handle);
    },
  };
  globalThis.__obsidianTestPendingTimers = pending;
  globalThis.document = {
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        addEventListener() {},
        remove() {},
        setAttribute() {},
        classList: { add() {}, remove() {} },
        appendChild() {},
        querySelector() { return null; },
      };
    },
    querySelector() { return null; },
  };
  globalThis.__obsidianTestNotices = [];
}
