import https from "https";
import http from "http";
import fs from "fs";
import path from "path";
import { createRemoteJWKSet, jwtVerify } from "jose";

// ================= CONFIG =================
const PORT = Number(process.env.PORT || 8081);
const MCP_VERSION_CHATGPT = "2025-03-26";

// IntelliJ MCP (local)
const IJ_HOST = process.env.IJ_HOST || "127.0.0.1";
const IJ_PORT = Number(process.env.IJ_PORT || 64343);
const IJ_SSE_PATH = process.env.IJ_SSE_PATH || "/sse";

// Timeouts
const WAIT_ENDPOINT_MS = Number(process.env.WAIT_ENDPOINT_MS || 3000);
const WAIT_IJ_RESPONSE_MS = Number(process.env.WAIT_IJ_RESPONSE_MS || 60000);

// Logging
const DEBUG_SSE = String(process.env.DEBUG_SSE || "").toLowerCase() === "true";

// ================= OAUTH (MCP Resource Server) =================
/**
 * Enable OAuth only when an issuer is configured (or explicitly enabled).
 * Keep backward compatibility for purely local usage.
 */
const AUTH_ISSUER_RAW = String(process.env.AUTH_ISSUER || "").trim();
const OAUTH_ENABLED =
  String(process.env.OAUTH_ENABLED || "").trim() !== ""
    ? String(process.env.OAUTH_ENABLED).toLowerCase() === "true"
    : AUTH_ISSUER_RAW.length > 0;

const AUTH_ISSUER = AUTH_ISSUER_RAW.replace(/\/$/, "");
const RESOURCE_URL = String(process.env.RESOURCE_URL || "").trim();
const EXPECTED_AUDIENCE = String(process.env.EXPECTED_AUDIENCE || RESOURCE_URL).trim();

const JWKS_URL = String(
  process.env.JWKS_URL || (AUTH_ISSUER ? `${AUTH_ISSUER}/.well-known/jwks.json` : "")
).trim();

const REQUIRED_SCOPES = String(process.env.REQUIRED_SCOPES || "")
  .split(/\s+/)
  .map((s) => s.trim())
  .filter(Boolean);

let jwks = null;
if (OAUTH_ENABLED) {
  if (!AUTH_ISSUER) {
    // Log and refuse to start only if OAuth is explicitly enabled.
    console.error("[OAUTH] AUTH_ISSUER is missing but OAuth is enabled.");
    process.exit(1);
  }
  if (!RESOURCE_URL) {
    console.error("[OAUTH] RESOURCE_URL is missing but OAuth is enabled.");
    process.exit(1);
  }
  if (!JWKS_URL) {
    console.error("[OAUTH] JWKS_URL is missing but OAuth is enabled.");
    process.exit(1);
  }
  jwks = createRemoteJWKSet(new URL(JWKS_URL));
  console.log("[OAUTH] Enabled");
  console.log("[OAUTH] issuer:", AUTH_ISSUER);
  console.log("[OAUTH] resource:", RESOURCE_URL);
  console.log("[OAUTH] audience:", EXPECTED_AUDIENCE);
  console.log("[OAUTH] jwks:", JWKS_URL);
  console.log("[OAUTH] required scopes:", REQUIRED_SCOPES.join(" ") || "(none)");
} else {
  console.log("[OAUTH] Disabled (set AUTH_ISSUER + RESOURCE_URL to enable)");
}

// ================= TLS =================
const certFolder = path.resolve("./certs");
const tlsOptions = {
  key: fs.readFileSync(path.join(certFolder, "current-car.com-key.pem")),
  cert: fs.readFileSync(path.join(certFolder, "current-car.com-fullchain.pem"))
};

// ================= STATE =================
let ijPostPath = null;
let cachedTools = null;
let toolsWarmupPromise = null;

// Exactly one pending call at a time
let pendingCall = null;

// ================= HELPERS =================
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, obj, extraHeaders) {
  const headers = Object.assign({ "Content-Type": "application/json" }, extraHeaders || {});
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(obj));
}

function sendJsonRpcResult(res, id, result) {
  sendJson(res, 200, { jsonrpc: "2.0", id, result });
}

function sendJsonRpcError(res, id, code, message) {
  sendJson(res, 200, { jsonrpc: "2.0", id, error: { code, message } });
}

function normalizeEndpointToPath(endpoint) {
  const s = (endpoint || "").trim();
  if (!s) return null;

  if (s.startsWith("http")) {
    try {
      const u = new URL(s);
      return u.pathname + (u.search || "");
    } catch {
      return null;
    }
  }
  return s.startsWith("/") ? s : "/" + s;
}

function waitForIntelliJEndpoint() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (ijPostPath) {
        clearInterval(t);
        resolve(ijPostPath);
      }
      if (Date.now() - start > WAIT_ENDPOINT_MS) {
        clearInterval(t);
        reject(new Error("IntelliJ did not publish POST endpoint"));
      }
    }, 50);
  });
}

function extractToolCall(msg) {
  const params = msg.params || {};
  return {
    name: params.name,
    args:
      params.arguments !== undefined
        ? params.arguments
        : params.input !== undefined
        ? params.input
        : {}
  };
}

// ================= OAUTH HELPERS =================
function extractScopesFromJwtPayload(payload) {
  // Support "scope": "a b c" and "scp": ["a","b"]
  if (payload && typeof payload.scope === "string") {
    return new Set(payload.scope.split(/\s+/).filter(Boolean));
  }
  if (payload && Array.isArray(payload.scp)) {
    return new Set(payload.scp.map(String));
  }
  return new Set();
}

function buildResourceMetadataUrl() {
  // Use configured external URL, not Host header, to avoid spoofing.
  return `${RESOURCE_URL}/.well-known/oauth-protected-resource`;
}

function sendOauthChallenge(res, error, description, scope) {
  // Follow the MCP guidance: send WWW-Authenticate with resource_metadata.
  const metaUrl = buildResourceMetadataUrl();
  const parts = [
    `Bearer resource_metadata="${metaUrl}"`,
    `error="${error}"`,
    `error_description="${description}"`
  ];
  if (scope) {
    parts.push(`scope="${scope}"`);
  }

  sendJson(
    res,
    401,
    { error, error_description: description },
    { "WWW-Authenticate": parts.join(", ") }
  );
}

async function authenticateRequestOrChallenge(req, res) {
  if (!OAUTH_ENABLED) {
    // Accept all requests when OAuth is disabled.
    return { ok: true, user: null };
  }

  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    sendOauthChallenge(res, "no_token", "Missing bearer token");
    return { ok: false };
  }

  const token = match[1];

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: AUTH_ISSUER,
      audience: EXPECTED_AUDIENCE
      // Validate exp automatically.
    });

    const scopes = extractScopesFromJwtPayload(payload);
    if (REQUIRED_SCOPES.length > 0) {
      const hasAll = REQUIRED_SCOPES.every((s) => scopes.has(s));
      if (!hasAll) {
        sendOauthChallenge(
          res,
          "insufficient_scope",
          `Missing required scope(s): ${REQUIRED_SCOPES.join(" ")}`,
          REQUIRED_SCOPES.join(" ")
        );
        return { ok: false };
      }
    }

    return {
      ok: true,
      user: {
        sub: payload.sub,
        email: payload.email
      }
    };
  } catch (e) {
    sendOauthChallenge(res, "invalid_token", "Token validation failed");
    return { ok: false };
  }
}

// ================= INTELLIJ SSE =================
function handleIntelliJSsePayload(dataText, eventName) {
  const text = (dataText || "").trim();
  if (!text) return;

  if (DEBUG_SSE) {
    console.log("[IJ][SSE]", eventName || "message", text);
  }

  if ((eventName || "message") === "endpoint") {
    ijPostPath = normalizeEndpointToPath(text);
    console.log("[IJ] POST endpoint:", ijPostPath);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }

  const msgs = Array.isArray(parsed) ? parsed : [parsed];
  for (const msg of msgs) {
    if (!pendingCall) continue;
    if (msg.result !== undefined || msg.error !== undefined) {
      clearTimeout(pendingCall.timeout);
      const resolve = pendingCall.resolve;
      pendingCall = null;
      resolve(msg);
      return;
    }
  }
}

function openIntelliJSseSession() {
  const req = http.request(
    {
      host: IJ_HOST,
      port: IJ_PORT,
      path: IJ_SSE_PATH,
      method: "GET",
      headers: { Accept: "text/event-stream" }
    },
    (res) => {
      let buffer = "";
      let event = null;
      let lines = [];

      const flush = () => {
        handleIntelliJSsePayload(lines.join("\n"), event);
        event = null;
        lines = [];
      };

      res.on("data", (chunk) => {
        buffer += chunk.toString();
        while (true) {
          const i = buffer.indexOf("\n");
          if (i < 0) break;
          const line = buffer.slice(0, i).replace(/\r$/, "");
          buffer = buffer.slice(i + 1);

          if (!line) {
            flush();
          } else if (line.startsWith("event:")) {
            event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            lines.push(line.slice(5).trim());
          }
        }
      });
    }
  );

  req.end();
}

// ================= INTELLIJ POST =================
function postToIntelliJ(path, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: IJ_HOST,
        port: IJ_PORT,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function callIntelliJ(method, params) {
  const endpoint = await waitForIntelliJEndpoint();
  if (pendingCall) throw new Error("Concurrent IntelliJ call");

  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCall = null;
      reject(new Error("IntelliJ timeout"));
    }, WAIT_IJ_RESPONSE_MS);

    pendingCall = { resolve, reject, timeout };

    await postToIntelliJ(
      endpoint,
      JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params
      })
    );
  });
}

// 🔥 FIX: IntelliJ supports ONLY tools/call
async function callIntelliJTool(name, args) {
  return callIntelliJ("tools/call", {
    name,
    arguments: args
  });
}

// ================= WARMUP =================
async function warmUpToolsCacheOnce() {
  if (cachedTools) return cachedTools;
  if (toolsWarmupPromise) return toolsWarmupPromise;

  toolsWarmupPromise = (async () => {
    await waitForIntelliJEndpoint();

    await callIntelliJ("initialize", {
      protocolVersion: "1.0",
      capabilities: { sse: true },
      clientInfo: { name: "proxy", version: "1.0" }
    });

    const resp = await callIntelliJ("tools/list", {});
    cachedTools = resp.result.tools || [];
    console.log("[BOOT] Tools:", cachedTools.length);
    return cachedTools;
  })();

  return toolsWarmupPromise;
}

// ================= SERVER =================
https
  .createServer(tlsOptions, async (req, res) => {
    // ----- Public OAuth metadata endpoint -----
    if (req.method === "GET" && req.url === "/.well-known/oauth-protected-resource") {
      if (!OAUTH_ENABLED) {
        // Still expose something sensible for debugging.
        return sendJson(res, 200, {
          resource: RESOURCE_URL || `https://localhost:${PORT}`,
          authorization_servers: AUTH_ISSUER ? [AUTH_ISSUER] : [],
          scopes_supported: REQUIRED_SCOPES
        });
      }

      return sendJson(res, 200, {
        resource: RESOURCE_URL,
        authorization_servers: [AUTH_ISSUER],
        scopes_supported: REQUIRED_SCOPES,
        resource_documentation: `${RESOURCE_URL}/docs`
      });
    }

    // Optional health check (public)
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    // ----- Protect MCP endpoint (/sse) -----
    if ((req.url || "").startsWith("/sse")) {
      const auth = await authenticateRequestOrChallenge(req, res);
      if (!auth.ok) return;
      // Attach user for potential logging if needed.
      req.user = auth.user;
    }

    // Existing behavior: endpoint discovery over SSE
    if (req.method === "GET" && req.url === "/sse") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      res.write(`event: endpoint\n`);
      res.write(`data: /sse\n\n`);
      return;
    }

    if (req.method !== "POST" || req.url !== "/sse") {
      res.writeHead(404);
      return res.end();
    }

    const msg = JSON.parse(await readBody(req));
    console.log("RPC", msg.method);

    if (msg.method === "initialize") {
      return sendJsonRpcResult(res, msg.id, {
        protocolVersion: MCP_VERSION_CHATGPT,
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-proxy", version: "fixed" }
      });
    }

    if (msg.method === "tools/list") {
      await warmUpToolsCacheOnce();
      return sendJsonRpcResult(res, msg.id, { tools: cachedTools });
    }

    if (msg.method === "tools/call" || msg.method === "call_tool") {
      const { name, args } = extractToolCall(msg);
      const ijResp = await callIntelliJTool(name, args);
      return sendJsonRpcResult(res, msg.id, ijResp.result);
    }

    sendJsonRpcError(res, msg.id, -32601, "Method not supported");
  })
  .listen(PORT, () => {
    console.log(`MCP proxy listening on https://localhost:${PORT}/sse`);
    openIntelliJSseSession();
  });
