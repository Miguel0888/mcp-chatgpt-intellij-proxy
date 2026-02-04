# mcp-chatgpt-intellij-proxy

A small Node.js proxy that makes the **IntelliJ MCP Server** usable from
**ChatGPT (Developer Mode)**.

## Why this exists

ChatGPT talks MCP via **Streamable HTTP** (POST to a single endpoint
like `/sse`).

The IntelliJ MCP Server uses **SSE for responses** and often returns
`202 Accepted` to POST requests, with the actual JSON-RPC response
arriving asynchronously over the SSE stream.

This proxy bridges that gap by:

-   Opening IntelliJ SSE (`http://127.0.0.1:64343/sse`) and discovering
    the session-specific POST endpoint.
-   Fetching `tools/list` exactly once at startup and caching it.
-   Answering ChatGPT `tools/list` locally from the cache.
-   Delegating `tools/call` to IntelliJ and returning the JSON-RPC
    response read from SSE.

## Authentication (OAuth / OpenID Connect)

This proxy can optionally protect the MCP endpoint (`/sse`) using
**OAuth 2.0 / OpenID Connect**.

### How authentication works

-   ChatGPT acts as the OAuth client\
-   Your Identity Provider (IdP) acts as the Authorization Server\
-   This proxy acts as the Resource Server

Flow:

1.  ChatGPT calls `POST /sse` without an access token
2.  The proxy responds with `401 Unauthorized` and a `WWW-Authenticate`
    challenge
3.  ChatGPT performs OAuth login with your IdP
4.  ChatGPT retries with `Authorization: Bearer <access_token>`
5.  The proxy validates the token (signature, issuer, audience, expiry,
    scopes)
6.  If valid, the request is processed

### OAuth metadata endpoint

The proxy exposes:

    GET /.well-known/oauth-protected-resource

This endpoint tells ChatGPT which authorization server to use and which
scopes are supported.

OAuth is enabled automatically when both `AUTH_ISSUER` and
`RESOURCE_URL` are set.

## Environment Variables

### Core

  Variable      Description
  ------------- ----------------------------
  PORT          HTTPS port (default: 8081)
  IJ_HOST       IntelliJ MCP host
  IJ_PORT       IntelliJ MCP port
  IJ_SSE_PATH   IntelliJ SSE path

### OAuth

  Variable            Description
  ------------------- --------------------------------
  AUTH_ISSUER         Issuer URL of the IdP
  RESOURCE_URL        Public HTTPS URL of this proxy
  EXPECTED_AUDIENCE   Expected aud claim
  JWKS_URL            JWKS endpoint
  REQUIRED_SCOPES     Required OAuth scopes
  OAUTH_ENABLED       Force OAuth on/off

### Debugging

  Variable    Description
  ----------- ---------------------
  DEBUG_SSE   Log raw SSE traffic

## PowerShell setup

Temporary:

``` powershell
$env:AUTH_ISSUER = "https://idp.example.com/realms/mcp"
$env:RESOURCE_URL = "https://proxy.example.com"
$env:REQUIRED_SCOPES = "mcp.read"
node proxy.js
```

Persistent:

``` powershell
setx AUTH_ISSUER "https://idp.example.com/realms/mcp"
setx RESOURCE_URL "https://proxy.example.com"
```

## License

MIT
