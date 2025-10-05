# MCP OAuth Middleware for n8n

A Node.js middleware server that bridges Claude's OAuth requirements with n8n's MCP (Model Context Protocol) server, enabling secure integration between Claude.ai and your n8n workflows.

## ⚠️ Important OAuth Limitation: 
Due to a current bug in Claude's MCP implementation, OAuth tokens are not properly passed to the middleware after authentication. As a workaround, you MUST include your API key in the integration URL as shown below.

## Overview

This middleware provides:
- OAuth 2.0 authentication flow with Keycloak
- Dynamic client registration for Claude
- SSE (Server-Sent Events) streaming support
- Secure proxying of MCP requests to n8n
- API key authentication fallback

## Prerequisites

- Ubuntu server (20.04 or later)
- Domain name pointing to your server's IP address
- Docker and Docker Compose installed
- Node.js 16+ and npm (for manual installation)
- Apache web server for reverse proxy
- Basic understanding of OAuth 2.0 and MCP

## Quick Start

### 1. Domain Setup

You'll need a domain with SSL certificates. All services will run on the same server with different ports:
- `mcp.my-domain.com` → localhost:3000 (MCP middleware)
- `mcp.my-domain.com:8080` → localhost:8080 (Keycloak)
- `mcp.my-domain.com:5678` → localhost:5678 (n8n) (optional if you are not self-hosting n8n)

#### Getting SSL Certificates with Let's Encrypt

Make sure your domain DNS A record points to your server IP.

```bash
# Install certbot and Apache
sudo apt update
sudo apt install certbot python3-certbot-apache apache2

# Enable required Apache modules
sudo a2enmod proxy proxy_http proxy_wstunnel ssl headers rewrite

# Get certificate for your domain
sudo certbot certonly --standalone -d mcp.my-domain.com

# Certificates will be in:
# /etc/letsencrypt/live/mcp.my-domain.com/fullchain.pem
# /etc/letsencrypt/live/mcp.my-domain.com/privkey.pem
```

### 2. Apache Reverse Proxy Setup

1. **Create Apache configuration**:

```bash
sudo nano /etc/apache2/sites-available/mcp-services.conf
```

2. **Add the following configuration**:

```apache
<VirtualHost *:80>
    ServerName mcp.my-domain.com
    
    # Redirect HTTP to HTTPS
    RewriteEngine On
    RewriteCond %{HTTPS} off
    RewriteRule ^(.*)$ https://%{HTTP_HOST}$1 [R=301,L]
</VirtualHost>

<VirtualHost *:443>
    ServerName mcp.my-domain.com
    
    # SSL Configuration
    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/mcp.my-domain.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/mcp.my-domain.com/privkey.pem
    
    # Security Headers
    Header always set X-Content-Type-Options "nosniff"
    Header always set X-Frame-Options "DENY"
    Header always set X-XSS-Protection "1; mode=block"
    
    # Enable WebSocket support
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/?(.*) "ws://localhost:3000/$1" [P,L]
    
    # Proxy to MCP Middleware (default)
    ProxyPreserveHost On
    ProxyPass / http://localhost:3000/
    ProxyPassReverse / http://localhost:3000/
    
    # SSE Support
    ProxyPass /mcp http://localhost:3000/mcp
    ProxyPassReverse /mcp http://localhost:3000/mcp
    ProxyPass /sse http://localhost:3000/sse
    ProxyPassReverse /sse http://localhost:3000/sse
    
    # Disable buffering for SSE
    ProxyPass /mcp http://localhost:3000/mcp flushpackets=on
    
    ErrorLog ${APACHE_LOG_DIR}/mcp-error.log
    CustomLog ${APACHE_LOG_DIR}/mcp-access.log combined
</VirtualHost>

# Keycloak on port 8080
<VirtualHost *:8080>
    ServerName mcp.my-domain.com
    
    # SSL Configuration
    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/mcp.my-domain.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/mcp.my-domain.com/privkey.pem
    
    # Proxy to Keycloak
    ProxyPreserveHost On
    ProxyPass / http://localhost:8081/
    ProxyPassReverse / http://localhost:8081/
    
    # Keycloak specific headers
    RequestHeader set X-Forwarded-Proto "https"
    RequestHeader set X-Forwarded-Port "8080"
    
    ErrorLog ${APACHE_LOG_DIR}/keycloak-error.log
    CustomLog ${APACHE_LOG_DIR}/keycloak-access.log combined
</VirtualHost>

# n8n on port 5678
<VirtualHost *:5678>
    ServerName mcp.my-domain.com
    
    # SSL Configuration
    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/mcp.my-domain.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/mcp.my-domain.com/privkey.pem
    
    # Enable WebSocket support for n8n
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/?(.*) "ws://localhost:5679/$1" [P,L]
    
    # Proxy to n8n
    ProxyPreserveHost On
    ProxyPass / http://localhost:5679/
    ProxyPassReverse / http://localhost:5679/
    
    ErrorLog ${APACHE_LOG_DIR}/n8n-error.log
    CustomLog ${APACHE_LOG_DIR}/n8n-access.log combined
</VirtualHost>
```

3. **Enable the site and required ports**:

```bash
# Enable the site
sudo a2ensite mcp-services.conf

# Enable SSL module
sudo a2enmod ssl

# Add listen ports to Apache
sudo bash -c 'echo "Listen 8080" >> /etc/apache2/ports.conf'
sudo bash -c 'echo "Listen 5678" >> /etc/apache2/ports.conf'

# Test configuration
sudo apache2ctl configtest

# Restart Apache
sudo systemctl restart apache2
```

### 3. Quick Installation with Docker Compose

The fastest way to get everything running is using Docker Compose, which sets up all services at once:

1. **Clone the repository**:
```bash
git clone https://github.com/MaximKabaev/claude-n8n-bridge.git
cd claude-n8n-bridge
```

2. **Configure environment**:
```bash
cp .env-example .env
```
Edit `.env` with your values:

> **Note:** Even though you authenticate via OAuth, the API key in the URL is currently required for the integration to work properly.
```env
# Server Configuration
PORT=3000  # Change to 3001 or another port if 3000 is already in use
PUBLIC_URL=https://mcp.my-domain.com

# Keycloak Configuration
KEYCLOAK_REALM=mcp
KEYCLOAK_SERVER_URL=https://mcp.my-domain.com:8080
KEYCLOAK_CLIENT_ID=mcp-middleware
KEYCLOAK_CLIENT_SECRET=  # Optional for public clients

# n8n Configuration
# For local n8n access only (recommended for security):
N8N_MCP_URL=http://host.docker.internal:5678/webhook/mcp/YOUR_WEBHOOK_ID
# For public n8n access:
# N8N_MCP_URL=https://mcp.my-domain.com:5678/webhook/mcp/YOUR_WEBHOOK_ID
N8N_BEARER_TOKEN=your-n8n-bearer-token  # Optional

# Security
API_KEY=your-secret-api-key
DISABLE_AUTH=false  # Set to true for testing only
```

3. **Build and start all services**:
```bash
# Build the middleware image
docker build -t mcp-oauth-middleware .

# Start all services (Keycloak, n8n, and MCP middleware)
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f
```

4. **Configure services**:
   - **Keycloak**: Access at `https://mcp.my-domain.com:8080`
     - Create a new realm called `mcp`
     - Create a client with ID `mcp-claude` (public client)
     - Set Valid Redirect URIs: `https://claude.ai/api/mcp/auth_callback`
     - Enable "Anonymous access" in Realm Settings → Client Registration
   
   - **n8n**: Access at `https://mcp.my-domain.com:5678`
     - Create a workflow with "MCP Server Trigger" node
     - Configure Bearer token if needed
     - Activate the workflow and copy the webhook URL

5. **Update .env if needed** and restart services:
   ```bash
   docker-compose restart mcp-middleware
   # Or restart all services
   docker-compose down && docker-compose up -d
   ```
   
6. **Skip to section 6** to configure Claude integration.

---

### Alternative: Manual Installation of Individual Services

If you prefer to install services individually instead of using Docker Compose:

#### Keycloak Setup

1. **Install Keycloak** (using Docker with different internal port):
```bash
docker run -d \
  --name keycloak \
  -p 8081:8080 \
  -e KEYCLOAK_ADMIN=admin \
  -e KEYCLOAK_ADMIN_PASSWORD=admin \
  -e KC_PROXY=edge \
  -e KC_HOSTNAME_STRICT=false \
  -e KC_HOSTNAME_URL=https://mcp.my-domain.com:8080 \
  quay.io/keycloak/keycloak:latest \
  start-dev
```

2. **Configure Keycloak** (same as step 4 above)

#### n8n Setup

1. **Install n8n** (using Docker with different internal port):
```bash
docker run -d \
  --name n8n \
  -p 5679:5678 \
  -v ~/.n8n:/home/node/.n8n \
  -e N8N_PROTOCOL=https \
  -e N8N_HOST=mcp.my-domain.com \
  -e N8N_PORT=5678 \
  -e WEBHOOK_URL=https://mcp.my-domain.com:5678 \
  n8nio/n8n
```

2. **Create MCP Workflow** (same as step 4 above)

#### Middleware Installation

**Option A: Docker**
```bash
# Build the Docker image first
docker build -t mcp-oauth-middleware .

# Run the container
# Note: If port 3000 is already in use, change both PORT in .env and the port mapping
# Example: PORT=3001 in .env, then use -p 3001:3001
docker run -d \
  --name mcp-middleware \
  -p 3000:3000 \
  --add-host host.docker.internal:host-gateway \
  --env-file .env \
  --restart unless-stopped \
  mcp-oauth-middleware

# Check logs
docker logs -f mcp-middleware
```

**Important Notes:**
- The `--add-host host.docker.internal:host-gateway` flag is required for the container to access local services like n8n
- If port 3000 is taken, update PORT in `.env` (e.g., `PORT=3001`) and use matching port mapping (e.g., `-p 3001:3001`)
- For debugging, remove `-d` to run in foreground and see logs immediately

**Option B: Manual with PM2**
```bash
# Install dependencies
npm install

# Production with PM2
npm install -g pm2
pm2 start mcp-oauth-middleware.js --name mcp-middleware
pm2 save
pm2 startup
```

### 6. Configure Claude Integration

1. Go to [Claude.ai](https://claude.ai)
2. Navigate to Settings → Integrations
3. Add a new MCP integration:
   - Name: Your Integration Name
   - URL: `https://mcp.my-domain.com?api_key=your-secret-api-key`
4. Click "Connect"
5. You'll be redirected to Keycloak to authenticate
6. After login, the integration will be active

## Testing

### Using MCP Inspector

```bash
npx @modelcontextprotocol/inspector https://mcp.my-domain.com?api_key=your-secret-api-key
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

## Firewall Configuration

If using UFW (Ubuntu Firewall):

```bash
# Allow SSH (if not already allowed)
sudo ufw allow 22/tcp

# Allow HTTP and HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Allow Keycloak
sudo ufw allow 8080/tcp

# Allow n8n
sudo ufw allow 5678/tcp

# Enable firewall
sudo ufw enable
```

## Security Considerations

1. **SSL/TLS**: Always use HTTPS in production (handled by Apache)
2. **Internal Ports**: Services run on different internal ports than external
3. **Token Validation**: The middleware validates all Keycloak tokens
4. **API Key**: Use strong API keys as fallback authentication
5. **CORS**: Configure CORS appropriately for your use case
6. **Firewall**: Only expose necessary ports
7. **Local n8n Access**: For better security, configure n8n to only be accessible locally (via `host.docker.internal`) rather than publicly

## Troubleshooting

### Common Issues

1. **"Failed to connect" in Claude**
   - Check OAuth discovery endpoint is accessible: `curl https://mcp.my-domain.com/.well-known/oauth-authorization-server`
   - Verify Keycloak is running and accessible at `https://mcp.my-domain.com:8080`
   - Check middleware logs: `pm2 logs mcp-middleware`
   - Check Apache logs: `sudo tail -f /var/log/apache2/mcp-error.log`

2. **401 Unauthorized**
   - Verify Bearer token or API key is correct
   - Check Keycloak token validation
   - Ensure client registration is enabled in Keycloak

3. **SSE Connection Fails**
   - Check n8n MCP trigger is active
   - Verify n8n webhook URL is correct
   - Test SSE connection directly with curl
   - Check Apache proxy configuration for SSE support
   - If using local n8n access, ensure `--add-host host.docker.internal:host-gateway` is included in docker run

4. **Port Conflicts**
   - If port 3000 is already in use, change PORT in `.env` to an available port (e.g., 3001)
   - Update the docker run command to match: `-p 3001:3001`
   - Update Apache ProxyPass directives to use the new port

5. **Apache Configuration Issues**
   - Test config: `sudo apache2ctl configtest`
   - Check if all modules are enabled: `sudo a2enmod proxy proxy_http proxy_wstunnel ssl headers rewrite`
   - Verify SSL certificates are valid: `sudo certbot certificates`

### Debug Mode

Enable detailed logging:
```bash
DEBUG=* node mcp-oauth-middleware.js
```

Monitor all logs:
```bash
# Apache logs
sudo tail -f /var/log/apache2/*.log

# PM2 logs
pm2 logs mcp-middleware

# Docker logs
docker logs -f keycloak
docker logs -f n8n
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
