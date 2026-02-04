import https from "https";
import http from "http";
import fs from "fs";
import path from "path";

// ================= CONFIG =================
const PORT = Number(process.env.PORT || 8081);

// ChatGPT MCP (Streamable HTTP)
const CHATGPT_ENDPOINT_PATH = "/sse";
const MCP_VERSION_CHATGPT = "2025-03-26";

// IntelliJ MCP (local)
const IJ_HOST = process.env.IJ_HOST || "127.0.0.1";
const IJ_PORT = Number(process.env.IJ_PORT || 64343);
const IJ_SSE_PATH = process.env.IJ_SSE_PATH || "/sse";

// Timeouts
const WAIT_ENDPOINT_MS = Number(process.env.WAIT_ENDPOINT_MS || 3000);
const WAIT_IJ_RESPONSE_MS = Number(process.env.WAIT_IJ_RESPONSE_MS || 30000);

// Logging
const DEBUG_SSE = String(process.env.DEBUG_SSE || "").toLowerCase() === "true";

// ================= TLS =================
const certFolder = path.resolve("./certs");
const tlsOptions = {
  key: fs.readFileSync(path.join(certFolder, "current-car.com-key.pem")),
  cert: fs.readFileSync(path.join(certFolder, "current-car.com-fullchain.pem"))
};

// ================= STATE =================
let ijPostPath = null; // discovered via IntelliJ SSE: /message?sessionId=...
let cachedTools = null;

const pendingById = new Map(); // id -> { resolve, reject, timeout, method }
let nextIjId = 1000; // Start above common ids

// ================= HELPERS =================
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c.toString()));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, obj) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function sendJsonRpcResult(res, id, result) {
  sendJson(res, 200, { jsonrpc: "2.0", id, result });
}

function sendJsonRpcError(res, id, code, message) {
  sendJson(res, 200, { jsonrpc: "2.0", id, error: { code, message } });
}

function isNotification(msg) {
  return msg && msg.id === undefined;
}

function normalizeEndpointToPath(endpoint) {
  const s = (endpoint || "").trim();
  if (!s) return null;

  // Handle absolute URL
  if (s.startsWith("http://") || s.startsWith("https://")) {
    try {
      const u = new URL(s);
      return u.pathname + (u.search || "");
    } catch {
      return null;
    }
  }

  if (s.startsWith("/")) return s;
  return "/" + s;
}

function parseEndpointDataToPath(dataText) {
  const raw = (dataText || "").trim();
  if (!raw) return null;

  // Try JSON first
  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw);
      const candidate = obj.uri || obj.url || obj.endpoint || obj.path;
      if (typeof candidate === "string") {
        return normalizeEndpointToPath(candidate);
      }
    } catch {
      // Ignore
    }
  }

  // Plain string
  return normalizeEndpointToPath(raw);
}

function createIjRequestId() {
  nextIjId += 1;
  return nextIjId;
}

function waitForIntelliJEndpoint() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (ijPostPath) {
        clearInterval(timer);
        resolve(ijPostPath);
        return;
      }
      if (Date.now() - start > WAIT_ENDPOINT_MS) {
        clearInterval(timer);
        reject(new Error("IntelliJ did not publish endpoint via SSE"));
      }
    }, 50);
  });
}

function resolvePendingFromJsonRpcObject(obj) {
  if (!obj || obj.id === undefined) return;
  if (obj.result === undefined && obj.error === undefined) return;

  const pending = pendingById.get(obj.id);
  if (!pending) return;

  clearTimeout(pending.timeout);
  pendingById.delete(obj.id);
  pending.resolve(obj);
}

// ================= INTELLIJ SSE (RECEIVE RESPONSES) =================
function openIntelliJSseSession() {
  console.log(`[IJ] Opening SSE session http://${IJ_HOST}:${IJ_PORT}${IJ_SSE_PATH}`);

  const req = http.request(
    {
      host: IJ_HOST,
      port: IJ_PORT,
      path: IJ_SSE_PATH,
      method: "GET",
      headers: { Accept: "text/event-stream" }
    },
    (res) => {
      console.log("[IJ] SSE connected", {
        status: res.statusCode,
        contentType: res.headers["content-type"]
      });

      let buffer = "";
      let currentEvent = null;
      let currentDataLines = [];

      const flushEvent = () => {
        const eventName = currentEvent || "message";
        const dataText = currentDataLines.join("\n");

        if (DEBUG_SSE) {
          const preview = dataText.length > 500 ? dataText.substring(0, 500) + "...<truncated>" : dataText;
          console.log("[IJ][SSE] event=", eventName, "data=", preview);
        }

        if (eventName === "endpoint") {
          const candidate = parseEndpointDataToPath(dataText);
          if (candidate) {
            ijPostPath = candidate;
            console.log("[IJ] Discovered POST endpoint from SSE:", ijPostPath);
          } else {
            console.warn("[IJ] Endpoint event but could not parse data:", dataText);
          }
        }

        if (eventName === "message") {
          const trimmed = (dataText || "").trim();
          if (trimmed) {
            try {
              const parsed = JSON.parse(trimmed);

              // IntelliJ might emit a single response or an array of responses.
              if (Array.isArray(parsed)) {
                for (let i = 0; i < parsed.length; i++) {
                  resolvePendingFromJsonRpcObject(parsed[i]);
                }
              } else {
                resolvePendingFromJsonRpcObject(parsed);
              }
            } catch {
              // Ignore non-JSON payload
            }
          }
        }

        currentEvent = null;
        currentDataLines = [];
      };

      res.on("data", (chunk) => {
        buffer += chunk.toString("utf8");

        while (true) {
          const idx = buffer.indexOf("\n");
          if (idx < 0) break;

          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);

          if (line.length === 0) {
            flushEvent();
            continue;
          }
          if (line.startsWith("event:")) {
            currentEvent = line.substring("event:".length).trim();
            continue;
          }
          if (line.startsWith("data:")) {
            currentDataLines.push(line.substring("data:".length).trim());
            continue;
          }
          // Comments ":" ignored
        }
      });

      res.on("end", () => {
        console.error("[IJ] SSE ended");
      });

      res.on("error", (err) => {
        console.error("[IJ] SSE error:", err.message);
      });
    }
  );

  req.on("error", (err) => {
    console.error("[IJ] SSE connection failed:", err.message);
  });

  req.end();
}

// ================= INTELLIJ POST (SEND REQUESTS) =================
function postToIntelliJ(pathWithQuery, jsonBody) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: IJ_HOST,
        port: IJ_PORT,
        path: pathWithQuery,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(jsonBody, "utf8")
        }
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c.toString()));
        res.on("end", () => resolve({ statusCode: res.statusCode || 0, body: data }));
      }
    );

    req.on("error", reject);
    req.write(jsonBody);
    req.end();
  });
}

function callIntelliJAndWait(method, params) {
  return new Promise(async (resolve, reject) => {
    let endpoint;
    try {
      endpoint = await waitForIntelliJEndpoint();
    } catch (e) {
      reject(e);
      return;
    }

    const id = createIjRequestId();
    const requestObj = { jsonrpc: "2.0", id, method, params };

    const timeout = setTimeout(() => {
      pendingById.delete(id);
      reject(new Error(`IntelliJ did not answer ${method} (id=${id}) within ${WAIT_IJ_RESPONSE_MS}ms`));
    }, WAIT_IJ_RESPONSE_MS);

    pendingById.set(id, { resolve, reject, timeout, method });

    // IntelliJ often returns 202 + "Accepted"; ignore HTTP body.
    try {
      const httpResp = await postToIntelliJ(endpoint, JSON.stringify(requestObj));
      const bodyPreview = (httpResp.body || "").toString();
      console.log("[IJ] POST", method, "id=", id, "HTTP", httpResp.statusCode, bodyPreview ? JSON.stringify(bodyPreview) : "");
    } catch (err) {
      clearTimeout(timeout);
      pendingById.delete(id);
      reject(err);
    }
  });
}

// ================= STARTUP: CACHE TOOLS ONCE =================
async function warmUpToolsCache() {
  console.log("[BOOT] Warming up tools cache from IntelliJ...");

  await waitForIntelliJEndpoint();

  // Initialize IntelliJ (required)
  await callIntelliJAndWait("initialize", {
    protocolVersion: "1.0",
    capabilities: { sse: true, jsonrpc: true },
    clientInfo: { name: "chatgpt-proxy", version: "1.0.0" }
  });

  // Ask for tools list
  const toolsResponse = await callIntelliJAndWait("tools/list", {});
  if (toolsResponse.error) {
    throw new Error(`IntelliJ tools/list error: ${toolsResponse.error.message || "unknown"}`);
  }

  cachedTools = toolsResponse.result && toolsResponse.result.tools ? toolsResponse.result.tools : [];
  console.log(`[BOOT] Cached ${cachedTools.length} tools`);
}

// ================= CHATGPT SERVER =================
https
  .createServer(tlsOptions, async (req, res) => {
    console.log("REQ", req.method, req.url);

    // Probes
    if (req.method === "GET") {
      if (req.url === "/" || req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.url && req.url.startsWith("/favicon")) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    // ChatGPT MCP endpoint
    if (req.method === "POST" && req.url === CHATGPT_ENDPOINT_PATH) {
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        sendJson(res, 400, { error: "Failed to read request body" });
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } });
        return;
      }

      console.log("RPC", msg.method);

      // Notifications: no response
      if (msg.method?.startsWith("notifications/") && isNotification(msg)) {
        res.writeHead(204);
        res.end();
        return;
      }

      // initialize: local for ChatGPT
      if (msg.method === "initialize") {
        sendJsonRpcResult(res, msg.id, {
          protocolVersion: MCP_VERSION_CHATGPT,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: "chatgpt-intellij-mcp-proxy", version: "1.0.1" }
        });
        return;
      }

      // tools/list: local from cache
      if (msg.method === "tools/list") {
        if (!cachedTools) {
          sendJsonRpcError(res, msg.id, -32000, "Tools cache not ready yet (startup still fetching)");
          return;
        }
        sendJsonRpcResult(res, msg.id, { tools: cachedTools });
        return;
      }

      // tools/call: delegate to IntelliJ and wait for SSE response
      if (msg.method === "tools/call") {
        try {
          if (!cachedTools) {
            sendJsonRpcError(res, msg.id, -32000, "Tools cache not ready yet");
            return;
          }

          const toolName = msg.params?.name;
          const args = msg.params?.arguments || {};

          // JetBrains IntelliJ MCP commonly uses call_tool
          const ijResp = await callIntelliJAndWait("call_tool", {
            name: toolName,
            input: args
          });

          // Return IntelliJ JSON-RPC response as-is to ChatGPT
          sendJson(res, 200, ijResp);
        } catch (err) {
          sendJsonRpcError(res, msg.id, -32000, err.message);
        }
        return;
      }

      // resources/prompts: local
      if (msg.method === "resources/list") {
        sendJsonRpcResult(res, msg.id, { resources: [] });
        return;
      }

      if (msg.method === "prompts/list") {
        sendJsonRpcResult(res, msg.id, { prompts: [] });
        return;
      }

      sendJsonRpcError(res, msg.id, -32601, "Method not supported");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  })
  .listen(PORT, async () => {
    console.log(`MCP proxy listening on https://0.0.0.0:${PORT}${CHATGPT_ENDPOINT_PATH}`);

    // Open IntelliJ SSE and warm-up tool cache once.
    openIntelliJSseSession();

    try {
      await warmUpToolsCache();
      console.log("[BOOT] Ready");
    } catch (err) {
      console.error("[BOOT] Failed to warm up tools cache:", err.message);
    }
  });
