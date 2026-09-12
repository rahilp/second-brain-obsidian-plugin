import http from "node:http";
import { once } from "node:events";

/**
 * @typedef {object} RecordedRequest
 * @property {string} method
 * @property {string} path
 * @property {Record<string, string | string[] | undefined>} headers
 * @property {unknown} body
 * @property {number} at
 */

/**
 * @typedef {object} RouteBehavior
 * @property {number} [status]
 * @property {unknown} [json]
 * @property {string} [rawBody]
 * @property {number} [delayMs]
 * @property {boolean} [hang]
 * @property {() => { status?: number, json?: unknown, rawBody?: string }} [handler]
 */

export async function createWorkerServer(initial = {}) {
  /** @type {RecordedRequest[]} */
  const requests = [];
  /** @type {{ id: string, name: string }[]} */
  let teams = initial.teams ?? [
    { id: "team-a", name: "Alpha Team" },
    { id: "team-b", name: "Beta Team" },
  ];
  /** @type {((callIndex: number) => typeof teams) | null} */
  let teamsProvider = initial.teamsProvider ?? null;
  let teamsCallIndex = 0;

  /** @type {Map<string, RouteBehavior>} */
  const routes = new Map([
    ["GET /team/workspaces", { status: 200 }],
    ["POST /capture", { status: 200, json: { ok: true, id: "capture-default" } }],
    ["POST /share", { status: 200, json: { ok: true } }],
    ["POST /update", { status: 200, json: { ok: true } }],
    ["GET /entry", { status: 200, json: { ok: true, entry: { id: "x", workspace: "personal", can_edit: true } } }],
  ]);

  /** @param {string} key @param {RouteBehavior} behavior */
  function setRoute(key, behavior) {
    routes.set(key, { ...routes.get(key), ...behavior });
  }

  function resetRequests() {
    requests.length = 0;
    teamsCallIndex = 0;
  }

  /** @param {import("node:http").IncomingMessage} req */
  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const routeKey = `${req.method} ${path === "/entry" ? "/entry" : path}`;
    const behavior = routes.get(routeKey) ?? routes.get(`${req.method} ${path.split("?")[0]}`);

    /** @type {unknown} */
    let body = undefined;
    if (req.method === "POST" || req.method === "PUT") {
      body = await readBody(req);
    } else if (path === "/entry") {
      body = { id: url.searchParams.get("id") };
    }

    requests.push({
      method: req.method ?? "GET",
      path: `${path}${url.search}`,
      headers: { ...req.headers },
      body,
      at: Date.now(),
    });

    if (path === "/team/workspaces" && req.method === "GET") {
      const list = teamsProvider ? teamsProvider(teamsCallIndex++) : teams;
      const route = routes.get("GET /team/workspaces") ?? {};
      if (route.hang) return;
      if (route.delayMs) await new Promise((r) => setTimeout(r, route.delayMs));
      const payload = route.handler
        ? route.handler()
        : {
          status: route.status ?? 200,
          json: route.json ? { ...route.json, teams: route.json.teams ?? list } : { ok: true, teams: list },
        };
      res.writeHead(payload.status ?? 200, { "Content-Type": "application/json" });
      if (payload.rawBody !== undefined) {
        res.end(payload.rawBody);
        return;
      }
      res.end(JSON.stringify(payload.json ?? { ok: true, teams: list }));
      return;
    }

    if (!behavior) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }

    if (behavior.hang) return;

    if (behavior.delayMs) {
      await new Promise((r) => setTimeout(r, behavior.delayMs));
    }

    const resolved = behavior.handler ? behavior.handler() : behavior;
    const status = resolved.status ?? 200;
    res.writeHead(status, { "Content-Type": "application/json" });
    if (resolved.rawBody !== undefined) {
      res.end(resolved.rawBody);
      return;
    }
    let json = resolved.json;
    if (routeKey === "POST /capture" && json && typeof json === "object" && json.ok === true && !json.id) {
      const n = requests.filter((r) => r.path.startsWith("/capture")).length;
      json = { ...json, id: `entry-${n}` };
    }
    res.end(JSON.stringify(json ?? { ok: true }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server failed to bind");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    requests,
    setRoute,
    setTeams(next) { teams = next; },
    setTeamsProvider(fn) { teamsProvider = fn; teamsCallIndex = 0; },
    resetRequests,
    async close() {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
