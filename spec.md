## Project: OAuth-secured MCP gateways for local, unauthenticated MCP servers (Cloudflare-native)

### Context

You have multiple MCP servers running on your home LAN (e.g. Paperless MCP at `http://192.168.1.3:7274/mcp`). These servers **do not implement authentication**. You want to use **Claude (web + iOS)** as the MCP client.

Key constraint: Claude does **not** let you attach arbitrary headers (like Cloudflare Access service-token headers) to MCP requests, so you can’t directly protect the LAN MCP endpoints with Cloudflare Access “Service Auth” and expect Claude to pass. Instead, we need an **OAuth-capable MCP gateway** that Claude *can* authenticate to, and that gateway will securely reach the LAN MCP server.

Cloudflare provides the building blocks to do this cleanly:

* **Cloudflare Tunnel** to reach LAN services without opening inbound ports.
* **Cloudflare Access for SaaS (OIDC)** as an OAuth provider for remote MCP servers.
* (Optional but recommended) **Cloudflare Access Service Tokens** to prevent direct access to the Tunnel origin hostname.

### Goal

Create one externally reachable MCP URL per backend (so Claude sees them as separate MCP servers), each requiring OAuth login via Cloudflare Access, and each proxying to the corresponding unauthenticated LAN MCP server via Tunnel.

### Non-goals

* Do not modify the underlying LAN MCP server implementations.
* Do not rely on per-user identity for authorization decisions beyond “allowed/denied” (but OAuth login will still exist).

---

## High-level architecture

### Public MCP endpoints (what Claude uses)

* `https://paperless-mcp.nickchristensen.house/mcp`
* `https://things-mcp.nickchristensen.house/mcp`
* etc.

Each is implemented by a **Cloudflare Worker** that:

1. completes OAuth with Cloudflare Access (OIDC SaaS app), then
2. proxies `/mcp` to a Tunnel hostname for the backend server.

### Origin endpoints (what the Worker proxies to via Tunnel)

* `https://paperless-origin.nickchristensen.house/mcp` → Tunnel → `http://192.168.1.3:7274/mcp`
* `https://things-origin.nickchristensen.house/mcp` → Tunnel → `http://192.168.1.3:8009/mcp`

These origin hostnames must be **non-publicly usable** in practice. We'll accomplish that by requiring a Cloudflare Access **Service Token** on the origin hostname and having the Worker inject those headers. Cloudflare documents the required headers (`CF-Access-Client-Id` / `CF-Access-Client-Secret`).

---

## Implementation Details

This section captures specific implementation decisions and configuration choices.

### Environment

* **Current setup**: Cloudflare Tunnel already running, some Access apps configured for other services
* **DNS**: nickchristensen.house domain already managed by Cloudflare DNS
* **Scale**: Starting with 2 MCP servers, expecting 3-5 total
* **Users**: Single user (owner's email address only)
* **Expected volume**: Low (10-100 requests/day per MCP server)

### Backend MCP Servers

| Name | LAN Address | MCP Path |
|------|-------------|----------|
| Paperless | 192.168.1.3:7274 | /mcp |
| Things | 192.168.1.3:8009 | /mcp |

### Worker Implementation Choices

**Technology Stack**
* TypeScript with strict mode and full type safety
* `@cloudflare/workers-oauth-provider` for OAuth implementation
* Minimal dependencies, stable code prioritized over cutting-edge features

**Architecture**
* Single codebase deployed manually per backend
* Pure transparent proxy - no request/response body inspection or modification
* Streaming support for MCP responses (no buffering)
* Minimal and simple - no over-engineering for hypothetical future features

**Worker Routes**
* `/mcp` - MCP endpoint (proxied to backend)
* `/authorize` - OAuth authorization endpoint
* `/callback` - OAuth callback handler
* `/token` - OAuth token endpoint
* `/register` - OAuth dynamic client registration
* `/.well-known/oauth-authorization-server` - OAuth discovery endpoint
* `/` - Returns 404 (no root handler)
* All other paths - 404

**Proxy Behavior**
* Timeout: 60 seconds for backend requests
* Error handling: Pass through raw errors from backend to client
* Backend failure mode: Return 502 Bad Gateway immediately (fail fast, no retries)
* Streaming: Pass through responses without buffering
* Headers: Transparently forward all headers except adding service token headers for origin

**Authentication & Session Management**
* Session duration: 90+ days or until explicit logout (maximum convenience)
* Cookie security flags: HttpOnly, Secure, SameSite (all standard flags)
* Token expiry handling: Attempt automatic token refresh transparently
* Access policy: Allow only owner's email address
* Client validation: OAuth is sufficient - no additional client checking
* CORS: No explicit CORS headers (OAuth flow handles cross-origin concerns)

**Security**
* No additional security requirements beyond Access + Service Token approach
* Service token headers injected by Worker only
* All secrets managed via `wrangler secret put` CLI command
* No rate limiting required (low volume, single user)

**Observability**
* Standard logging: Auth events, errors, basic request logging
* Use Cloudflare's built-in logging (no custom metrics/tracing)
* Errors visible in Cloudflare dashboard logs

**Development & Deployment**
* Local development: `wrangler dev` for testing
* Deployment: Direct to production (no staging environment)
* Testing: Deploy and debug as needed (acceptable for single-user personal use)
* Secrets management: `wrangler secret put` via CLI
* Rollback: Use `wrangler rollback` command if needed
* Tooling: Standard wrangler + npm scripts for common tasks
* Code documentation: Minimal, self-documenting code with comments only where needed

### Cloudflare Access Configuration

**Per public MCP endpoint (SaaS OIDC app)**
* Type: Access for SaaS
* Protocol: OIDC
* Redirect URL: `https://<name>-mcp.nickchristensen.house/callback`
* Policy: Allow owner's email address only
* Required config values to capture:
  * Client ID
  * Client Secret
  * Authorization endpoint
  * Token endpoint
  * JWKS (key) endpoint

**Per origin hostname (Service Auth)**
* Type: Self-hosted application
* Protected hostname: `<name>-origin.nickchristensen.house/*`
* Policy: Service Auth (service token required)
* Service token for each origin (Client ID + Secret)

---

## Requirements

### Functional requirements

1. **Claude can add each MCP server separately** using a unique URL (one per backend).
2. The public MCP endpoint requires **OAuth authentication** via Cloudflare Access (OIDC SaaS app).
3. After auth, the Worker proxies all `/mcp` requests to the LAN MCP server over Tunnel.
4. The origin hostname is **not directly usable** without a secret, so bypassing the gateway is prevented.

### Security requirements

1. Origin hostnames (`*-origin.*`) must require Cloudflare Access **Service Auth**.
2. Only the Worker has the service-token secret values needed to call the origin.
3. The public hostname (`*-mcp.*`) must be OAuth-protected; unauthenticated requests must not reach the LAN backend.
4. No secrets in source control: all credentials must be stored in Worker secrets.

### Reliability requirements

1. Proxy must support MCP over HTTP at `/mcp` (streamable responses, long-lived connections).
2. Gateway should not buffer entire responses if streaming is required; it should pass through streaming.

### Operational requirements

1. Each backend gets:

   * its own Worker deployment (recommended for simplicity)
   * its own Access-for-SaaS app (OIDC)
   * its own origin hostname + Access app (Service Auth)
2. Logging must be possible at least via Cloudflare logs for:

   * Access decisions on the public endpoint
   * Access decisions on the origin endpoint (service auth)

---

## Detailed implementation plan

### Phase 0: Naming + DNS plan

Define the hostname pattern (already decided):

* Public: `<name>-mcp.nickchristensen.house`
* Origin: `<name>-origin.nickchristensen.house`

Examples:

* `paperless-mcp.nickchristensen.house`
* `paperless-origin.nickchristensen.house`

This keeps “what Claude uses” and “what only the gateway uses” very explicit.

---

### Phase 1: Tunnel routes (LAN reachability)

For each backend MCP server:

**Input**

* Paperless: `192.168.1.3:7274` → `/mcp`
* Things: `192.168.1.3:8009` → `/mcp`

**Work**

1. Configure cloudflared Tunnel ingress so that:
   * `paperless-origin.nickchristensen.house` routes to `http://192.168.1.3:7274`
   * `things-origin.nickchristensen.house` routes to `http://192.168.1.3:8009`

2. Verify from the internet that both origin hostnames reach their respective LAN services:
   * `https://paperless-origin.nickchristensen.house/mcp`
   * `https://things-origin.nickchristensen.house/mcp`

**Example Tunnel configuration** (add to your cloudflared config):

```yaml
ingress:
  - hostname: paperless-origin.nickchristensen.house
    service: http://192.168.1.3:7274
  - hostname: things-origin.nickchristensen.house
    service: http://192.168.1.3:8009
  # ... other routes ...
  - service: http_status:404
```

**Acceptance criteria**

* Both origin hostnames reach their LAN services over Tunnel before Access is enabled.

---

### Phase 2: Lock down origin hostnames with Access Service Auth (anti-bypass)

For each origin hostname:

**Work**

1. Create a Cloudflare Access “self-hosted” application protecting:

   * `paperless-origin.nickchristensen.house/*`
2. Create a **Service Token** for the app.
3. Add an Access policy with action **Service Auth** requiring that service token.
4. Confirm that requests to the origin hostname now fail unless they include:

   * `CF-Access-Client-Id: …`
   * `CF-Access-Client-Secret: …`

**Acceptance criteria**

* `curl https://paperless-origin.../mcp` fails without headers.
* Same request succeeds when headers are provided.

---

### Phase 3: Create OAuth provider (Access for SaaS app) per public MCP endpoint

For each public MCP endpoint:

**Work**

1. In Cloudflare Zero Trust, create an **Access for SaaS** application:

   * Type: SaaS
   * Protocol: OIDC
   * Redirect URL: `https://paperless-mcp.nickchristensen.house/callback` (or whatever your gateway Worker expects)
2. Add Access policies to allow you (or your chosen group) to authenticate.
3. Record the following values for Worker config:

   * Client ID
   * Client secret
   * Authorization endpoint
   * Token endpoint
   * JWKS (key) endpoint

**Acceptance criteria**

* The SaaS app exists and policy allows login.

---

### Phase 4: Deploy the Worker "OAuth MCP gateway" per backend

For each backend:

**Worker responsibilities**

1. Expose `/mcp` as the MCP endpoint.
2. Implement OAuth endpoints needed by MCP clients:
   * `/authorize` - Initiate OAuth flow
   * `/callback` - Handle OAuth redirect
   * `/token` - Token exchange endpoint
   * `/register` - Dynamic client registration (via OAuthProvider)
   * `/.well-known/oauth-authorization-server` - OAuth discovery
3. After authentication, **proxy** incoming `/mcp` requests to origin with:
   * 60-second timeout
   * Streaming support (no response buffering)
   * Service token headers injected
   * Pass through all errors unchanged
4. Session management:
   * 90+ day session cookies
   * HttpOnly, Secure, SameSite flags
   * Automatic token refresh on expiry

**Worker secrets/config per deployment**

Set via `wrangler secret put <NAME>`:

* OAuth (from Access for SaaS app):
  * `ACCESS_CLIENT_ID` - Client ID from Access for SaaS app
  * `ACCESS_CLIENT_SECRET` - Client secret from Access for SaaS app
  * `ACCESS_AUTHORIZATION_URL` - Cloudflare Access authorization endpoint
  * `ACCESS_TOKEN_URL` - Cloudflare Access token endpoint
  * `ACCESS_JWKS_URL` - Cloudflare Access JWKS endpoint
  * `COOKIE_ENCRYPTION_KEY` - Random 32+ character string for encrypting session cookies

* Origin routing (non-secret, can be in wrangler.toml):
  * `ORIGIN_MCP_URL` - Backend origin URL
    * Paperless: `https://paperless-origin.nickchristensen.house/mcp`
    * Things: `https://things-origin.nickchristensen.house/mcp`

* Origin protection (service token from Access self-hosted app):
  * `CF_ACCESS_CLIENT_ID` - Service token client ID for origin
  * `CF_ACCESS_CLIENT_SECRET` - Service token secret for origin

**Work**

1. Create Worker project:
   ```bash
   npm create cloudflare@latest mcp-auth-gateway
   # Choose TypeScript, no Git, no deployment yet
   ```

2. Install dependencies:
   ```bash
   npm install @cloudflare/workers-oauth-provider
   ```

3. Implement Worker with:
   * TypeScript strict mode enabled
   * Route handlers for OAuth flow
   * Transparent proxy for `/mcp`
   * Minimal, self-documenting code

4. Configure wrangler.toml:
   * Set Worker name (e.g., `paperless-mcp-gateway`)
   * Configure custom domain route: `paperless-mcp.nickchristensen.house/*`
   * Add non-secret environment variables

5. Set secrets:
   ```bash
   wrangler secret put ACCESS_CLIENT_ID
   wrangler secret put ACCESS_CLIENT_SECRET
   wrangler secret put ACCESS_AUTHORIZATION_URL
   wrangler secret put ACCESS_TOKEN_URL
   wrangler secret put ACCESS_JWKS_URL
   wrangler secret put COOKIE_ENCRYPTION_KEY
   wrangler secret put CF_ACCESS_CLIENT_ID
   wrangler secret put CF_ACCESS_CLIENT_SECRET
   ```

6. Deploy:
   ```bash
   npm run deploy
   # or: wrangler deploy
   ```

7. Repeat for second backend (Things) with different:
   * Worker name in wrangler.toml
   * Custom domain route
   * All secrets (different Access app and service token)
   * `ORIGIN_MCP_URL` pointing to things-origin

**Acceptance criteria**

* Visiting `https://paperless-mcp.nickchristensen.house/authorize` triggers login via Cloudflare Access.
* After login, `/mcp` requests succeed and stream responses from LAN backend.
* Direct access to `paperless-origin.../mcp` remains blocked without service-token headers.
* Same verification for `things-mcp.nickchristensen.house`.
* Sessions persist for 90+ days without re-authentication.

---

### Phase 5: Connect from Claude

For each MCP server you want available to Claude:

1. In Claude (web), add MCP server URL:

   * `https://paperless-mcp.nickchristensen.house/mcp`
2. Complete the OAuth login prompt.

**Acceptance criteria**

* Claude successfully connects and lists tools from Paperless MCP.
* Repeat for `things-mcp...`.

---

## Testing checklist (do these in order)

### Origin tests

* ✅ Origin is reachable via Tunnel *before* Access lock-down.
* ✅ Origin is **blocked** without service token headers.
* ✅ Origin works **with** correct service token headers.

### Gateway OAuth tests

* ✅ First-time connect triggers OAuth login.
* ✅ After login, Claude can invoke a tool successfully.
* ✅ Logging: Access logs show the login + requests.

### Bypass tests

* ✅ Claude cannot connect directly to `paperless-origin...` (it lacks headers).
* ✅ Only gateway Worker can reach origin (service token injected).

---

## Risks & mitigations

1. **Streaming/long responses**: MCP over HTTP may use streaming. Ensure the Worker proxy does not accidentally buffer. (Use straight `fetch()` passthrough and return the `Response` directly.)
2. **Auth loops**: If callback URL / redirect URIs mismatch, the OAuth flow will loop/fail. Keep redirect URIs exact.
3. **Accidentally exposing origin**: If origin hostname is not Access-protected, it becomes a bypass. Make Phase 2 mandatory.
4. **Token refresh failures**: If automatic token refresh fails, return 401 to trigger full re-authentication in Claude rather than silently failing.
5. **Secret leakage**: Never commit secrets to Git. All sensitive values must be set via `wrangler secret put`.

---

## Troubleshooting Guide

### OAuth flow issues

**Problem**: Infinite redirect loop during login
**Causes**:
- Callback URL mismatch between Access app and Worker
- Cookie domain issues
- Browser blocking third-party cookies

**Solutions**:
- Verify redirect URI in Access app exactly matches `https://<name>-mcp.nickchristensen.house/callback`
- Check browser console for cookie warnings
- Test in different browser or incognito mode

---

**Problem**: "Invalid client" error during OAuth flow
**Causes**:
- Wrong `ACCESS_CLIENT_ID` or `ACCESS_CLIENT_SECRET`
- Secrets not properly set in Worker

**Solutions**:
- Verify secrets with `wrangler secret list`
- Re-set secrets using `wrangler secret put`
- Check Access app configuration in Cloudflare dashboard

---

### Backend connectivity issues

**Problem**: 502 Bad Gateway when accessing `/mcp`
**Causes**:
- Backend MCP server is down
- Tunnel is not running
- Origin hostname not routing through Tunnel
- Service token headers incorrect

**Solutions**:
- Check backend server: `curl http://192.168.1.3:7274/mcp` from LAN
- Verify Tunnel status: `cloudflared tunnel info`
- Test origin without service auth temporarily
- Verify `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` match the service token

---

**Problem**: Requests timeout after 60 seconds
**Causes**:
- MCP operation taking too long
- Backend server hung or slow

**Solutions**:
- Check backend server logs
- Consider increasing timeout in Worker code if legitimate slow operations
- Verify network path from Tunnel to backend

---

### Access/Security issues

**Problem**: Able to access origin hostname directly (bypass detected)
**Causes**:
- Service Auth not enabled on origin Access app
- Wrong policy configuration

**Solutions**:
- Verify Access app exists for `<name>-origin.nickchristensen.house`
- Check policy uses "Service Auth" with correct service token
- Test with `curl https://<name>-origin.../mcp` (should fail without headers)

---

**Problem**: Session expires too quickly
**Causes**:
- Cookie settings incorrect
- Browser clearing cookies
- Access policy session duration too short

**Solutions**:
- Verify cookie flags in Worker (HttpOnly, Secure, SameSite)
- Check Access policy session duration setting
- Review browser privacy settings

---

### Debugging tips

**View Worker logs**:
```bash
wrangler tail paperless-mcp-gateway
```

**Test OAuth flow manually**:
1. Visit `https://paperless-mcp.nickchristensen.house/authorize`
2. Complete login
3. Examine cookies in browser dev tools
4. Test `/mcp` endpoint with authenticated session

**Verify service token headers**:
```bash
curl -H "CF-Access-Client-Id: <id>" \
     -H "CF-Access-Client-Secret: <secret>" \
     https://paperless-origin.nickchristensen.house/mcp
```

**Check Cloudflare Access logs**:
- Navigate to Zero Trust dashboard → Logs → Access
- Filter by application name
- Review authentication attempts and decisions

---

## Deliverables

* One Worker codebase template (clone-able) parameterized by env vars.
* Two Worker deployments:

  * `paperless-mcp.nickchristensen.house`
  * `things-mcp.nickchristensen.house`
* Two Tunnel origin hostnames:

  * `paperless-origin.nickchristensen.house`
  * `things-origin.nickchristensen.house`
* Four Access applications:

  * 2× origin self-hosted apps (Service Auth)
  * 2× SaaS OIDC apps (OAuth)

---

## Configuration Summary

### Complete hostname-to-origin mapping

| Public Endpoint (Claude uses) | Origin Endpoint (Tunnel) | LAN Backend | Purpose |
|-------------------------------|-------------------------|-------------|---------|
| `paperless-mcp.nickchristensen.house/mcp` | `paperless-origin.nickchristensen.house/mcp` | `192.168.1.3:7274/mcp` | Paperless document management |
| `things-mcp.nickchristensen.house/mcp` | `things-origin.nickchristensen.house/mcp` | `192.168.1.3:8009/mcp` | Things task management |

### Required Cloudflare Access Applications

**Total: 4 Access apps (2 per backend)**

For Paperless:
1. **SaaS OIDC app** for `paperless-mcp.nickchristensen.house`
   - Provides OAuth for Claude
2. **Self-hosted app** for `paperless-origin.nickchristensen.house`
   - Service Auth to prevent bypass

For Things:
1. **SaaS OIDC app** for `things-mcp.nickchristensen.house`
   - Provides OAuth for Claude
2. **Self-hosted app** for `things-origin.nickchristensen.house`
   - Service Auth to prevent bypass

### Required Worker Deployments

**Total: 2 Workers (one per backend)**

1. `paperless-mcp-gateway` → routes `paperless-mcp.nickchristensen.house/*`
2. `things-mcp-gateway` → routes `things-mcp.nickchristensen.house/*`

Both use the same codebase with different configuration.

### Secrets Checklist

Per Worker deployment (8 secrets each):
- [ ] `ACCESS_CLIENT_ID` - From SaaS OIDC app
- [ ] `ACCESS_CLIENT_SECRET` - From SaaS OIDC app
- [ ] `ACCESS_AUTHORIZATION_URL` - From SaaS OIDC app
- [ ] `ACCESS_TOKEN_URL` - From SaaS OIDC app
- [ ] `ACCESS_JWKS_URL` - From SaaS OIDC app
- [ ] `COOKIE_ENCRYPTION_KEY` - Generate random 32+ char string
- [ ] `CF_ACCESS_CLIENT_ID` - From origin Service Token
- [ ] `CF_ACCESS_CLIENT_SECRET` - From origin Service Token

### Suggested package.json scripts

```json
{
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "tail": "wrangler tail",
    "rollback": "wrangler rollback",
    "deploy:paperless": "wrangler deploy --name paperless-mcp-gateway",
    "deploy:things": "wrangler deploy --name things-mcp-gateway"
  }
}
```

---
