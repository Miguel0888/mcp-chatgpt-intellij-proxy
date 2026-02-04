import https from "https";
import http from "http";
import fs from "fs";
import path from "path";

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
