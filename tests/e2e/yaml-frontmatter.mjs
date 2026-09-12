import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** @returns {{ frontmatter: Record<string, unknown>, body: string, raw: string }} */
export function parseMarkdownFile(raw) {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: raw, raw };
  }
  const frontmatter = yaml.load(match[1]);
  if (frontmatter !== null && typeof frontmatter !== "object") {
    throw new Error("Frontmatter is not a mapping");
  }
  return {
    frontmatter: frontmatter ?? {},
    body: match[2],
    raw,
  };
}

/** Serialize note with YAML frontmatter block. */
export function serializeMarkdownFile(frontmatter, body) {
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) {
    return body.startsWith("\n") ? body : `${body}`;
  }
  const fm = yaml.dump(frontmatter, {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  }).trimEnd();
  const normalizedBody = body.length === 0 ? "" : body.startsWith("\n") ? body : `\n${body}`;
  return `---\n${fm}\n---${normalizedBody}`;
}

/** Assert YAML frontmatter block parses cleanly. */
export function assertValidYamlFrontmatter(raw, label = "note") {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: {}, body: raw };
  let parsed;
  try {
    parsed = yaml.load(match[1]);
  } catch (error) {
    throw new Error(`${label}: invalid YAML frontmatter — ${error.message}\n---\n${match[1]}\n---`);
  }
  if (parsed !== null && typeof parsed !== "object") {
    throw new Error(`${label}: frontmatter must be a mapping, got ${typeof parsed}`);
  }
  return { frontmatter: parsed ?? {}, body: match[2] ?? "" };
}
