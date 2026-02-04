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

## OAuth Quickstart: Microsoft Entra ID (recommended)

This proxy can protect `/sse` with OAuth and validate **JWT access tokens** locally via **JWKS**.
Microsoft Entra ID typically works out of the box with this proxy’s JWT validation.

### 1) Create an App Registration
- Entra admin center → **App registrations** → **New registration**
- Choose account type as desired (personal accounts are fine for “only me”)

### 2) Expose an API + scope
- In your app registration: **Expose an API**
- Set an **Application ID URI** (example: `api://mcp-intellij-proxy`)
- Add a scope, e.g. `mcp.read`
- Grant admin consent if your tenant requires it

### 3) Configure environment variables (PowerShell)
Replace `<TENANT_ID>` and `<YOUR_PUBLIC_PROXY_URL>`.

```powershell
$env:OAUTH_ENABLED = "true"

# Issuer (tenant-specific)
$env:AUTH_ISSUER = "https://login.microsoftonline.com/<TENANT_ID>/v2.0"

# Public URL of the proxy as reached by ChatGPT (must match your connector URL host/port)
$env:RESOURCE_URL = "<YOUR_PUBLIC_PROXY_URL>"

# JWKS endpoint (tenant-specific)
$env:JWKS_URL = "https://login.microsoftonline.com/<TENANT_ID>/discovery/v2.0/keys"

# Audience expected by the proxy (defaults to RESOURCE_URL; set explicitly for clarity)
$env:EXPECTED_AUDIENCE = $env:RESOURCE_URL

# Optional: require scopes (space-separated)
$env:REQUIRED_SCOPES = "mcp.read"

node proxy.js
```

### 4) Configure ChatGPT Connector
Point the connector to:

```
https://<your-host>:<port>/sse
```

On first use, ChatGPT will trigger account linking and then call the proxy with:

```
Authorization: Bearer <access_token>
```

### 5) Lock it down to “only me” (recommended)
JWT validation proves the token is real, but you should also **whitelist your identity**.
Best is Microsoft’s stable object id claim (`oid`), or fallback to your login (`preferred_username`).

You can implement a check like:
- allow if `oid == "<YOUR_OBJECT_ID>"`


---

## OAuth Quickstart: Google (note about access tokens)

Google is great for “Sign in with Google”, but for typical user logins the **access token is often opaque** (not a JWT),
so this proxy’s **JWT access token** validation will usually **not** work without changes.

### Options
- **Recommended:** use **Microsoft Entra ID** (no code changes required)
- **Alternative:** change the proxy to accept and validate an **OIDC ID Token** (JWT) instead of an access token
- **Alternative:** validate Google opaque access tokens online (extra API call per request)

If you want the “accept ID token” variant, say so and I’ll provide the exact proxy.js changes plus a minimal config.


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
