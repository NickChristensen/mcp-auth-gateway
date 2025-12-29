# MCP Auth Gateway

OAuth-secured MCP gateway for Cloudflare Workers. Provides authentication and authorization for local, unauthenticated MCP servers using Cloudflare Access.

## Overview

This Worker acts as an OAuth-capable gateway that:
- Authenticates users via Cloudflare Access (OIDC)
- Proxies authenticated MCP requests to backend servers via Cloudflare Tunnel
- Prevents direct access to origin endpoints using Service Auth tokens

## Setup

### Prerequisites

- Cloudflare account with Workers enabled
- Cloudflare Tunnel configured and routing to your LAN MCP servers
- Node.js 18+ and npm

### Installation

```bash
npm install
```

### Configuration

1. **Update wrangler.toml** for your deployment:
   - Set `name` to `paperless-mcp-gateway` or `things-mcp-gateway`
   - Configure `routes` for your custom domain
   - Set `ORIGIN_MCP_URL` to your backend origin URL

2. **Set required secrets** via Wrangler CLI:

```bash
# OAuth configuration from Cloudflare Access SaaS app
wrangler secret put ACCESS_CLIENT_ID
wrangler secret put ACCESS_CLIENT_SECRET
wrangler secret put ACCESS_AUTHORIZATION_URL
wrangler secret put ACCESS_TOKEN_URL
wrangler secret put ACCESS_JWKS_URL

# Session encryption
wrangler secret put COOKIE_ENCRYPTION_KEY  # 32+ random characters

# Origin service token from Cloudflare Access self-hosted app
wrangler secret put CF_ACCESS_CLIENT_ID
wrangler secret put CF_ACCESS_CLIENT_SECRET
```

## Development

```bash
# Run locally
npm run dev

# Type check
npx tsc --noEmit

# View logs
npm run tail
```

## Deployment

```bash
# Deploy to Cloudflare
npm run deploy

# Deploy specific backend
npm run deploy:paperless
npm run deploy:things
```

## Architecture

See [spec.md](spec.md) for complete architecture documentation and implementation details.

## Routes

- `/mcp` - MCP endpoint (proxied to backend after OAuth)
- `/authorize` - OAuth authorization
- `/callback` - OAuth callback
- `/token` - OAuth token exchange
- `/register` - OAuth dynamic client registration
- `/.well-known/oauth-authorization-server` - OAuth discovery

## Security

- All secrets managed via Wrangler CLI (never in source control)
- Service Auth tokens prevent direct access to origin endpoints
- OAuth required for all MCP access
- Sessions use HttpOnly, Secure, SameSite cookies

## Troubleshooting

See the Troubleshooting Guide section in [spec.md](spec.md) for common issues and solutions.
