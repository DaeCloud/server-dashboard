const fs = require('fs/promises');
const http = require('http');
const path = require('path');

const DEFAULT_PORT = 3000;
const DEFAULT_DATA_FILE = path.join(__dirname, 'data', 'servers.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

function createApp(options = {}) {
  const dataFile = options.dataFile || process.env.DATA_FILE || DEFAULT_DATA_FILE;

  return async function app(req, res) {
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && requestUrl.pathname === '/api/servers') {
        return sendJson(res, 200, await readServers(dataFile));
      }

      if (req.method === 'POST' && requestUrl.pathname === '/api/servers') {
        const server = validateServer(await readJsonBody(req));
        const servers = await readServers(dataFile);
        const savedServer = {
          id: cryptoRandomId(),
          createdAt: new Date().toISOString(),
          ...server,
        };

        servers.push(savedServer);
        await writeServers(dataFile, servers);
        return sendJson(res, 201, savedServer);
      }

      if (req.method === 'DELETE' && requestUrl.pathname.startsWith('/api/servers/')) {
        const id = decodeURIComponent(requestUrl.pathname.replace('/api/servers/', ''));
        const servers = await readServers(dataFile);
        const nextServers = servers.filter((server) => server.id !== id);

        if (servers.length === nextServers.length) {
          return sendJson(res, 404, { error: 'Server not found.' });
        }

        await writeServers(dataFile, nextServers);
        res.writeHead(204);
        return res.end();
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        return serveStatic(req, res, requestUrl.pathname);
      }

      return sendJson(res, 405, { error: 'Method not allowed.' });
    } catch (error) {
      if (error.statusCode) {
        return sendJson(res, error.statusCode, { error: error.message });
      }

      console.error(error);
      return sendJson(res, 500, { error: 'Something went wrong.' });
    }
  };
}

async function readServers(dataFile = DEFAULT_DATA_FILE) {
  try {
    const content = await fs.readFile(dataFile, 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      await writeServers(dataFile, []);
      return [];
    }
    throw error;
  }
}

async function writeServers(dataFile, servers) {
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  await fs.writeFile(dataFile, `${JSON.stringify(servers, null, 2)}\n`);
}

function validateServer(input) {
  const requiredFields = ['name', 'ipAddress', 'host', 'whoamiUrl'];
  const missingField = requiredFields.find((field) => !String(input?.[field] || '').trim());

  if (missingField) {
    const error = new Error(`${missingField} is required.`);
    error.statusCode = 400;
    throw error;
  }

  let whoamiUrl;
  try {
    whoamiUrl = new URL(input.whoamiUrl);
  } catch (error) {
    const validationError = new Error('whoamiUrl must be a valid URL.');
    validationError.statusCode = 400;
    throw validationError;
  }

  if (!['http:', 'https:'].includes(whoamiUrl.protocol)) {
    const error = new Error('whoamiUrl must use http or https.');
    error.statusCode = 400;
    throw error;
  }

  return {
    name: String(input.name).trim(),
    ipAddress: String(input.ipAddress).trim(),
    host: String(input.host).trim(),
    whoamiUrl: whoamiUrl.toString(),
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 128 * 1024) {
        const error = new Error('Request body is too large.');
        error.statusCode = 413;
        reject(error);
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        const validationError = new Error('Request body must be valid JSON.');
        validationError.statusCode = 400;
        reject(validationError);
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, 'Forbidden', 'text/plain');
  }

  try {
    const content = await fs.readFile(filePath);
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': getContentType(filePath) });
      return res.end();
    }
    return sendText(res, 200, content, getContentType(filePath));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return sendText(res, 404, 'Not found', 'text/plain');
    }
    throw error;
  }
}

function sendJson(res, statusCode, payload) {
  return sendText(res, statusCode, JSON.stringify(payload), 'application/json');
}

function sendText(res, statusCode, content, contentType) {
  res.writeHead(statusCode, { 'Content-Type': contentType });
  res.end(content);
}

function getContentType(filePath) {
  const extension = path.extname(filePath);
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  }[extension] || 'application/octet-stream';
}

function cryptoRandomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

if (require.main === module) {
  const port = process.env.PORT || DEFAULT_PORT;
  http.createServer(createApp()).listen(port, () => {
    console.log(`Server dashboard running at http://localhost:${port}`);
  });
}

module.exports = { createApp, readServers, validateServer, writeServers };
