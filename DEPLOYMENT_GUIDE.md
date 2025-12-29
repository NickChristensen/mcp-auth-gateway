# MCP Auth Gateway - Deployment Guide

Step-by-step guide to deploy your OAuth-secured MCP gateways.

## Prerequisites Checklist

- [ ] Cloudflare account with Workers enabled
- [ ] Cloudflare Zero Trust (Access) enabled
- [ ] Domain `nickchristensen.house` on Cloudflare DNS
- [ ] Cloudflare Tunnel running and routing to your LAN
- [ ] Paperless MCP running at `192.168.1.3:7274`
- [ ] Things MCP running at `192.168.1.3:8009`
- [ ] Node.js 18+ installed
- [ ] Wrangler CLI authenticated (`wrangler login`)

---

## Phase 1: Cloudflare Tunnel Configuration

Ensure your Tunnel routes are configured:

```yaml
# Add to your cloudflared config
ingress:
  - hostname: paperless-origin.nickchristensen.house
    service: http://192.168.1.3:7274
  - hostname: things-origin.nickchristensen.house
    service: http://192.168.1.3:8009
  # ... other routes ...
  - service: http_status:404
```

**Verify**:
```bash
# Test that origins are reachable (before Access lockdown)
curl https://paperless-origin.nickchristensen.house/mcp
curl https://things-origin.nickchristensen.house/mcp
```

---

## Phase 2: Cloudflare Access Applications

### For Paperless MCP:

1. **Open Cloudflare Zero Trust dashboard**
2. **Use the prompt in** [SETUP_PROMPT.md](SETUP_PROMPT.md)
3. **Copy it into Claude Code Chrome extension**
4. **Follow the guided setup** to create both applications
5. **Record all values** in [SECRETS_TEMPLATE.md](SECRETS_TEMPLATE.md)

This creates:
- ✅ SaaS OIDC app for OAuth (`paperless-mcp.nickchristensen.house`)
- ✅ Self-hosted Service Auth app (`paperless-origin.nickchristensen.house`)

### For Things MCP:

Repeat the same process with these hostname changes:
- Public: `things-mcp.nickchristensen.house`
- Origin: `things-origin.nickchristensen.house`

---

## Phase 3: Worker Configuration & Deployment

### A. Configure Paperless Gateway

1. **Copy wrangler config**:
```bash
cp wrangler.example.toml wrangler.toml
```

2. **Edit wrangler.toml**:
```toml
name = "paperless-mcp-gateway"
routes = [
  { pattern = "paperless-mcp.nickchristensen.house/*", custom_domain = true }
]

[vars]
ORIGIN_MCP_URL = "https://paperless-origin.nickchristensen.house/mcp"
```

3. **Generate encryption key**:
```bash
openssl rand -base64 32
# Save this value!
```

4. **Set all 8 secrets**:
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

5. **Deploy**:
```bash
npm run deploy
# or: wrangler deploy
```

6. **Test**:
```bash
# Should redirect to Cloudflare Access login
curl -I https://paperless-mcp.nickchristensen.house/mcp

# Verify origin is protected (should fail without headers)
curl https://paperless-origin.nickchristensen.house/mcp
```

### B. Configure Things Gateway

1. **Update wrangler.toml** for Things:
```toml
name = "things-mcp-gateway"
routes = [
  { pattern = "things-mcp.nickchristensen.house/*", custom_domain = true }
]

[vars]
ORIGIN_MCP_URL = "https://things-origin.nickchristensen.house/mcp"
```

2. **Generate new encryption key**:
```bash
openssl rand -base64 32
# Different key than Paperless!
```

3. **Set secrets for Things**:
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

4. **Deploy**:
```bash
npm run deploy
```

---

## Phase 4: Connect from Claude

### Web (claude.ai)

1. Go to Settings → Integrations → MCP Servers
2. Add new server:
   - URL: `https://paperless-mcp.nickchristensen.house/mcp`
3. Complete OAuth login flow
4. Repeat for Things:
   - URL: `https://things-mcp.nickchristensen.house/mcp`

### iOS App

Same URLs, complete OAuth on mobile device.

---

## Verification & Testing

### Test OAuth Flow

```bash
# 1. Visit authorize endpoint
open https://paperless-mcp.nickchristensen.house/authorize

# 2. Complete login via Cloudflare Access

# 3. Should redirect to /callback then /mcp

# 4. Verify session cookie is set
```

### Test MCP Proxy

After authenticating via Claude:
- ✅ Can list tools from Paperless MCP
- ✅ Can invoke tools successfully
- ✅ Session persists (no re-auth for 90 days)

### Test Security

```bash
# Origin should be blocked without service token
curl https://paperless-origin.nickchristensen.house/mcp
# Expected: 403 Forbidden or Cloudflare Access block

# With service token (should work)
curl -H "CF-Access-Client-Id: YOUR_ID" \
     -H "CF-Access-Client-Secret: YOUR_SECRET" \
     https://paperless-origin.nickchristensen.house/mcp
# Expected: 200 OK with MCP response
```

### Monitor Logs

```bash
# Watch Worker logs in real-time
wrangler tail paperless-mcp-gateway

# In another terminal
wrangler tail things-mcp-gateway
```

---

## Troubleshooting

See [spec.md](spec.md) Troubleshooting Guide section for common issues and solutions.

### Quick Checks

1. **OAuth redirect loop**:
   - Verify redirect URI matches exactly in Access app
   - Check browser console for cookie errors

2. **502 Bad Gateway**:
   - Check backend MCP is running
   - Verify Tunnel status
   - Check service token headers

3. **Token expired too quickly**:
   - Verify COOKIE_ENCRYPTION_KEY is set correctly
   - Check Access policy session duration

### View Cloudflare Access Logs

1. Go to Zero Trust dashboard
2. Logs → Access
3. Filter by application name
4. Review authentication attempts

---

## Maintenance

### Update Worker Code

```bash
git pull
npm install
npm run deploy
```

### Rotate Secrets

```bash
# Generate new cookie encryption key
openssl rand -base64 32

# Update secret
wrangler secret put COOKIE_ENCRYPTION_KEY

# Note: This will invalidate all existing sessions
```

### Rollback Deployment

```bash
wrangler rollback
```

---

## Success Criteria

- [ ] Both Workers deployed successfully
- [ ] All 4 Cloudflare Access apps configured
- [ ] OAuth flow works for both gateways
- [ ] Claude can connect and use both MCP servers
- [ ] Origin endpoints are blocked without service tokens
- [ ] Sessions persist for 90 days
- [ ] No errors in Worker logs

🎉 **Deployment Complete!**
