// mcp-oauth-middleware.js
// A minimal Express server that bridges Claude's OAuth requirements with n8n MCP

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { promisify } = require('util');

const app = express();

// Add VERY early logging middleware - before CORS
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  if (req.body) {
    console.log('Body:', JSON.stringify(req.body, null, 2));
  }
  next();
});

// Enable CORS for all routes - MUST be first!
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200
}));

// Body parser
app.use(express.json());

// Add logging middleware for debugging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url} - Headers:`, req.headers.host);
  next();
});

// Configuration
const config = {
  port: process.env.PORT || 3000,
  publicUrl: process.env.PUBLIC_URL || 'https://mcp.my-domain.com', // Change this to your domain
  keycloak: {
    realm: process.env.KEYCLOAK_REALM || 'mcp',
    serverUrl: process.env.KEYCLOAK_SERVER_URL || 'https://auth.my-domain.com:8080',
    clientId: process.env.KEYCLOAK_CLIENT_ID || 'mcp-middleware',
    clientSecret: process.env.KEYCLOAK_CLIENT_SECRET || '', // Optional for public clients
  },
  n8n: {
    mcpUrl: process.env.N8N_MCP_URL || 'https://n8n.my-domain.com/webhook/mcp/YOUR_WEBHOOK_ID', // Replace with your n8n MCP trigger URL
    bearerToken: process.env.N8N_BEARER_TOKEN || '', // Optional: if n8n MCP trigger requires auth
  }
};

// In-memory storage for dynamic client registrations
const registeredClients = new Map();

// JWKS client for token validation
const jwksUri = `${config.keycloak.serverUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/certs`;
const client = jwksClient({
  jwksUri,
  requestHeaders: {}, // optional
  timeout: 30000, // defaults to 30s
});

const getKey = promisify(client.getSigningKey);

// Verify JWT token from Keycloak
async function verifyToken(token) {
  try {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded) return null;

    const key = await getKey(decoded.header.kid);
    const signingKey = key.getPublicKey();

    const verified = jwt.verify(token, signingKey, {
      algorithms: ['RS256'],
      issuer: `${config.keycloak.serverUrl}/realms/${config.keycloak.realm}`,
    });

    return verified;
  } catch (error) {
    console.error('Token verification failed:', error);
    return null;
  }
}

// OAuth metadata endpoint - try multiple paths
const oauthMetadata = {
  issuer: config.publicUrl,
  authorization_endpoint: `${config.keycloak.serverUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/auth`,
  token_endpoint: `${config.keycloak.serverUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/token`,
  registration_endpoint: `${config.publicUrl}/oauth/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  scopes_supported: ['openid', 'profile', 'email'],
  response_modes_supported: ['query', 'fragment'],
};

// Multiple paths for OAuth discovery
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json(oauthMetadata);
});

app.get('/.well-known/oauth-authorization-server/mcp', (req, res) => {
  res.json(oauthMetadata);
});

// Also support OpenID Connect discovery
app.get('/.well-known/openid-configuration', (req, res) => {
  res.json({
    ...oauthMetadata,
    userinfo_endpoint: `${config.keycloak.serverUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/userinfo`,
    jwks_uri: `${config.keycloak.serverUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/certs`,
  });
});

// Optional: Protected resource metadata (for newer MCP spec)
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// Dynamic client registration endpoint
// Using a pre-created client in Keycloak instead of true dynamic registration
app.post('/oauth/register', async (req, res) => {
  try {
    // Use the pre-created public client in Keycloak
    const clientId = 'mcp-claude';

    // Log the registration request for debugging
    console.log('[REGISTRATION] Client registration request received');
    console.log('[REGISTRATION] Request body:', JSON.stringify(req.body, null, 2));

    // Build the response
    const response = {
      client_id: clientId,
      client_secret: '', // Public client, no secret
      client_secret_expires_at: 0, // Never expires
      redirect_uris: req.body.redirect_uris || ['https://claude.ai/api/mcp/auth_callback'],
      grant_types: req.body.grant_types || ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: req.body.scope || 'openid profile email',
    };

    console.log('[REGISTRATION] Sending registration response:', JSON.stringify(response, null, 2));

    // Send the response with 201 status (created)
    res.status(201).json(response);
  } catch (error) {
    console.error('[REGISTRATION] Client registration failed:', error);
    res.status(500).json({ error: 'registration_failed' });
  }
});

// Main MCP endpoint - handles both root and /mcp paths
app.all(['/', '/mcp'], async (req, res) => {
  console.log(`MCP endpoint hit: ${req.method} ${req.path}`);
  console.log('Authorization header:', req.headers.authorization || 'NONE');

  // Check for authorization (skip if DISABLE_AUTH is set for testing)
  if (process.env.DISABLE_AUTH !== 'true') {
    const authHeader = req.headers.authorization;

    // Check for API key in header or query param
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    const expectedApiKey = process.env.API_KEY || 'your-secret-api-key';

    // Check Bearer token OR API key
    if (authHeader && authHeader.startsWith('Bearer ')) {
      // OAuth flow
      const token = authHeader.substring(7);
      console.log('Token received (first 20 chars):', token.substring(0, 20) + '...');

      const tokenData = await verifyToken(token);

      if (!tokenData) {
        console.log('Invalid token');
        res.set('WWW-Authenticate', 'Bearer realm="MCP", error="invalid_token", error_description="Token invalid or expired"');
        return res.status(401).json({
          error: 'invalid_token',
          error_description: 'Token validation failed'
        });
      }

      console.log('Token verified for user:', tokenData.preferred_username || tokenData.sub);
    } else if (apiKey === expectedApiKey) {
      // API key auth
      console.log('Authenticated via API key');
    } else {
      // No valid auth
      console.log('Unauthorized request - missing bearer token or API key');
      console.log('All headers:', JSON.stringify(req.headers, null, 2));

      res.set('WWW-Authenticate', 'Bearer realm="MCP"');
      return res.status(401).json({
        error: 'unauthorized',
        error_description: 'Missing or invalid authorization. Use Bearer token or API key.',
      });
    }
  }

  // Handle both SSE and Streamable HTTP transports
  if (req.method === 'GET' && req.headers.accept === 'text/event-stream') {
    // SSE transport
    console.log('SSE connection requested');
    try {
      const n8nHeaders = {
        'Accept': 'text/event-stream',
      };

      if (config.n8n.bearerToken) {
        n8nHeaders['Authorization'] = `Bearer ${config.n8n.bearerToken}`;
      }

      const response = await axios({
        method: 'GET',
        url: config.n8n.mcpUrl,
        headers: n8nHeaders,
        responseType: 'stream',
      });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      response.data.on('data', (chunk) => {
        res.write(chunk);
      });

      response.data.on('end', () => {
        res.end();
      });

      response.data.on('error', (error) => {
        console.error('n8n SSE stream error:', error);
        res.end();
      });

      req.on('close', () => {
        response.data.destroy();
      });

    } catch (error) {
      console.error('Failed to establish SSE connection:', error);
      res.status(500).end();
    }
  }
  else if (req.method === 'POST') {
    // Streamable HTTP transport or regular JSON-RPC
    console.log('POST request received');

    // Check if this is a streaming request
    const acceptsEventStream = req.headers.accept && req.headers.accept.includes('text/event-stream');

    // Claude might be trying to initialize with POST first
    // If it gets an error, it falls back to GET
    if (acceptsEventStream && !req.query.sessionId) {
      // This is likely an initialization attempt, redirect to GET
      console.log('POST with event-stream accept header, returning 405 to trigger GET');
      return res.status(405).json({
        error: 'method_not_allowed',
        message: 'Use GET for SSE connection'
      });
    }

    try {
      const sessionId = req.query.sessionId;
      let n8nUrl = config.n8n.mcpUrl;

      if (sessionId) {
        n8nUrl = n8nUrl.replace('/sse', `/messages?sessionId=${sessionId}`);
      }

      const n8nHeaders = {
        'Content-Type': 'application/json',
      };

      if (acceptsEventStream) {
        n8nHeaders['Accept'] = 'text/event-stream';
      }

      if (config.n8n.bearerToken) {
        n8nHeaders['Authorization'] = `Bearer ${config.n8n.bearerToken}`;
      }

      console.log(`Forwarding POST to n8n: ${n8nUrl}`);

      const response = await axios({
        method: 'POST',
        url: n8nUrl,
        data: req.body,
        headers: n8nHeaders,
        responseType: acceptsEventStream ? 'stream' : 'json',
      });

      if (acceptsEventStream && response.headers['content-type']?.includes('text/event-stream')) {
        // Stream the response
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        response.data.pipe(res);
      } else {
        // Regular JSON response
        res.json(response.data);
      }
    } catch (error) {
      console.error('Failed to proxy to n8n:', error.message);
      if (error.response) {
        console.error('n8n response:', error.response.status, error.response.data);
      }

      // If we get a 404 and it's an event-stream request, return 405 to trigger GET
      if (error.response?.status === 404 && req.headers.accept?.includes('text/event-stream')) {
        return res.status(405).json({
          error: 'method_not_allowed',
          message: 'Use GET for SSE connection'
        });
      }

      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal error',
          data: error.message
        },
        id: req.body?.id || null
      });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
});

// Handle the /mcp/messages endpoint that n8n uses
app.post('/mcp/messages', async (req, res) => {
  // Forward to n8n with the session ID
  const sessionId = req.query.sessionId;
  const n8nUrl = config.n8n.mcpUrl.replace('/sse', `/messages?sessionId=${sessionId}`);

  try {
    const n8nHeaders = {
      'Content-Type': 'application/json',
    };

    if (config.n8n.bearerToken) {
      n8nHeaders['Authorization'] = `Bearer ${config.n8n.bearerToken}`;
    }

    console.log(`Forwarding messages POST to n8n: ${n8nUrl}`);

    const response = await axios({
      method: 'POST',
      url: n8nUrl,
      data: req.body,
      headers: n8nHeaders,
    });

    res.json(response.data);
  } catch (error) {
    console.error('Failed to proxy messages to n8n:', error.message);
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Internal error',
        data: error.message
      },
      id: req.body?.id || null
    });
  }
});

// Handle any path under /mcp/* for n8n's dynamic endpoints
app.all('/mcp/*', async (req, res) => {
  const path = req.path; // e.g., /mcp/test/messages
  const n8nPath = path.replace('/mcp', ''); // Remove /mcp prefix
  const baseUrl = new URL(config.n8n.mcpUrl);
  const n8nUrl = `${baseUrl.protocol}//${baseUrl.host}/mcp${n8nPath}${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;

  console.log(`Forwarding ${req.method} ${path} to n8n: ${n8nUrl}`);

  try {
    const n8nHeaders = {
      ...req.headers,
      host: baseUrl.host, // Override host header
    };

    delete n8nHeaders['content-length']; // Let axios recalculate

    if (config.n8n.bearerToken) {
      n8nHeaders['Authorization'] = `Bearer ${config.n8n.bearerToken}`;
    }

    const response = await axios({
      method: req.method,
      url: n8nUrl,
      data: req.body,
      headers: n8nHeaders,
      responseType: req.headers.accept === 'text/event-stream' ? 'stream' : 'json',
    });

    if (req.headers.accept === 'text/event-stream') {
      // Set SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Pipe the stream
      response.data.pipe(res);
    } else {
      res.status(response.status).json(response.data);
    }
  } catch (error) {
    console.error('Failed to proxy to n8n:', error.message);
    if (error.response) {
      console.error('n8n response:', error.response.status, error.response.data);
    }
    res.status(error.response?.status || 500).json({
      error: error.response?.data || error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test endpoint for debugging
app.get('/test', (req, res) => {
  res.json({
    message: 'MCP OAuth Middleware is running',
    endpoints: {
      oauth_metadata: '/.well-known/oauth-authorization-server',
      registration: '/oauth/register',
      mcp: '/mcp'
    }
  });
});

// Catch-all for any unhandled routes
app.all('*', (req, res) => {
  console.log(`Unhandled route: ${req.method} ${req.url}`);
  console.log('Headers:', req.headers);
  res.status(404).json({
    error: 'not_found',
    message: `Route ${req.url} not found`,
    available_endpoints: [
      '/.well-known/oauth-authorization-server',
      '/oauth/register',
      '/mcp',
      '/health'
    ]
  });
});

// Start server
app.listen(config.port, () => {
  console.log(`MCP OAuth Middleware running on port ${config.port}`);
  console.log(`Public URL: ${config.publicUrl}`);
  console.log(`Keycloak URL: ${config.keycloak.serverUrl}`);
  console.log(`n8n MCP URL: ${config.n8n.mcpUrl}`);
});