const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 3000;
const DEFAULT_DATA_FILE = path.join(__dirname, 'data', 'servers.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_WHOAMI_PATH = '/whoami';
const SELF_SERVER_ID = 'self';

function createApp(options = {}) {
  const dataFile = options.dataFile || process.env.DATA_FILE || DEFAULT_DATA_FILE;
  const mode = normalizeMode(options.mode || process.env.APP_MODE || process.env.SERVICE_MODE || 'dashboard');
  const whoamiPath = normalizePath(options.whoamiPath || process.env.WHOAMI_PATH || DEFAULT_WHOAMI_PATH);
  const registerSelf = mode === 'dashboard' && toBoolean(options.registerSelf ?? process.env.REGISTER_SELF, true);

  return async function app(req, res) {
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (requestUrl.pathname === whoamiPath) {
        if (req.method === 'OPTIONS') return sendWhoamiOptions(res);
        if (req.method === 'GET' || req.method === 'HEAD') {
          const details = await getWhoamiDetails({ mode, whoamiPath });
          return sendJson(res, 200, details, whoamiHeaders());
        }
        return sendJson(res, 405, { error: 'Method not allowed.' }, whoamiHeaders());
      }

      if (mode === 'whoami') {
        if (req.method === 'GET' && requestUrl.pathname === '/') {
          return sendJson(res, 200, {
            service: 'server-dashboard whoami',
            whoamiUrl: new URL(whoamiPath, requestUrl.origin).toString(),
          });
        }
        return sendJson(res, 404, { error: `Not found. This container is running in whoami mode; use ${whoamiPath}.` });
      }

      if (req.method === 'GET' && requestUrl.pathname === '/api/servers') {
        return sendJson(res, 200, await readServers(dataFile, { registerSelf, requestUrl, whoamiPath }));
      }

      if (req.method === 'POST' && requestUrl.pathname === '/api/servers') {
        const server = validateServer(await readJsonBody(req));
        const servers = await readServers(dataFile, { registerSelf, requestUrl, whoamiPath });
        const savedServer = {
          id: cryptoRandomId(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...server,
        };

        servers.push(savedServer);
        await writeServers(dataFile, servers);
        return sendJson(res, 201, savedServer);
      }

      if ((req.method === 'PUT' || req.method === 'PATCH') && requestUrl.pathname.startsWith('/api/servers/')) {
        const id = decodeURIComponent(requestUrl.pathname.replace('/api/servers/', ''));
        const updates = validateServer(await readJsonBody(req));
        const servers = await readServers(dataFile, { registerSelf, requestUrl, whoamiPath });
        const index = servers.findIndex((server) => server.id === id);

        if (index === -1) {
          return sendJson(res, 404, { error: 'Server not found.' });
        }

        const updatedServer = {
          ...servers[index],
          ...updates,
          updatedAt: new Date().toISOString(),
        };
        servers[index] = updatedServer;
        await writeServers(dataFile, servers);
        return sendJson(res, 200, updatedServer);
      }

      if (req.method === 'DELETE' && requestUrl.pathname.startsWith('/api/servers/')) {
        const id = decodeURIComponent(requestUrl.pathname.replace('/api/servers/', ''));
        const servers = await readServers(dataFile, { registerSelf, requestUrl, whoamiPath });
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

async function readServers(dataFile = DEFAULT_DATA_FILE, options = {}) {
  try {
    const content = await fs.readFile(dataFile, 'utf8');
    const parsed = JSON.parse(content);
    const servers = Array.isArray(parsed) ? parsed : [];
    return maybeAddSelfServer(dataFile, servers, options);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const servers = await maybeAddSelfServer(dataFile, [], options);
      await writeServers(dataFile, servers);
      return servers;
    }
    throw error;
  }
}

async function maybeAddSelfServer(dataFile, servers, options = {}) {
  if (!options.registerSelf || servers.some((server) => server.id === SELF_SERVER_ID)) return servers;

  const selfServer = buildSelfServer(options.requestUrl, options.whoamiPath);
  const nextServers = [selfServer, ...servers];
  await writeServers(dataFile, nextServers);
  return nextServers;
}

function buildSelfServer(requestUrl, whoamiPath = DEFAULT_WHOAMI_PATH) {
  const origin = getEnv('SELF_ORIGIN', 'DASHBOARD_ORIGIN') || requestUrl?.origin || `http://localhost:${process.env.PORT || DEFAULT_PORT}`;
  const whoamiUrl = getEnv('SELF_WHOAMI_URL', 'WHOAMI_URL') || new URL(whoamiPath, origin).toString();

  return {
    id: SELF_SERVER_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isSelf: true,
    name: getEnv('SELF_NAME', 'SERVER_NAME', 'WHOAMI_NAME') || os.hostname(),
    ipAddress: getEnv('SELF_IP_ADDRESS', 'WHOAMI_IP_ADDRESS') || firstPrivateAddress() || '127.0.0.1',
    host: getEnv('SELF_HOST', 'WHOAMI_HOST') || os.hostname(),
    whoamiUrl,
  };
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

async function getWhoamiDetails(options = {}) {
  const cpus = os.cpus();
  const memoryBytes = os.totalmem();
  const storage = await getStorageDetails(getEnv('WHOAMI_STORAGE_PATH') || '/');
  const hostname = getEnv('WHOAMI_HOST', 'SELF_HOST') || os.hostname();

  const operatingSystem = `${os.type()} ${os.release()}`;

  return {
    service: 'server-dashboard whoami',
    mode: options.mode || 'dashboard',
    name: getEnv('WHOAMI_NAME', 'SELF_NAME', 'SERVER_NAME') || hostname,
    host: hostname,
    hostname,
    ipAddress: getEnv('WHOAMI_IP_ADDRESS', 'SELF_IP_ADDRESS') || firstPrivateAddress() || '127.0.0.1',
    os: operatingSystem,
    platform: os.platform(),
    arch: os.arch(),
    cpus: cpus.length,
    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model || 'Unknown CPU',
    },
    system: {
      os: operatingSystem,
      platform: os.platform(),
      arch: os.arch(),
      cpus: cpus.length,
    },
    memoryGb: bytesToGigabytes(memoryBytes),
    memory: {
      total: memoryBytes,
      free: os.freemem(),
      unit: 'bytes',
    },
    storageGb: storage.totalGb,
    storage,
    uptimeSeconds: Math.floor(os.uptime()),
    timestamp: new Date().toISOString(),
  };
}

async function getStorageDetails(storagePath) {
  try {
    const stats = await fs.statfs(storagePath);
    const total = stats.blocks * stats.bsize;
    const free = stats.bfree * stats.bsize;
    return {
      path: storagePath,
      total,
      free,
      unit: 'bytes',
      totalGb: bytesToGigabytes(total),
      freeGb: bytesToGigabytes(free),
    };
  } catch (error) {
    return {
      path: storagePath,
      total: 0,
      free: 0,
      unit: 'bytes',
      totalGb: 0,
      freeGb: 0,
      error: error.message,
    };
  }
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

function sendJson(res, statusCode, payload, headers = {}) {
  return sendText(res, statusCode, JSON.stringify(payload), 'application/json', headers);
}

function sendText(res, statusCode, content, contentType, headers = {}) {
  res.writeHead(statusCode, { 'Content-Type': contentType, ...headers });
  res.end(content);
}

function sendWhoamiOptions(res) {
  res.writeHead(204, {
    ...whoamiHeaders(),
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  });
  res.end();
}

function whoamiHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };
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

function normalizeMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (['dashboard', 'whoami'].includes(normalized)) return normalized;
  return 'dashboard';
}

function normalizePath(input) {
  const value = String(input || DEFAULT_WHOAMI_PATH).trim();
  return value.startsWith('/') ? value : `/${value}`;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function getEnv(...names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return '';
}

function firstPrivateAddress() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return '';
}

function bytesToGigabytes(bytes) {
  return Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10;
}

function cryptoRandomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

if (require.main === module) {
  const port = process.env.PORT || DEFAULT_PORT;
  const mode = normalizeMode(process.env.APP_MODE || process.env.SERVICE_MODE || 'dashboard');
  const whoamiPath = normalizePath(process.env.WHOAMI_PATH || DEFAULT_WHOAMI_PATH);
  http.createServer(createApp()).listen(port, () => {
    console.log(`Server dashboard running in ${mode} mode at http://localhost:${port}`);
    console.log(`Whoami endpoint available at http://localhost:${port}${whoamiPath}`);
  });
}

module.exports = {
  SELF_SERVER_ID,
  buildSelfServer,
  createApp,
  getWhoamiDetails,
  readServers,
  validateServer,
  writeServers,
};
