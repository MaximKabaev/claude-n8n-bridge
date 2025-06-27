# MCP OAuth Middleware for n8n

A Node.js middleware server that bridges Claude's OAuth requirements with n8n's MCP (Model Context Protocol) server, enabling secure integration between Claude.ai and your n8n workflows.

## Overview

This middleware provides:
- OAuth 2.0 authentication flow with Keycloak
- Dynamic client registration for Claude
- SSE (Server-Sent Events) streaming support
- Secure proxying of MCP requests to n8n
- API key authentication fallback

## Architecture

```
Claude.ai → MCP Middleware → Keycloak (Auth)
                           ↓
                         n8n MCP Server
```

## Prerequisites

- Node.js 16+ and npm
- Self-hosted n8n instance with MCP Server Trigger
- Self-hosted Keycloak instance
- Domain name with SSL certificates
- Basic understanding of OAuth 2.0 and MCP

## Quick Start

### 1. Domain Setup

You'll need a domain with SSL certificates. Example structure:
- `mcp.my-domain.com` - MCP middleware
- `auth.my-domain.com` - Keycloak
- `n8n.my-domain.com` - n8n instance

#### Getting SSL Certificates with Let's Encrypt

```bash
# Install certbot
sudo apt update
sudo apt install certbot

# Get certificate for your domain
sudo certbot certonly --standalone -d mcp.my-domain.com

# Certificates will be in:
# /etc/letsencrypt/live/mcp.my-domain.com/fullchain.pem
# /etc/letsencrypt/live/mcp.my-domain.com/privkey.pem
```

### 2. Keycloak Setup

1. **Install Keycloak** (using Docker):
```bash
docker run -d \
  --name keycloak \
  -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin \
  -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:latest \
  start-dev
```

2. **Configure Keycloak**:
   - Access Keycloak at `https://auth.my-domain.com:8080`
   - Create a new realm called `mcp`
   - Create a client:
     - Client ID: `mcp-claude`
     - Client Protocol: `openid-connect`
     - Access Type: `public`
     - Valid Redirect URIs: `https://claude.ai/api/mcp/auth_callback`
     - Web Origins: `*`

3. **Enable Dynamic Client Registration**:
   - Go to Realm Settings → Client Registration
   - Enable "Anonymous access"
   - Or create an Initial Access Token for controlled registration

### 3. n8n Setup

1. **Install n8n** (using Docker):
```bash
docker run -d \
  --name n8n \
  -p 5678:5678 \
  -v ~/.n8n:/home/node/.n8n \
  n8nio/n8n
```

2. **Create MCP Workflow**:
   - Create a new workflow in n8n
   - Add "MCP Server Trigger" node
   - Configure authentication (optional):
     - Type: Bearer Token
     - Token: `your-n8n-bearer-token`
   - Add your tools/workflows
   - Activate the workflow
   - Copy the webhook URL (e.g., `https://n8n.my-domain.com/webhook/mcp/YOUR_ID`)

### 4. Middleware Installation

1. **Clone and install**:
```bash
git clone https://github.com/yourusername/mcp-oauth-middleware.git
cd mcp-oauth-middleware
npm install
```

2. **Configure environment**:
```bash
cp .env.example .env
```

Edit `.env` with your values:
```env
# Server Configuration
PORT=3000
PUBLIC_URL=https://mcp.my-domain.com

# Keycloak Configuration
KEYCLOAK_REALM=mcp
KEYCLOAK_SERVER_URL=https://auth.my-domain.com:8080
KEYCLOAK_CLIENT_ID=mcp-middleware
KEYCLOAK_CLIENT_SECRET=  # Optional for public clients

# n8n Configuration
N8N_MCP_URL=https://n8n.my-domain.com/webhook/mcp/YOUR_WEBHOOK_ID
N8N_BEARER_TOKEN=your-n8n-bearer-token  # Optional

# Security
API_KEY=your-secret-api-key
DISABLE_AUTH=false  # Set to true for testing only
```

3. **Run the middleware**:
```bash
# Development
npm run dev

# Production with PM2
npm install -g pm2
pm2 start mcp-oauth-middleware.js --name mcp-middleware
pm2 save
pm2 startup
```

### 5. Configure Claude Integration

1. Go to [Claude.ai](https://claude.ai)
2. Navigate to Settings → Integrations
3. Add a new MCP integration:
   - Name: Your Integration Name
   - URL: `https://mcp.my-domain.com`
4. Click "Connect"
5. You'll be redirected to Keycloak to authenticate
6. After login, the integration will be active

## Testing

### Using MCP Inspector

```bash
npx @modelcontextprotocol/inspector https://mcp.my-domain.com
```

### Testing OAuth Flow

```bash
# Check OAuth discovery
curl https://mcp.my-domain.com/.well-known/oauth-authorization-server

# Test with API key
curl -H "X-API-Key: your-secret-api-key" https://mcp.my-domain.com/health
```

### Testing SSE Connection

```bash
# With API key
curl -H "X-API-Key: your-secret-api-key" \
     -H "Accept: text/event-stream" \
     https://mcp.my-domain.com/mcp
```

## Security Considerations

1. **SSL/TLS**: Always use HTTPS in production
2. **Firewall**: Restrict n8n access to only the middleware server
3. **Token Validation**: The middleware validates all Keycloak tokens
4. **API Key**: Use strong API keys as fallback authentication
5. **CORS**: Configure CORS appropriately for your use case

## Troubleshooting

### Common Issues

1. **"Failed to connect" in Claude**
   - Check OAuth discovery endpoint is accessible
   - Verify Keycloak is running and configured correctly
   - Check middleware logs for errors

2. **401 Unauthorized**
   - Verify Bearer token or API key is correct
   - Check Keycloak token validation
   - Ensure client registration is enabled

3. **SSE Connection Fails**
   - Check n8n MCP trigger is active
   - Verify n8n webhook URL is correct
   - Test SSE connection directly with curl

### Debug Mode

Enable detailed logging:
```bash
DEBUG=* node mcp-oauth-middleware.js
```

## API Endpoints

- `GET /.well-known/oauth-authorization-server` - OAuth metadata
- `POST /oauth/register` - Dynamic client registration
- `GET /mcp` - SSE connection (with auth)
- `POST /mcp` - JSON-RPC requests (with auth)
- `GET /health` - Health check

## Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| PORT | Server port | No | 3000 |
| PUBLIC_URL | Public URL of middleware | Yes | - |
| KEYCLOAK_REALM | Keycloak realm name | Yes | - |
| KEYCLOAK_SERVER_URL | Keycloak server URL | Yes | - |
| KEYCLOAK_CLIENT_ID | Keycloak client ID | No | mcp-middleware |
| KEYCLOAK_CLIENT_SECRET | Keycloak client secret | No | - |
| N8N_MCP_URL | n8n MCP webhook URL | Yes | - |
| N8N_BEARER_TOKEN | n8n bearer token | No | - |
| API_KEY | API key for fallback auth | No | - |
| DISABLE_AUTH | Disable authentication | No | false |

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

MIT License - see LICENSE file for details

## Acknowledgments

- [Anthropic](https://anthropic.com) for Claude and MCP
- [n8n](https://n8n.io) for workflow automation
- [Keycloak](https://www.keycloak.org) for authentication
