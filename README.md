# mcp-chatgpt-intellij-proxy

A small Node.js proxy that makes the **IntelliJ MCP Server** usable from **ChatGPT (Developer Mode)**.

## Why this exists

ChatGPT talks MCP via **Streamable HTTP** (POST to a single endpoint like `/sse`).

The IntelliJ MCP Server uses **SSE for responses** and often returns `202 Accepted` to POST requests, with the actual JSON-RPC response arriving asynchronously over the SSE stream.

This proxy bridges that gap by:

- Opening IntelliJ SSE (`http://127.0.0.1:64343/sse`) and discovering the session-specific POST endpoint (e.g. `/message?sessionId=...`).
- **Fetching `tools/list` exactly once at startup** and caching it.
- Answering ChatGPT `tools/list` **locally** from the cache (avoids hanging).
- Delegating `tools/call` to IntelliJ and returning the actual JSON-RPC response read from IntelliJ SSE.

## Requirements

- Node.js 18+ (ESM)
- IntelliJ MCP Server running locally (the built-in JetBrains MCP server / plugin)
- TLS certs for your public host

## Setup

1. Put your TLS files into `./certs/`:

- `current-car.com-key.pem`
- `current-car.com-fullchain.pem`

2. Start IntelliJ MCP Server (it must listen on `http://127.0.0.1:64343/sse`).

3. Run the proxy:

```powershell
node proxy.js
```

You should see:

- SSE connected
- Discovered POST endpoint
- Cached tools

## Configure ChatGPT

In ChatGPT Developer Mode, add a connector pointing to:

```
https://<your-host>:<port>/sse
```

(Replace host/port with your public endpoint that forwards to this proxy.)

## Notes

- If the proxy logs `202 Accepted` from IntelliJ, that is expected.
- If tools cache cannot be warmed up, the connector will fail until IntelliJ is reachable.

## License

MIT
