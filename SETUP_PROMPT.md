# Cloudflare Access Setup Prompt for Chrome Extension

Copy and paste this into Claude Code Chrome extension when you're in the Cloudflare Zero Trust dashboard:

---

I need to set up Cloudflare Access applications for my MCP auth gateway project. I need to create **two Access applications for Paperless MCP**:

## Application 1: SaaS OIDC App (OAuth Provider)
**Purpose**: Provides OAuth authentication for Claude to connect to the public MCP endpoint

**Configuration needed**:
- Application type: Access for SaaS
- Protocol: OIDC
- Application name: "Paperless MCP Gateway OAuth"
- Hostname/Public URL: `paperless-mcp.nickchristensen.house`
- Redirect URL: `https://paperless-mcp.nickchristensen.house/callback`
- Access policy: Allow my email address only

**Information I need to capture** (for wrangler secrets):
- [ ] Client ID
- [ ] Client Secret
- [ ] Authorization endpoint URL
- [ ] Token endpoint URL
- [ ] JWKS (JSON Web Key Set) endpoint URL

## Application 2: Self-Hosted App with Service Auth (Origin Protection)
**Purpose**: Prevents direct access to the origin hostname, ensuring all traffic goes through the OAuth gateway

**Configuration needed**:
- Application type: Self-hosted application
- Application name: "Paperless Origin Service Auth"
- Hostname: `paperless-origin.nickchristensen.house`
- Path: `/*` (protect all paths)
- Create a Service Token for this application
- Access policy: Service Auth only (require the service token)

**Information I need to capture** (for wrangler secrets):
- [ ] Service Token Client ID (for CF_ACCESS_CLIENT_ID)
- [ ] Service Token Client Secret (for CF_ACCESS_CLIENT_SECRET)

---

**Please walk me through the Cloudflare Zero Trust dashboard to create both applications step-by-step**. Guide me through each screen, tell me what values to enter, and help me locate and save all the required configuration values listed above.

When we're done, I need to have captured all 7 pieces of information (5 from App 1, 2 from App 2) that I'll use to configure my Cloudflare Worker.

Context: This is for an OAuth-secured MCP gateway running on Cloudflare Workers. The public endpoint requires OAuth via the SaaS app, and the origin endpoint (accessed via Cloudflare Tunnel from my LAN) is protected by service token headers that only the Worker can provide.
