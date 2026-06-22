const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 3000;
const DEFAULT_DATA_FILE = path.join(__dirname, 'data', 'servers.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_WHOAMI_PATH = '/whoami';
const DEFAULT_DOCKER_PATH = '/docker';
const DEFAULT_DOCKER_SOCKET_PATH = '/var/run/docker.sock';
const SELF_SERVER_ID = 'self';

function createApp(options = {}) {
  const dataFile = options.dataFile || process.env.DATA_FILE || DEFAULT_DATA_FILE;
  const mode = normalizeMode(options.mode || process.env.APP_MODE || process.env.SERVICE_MODE || 'dashboard');
  const whoamiPath = normalizePath(options.whoamiPath || process.env.WHOAMI_PATH || DEFAULT_WHOAMI_PATH);
  const dockerPath = normalizePath(options.dockerPath || process.env.DOCKER_PATH || DEFAULT_DOCKER_PATH).replace(/\/$/, '');
  const dockerSocketPath = options.dockerSocketPath || process.env.DOCKER_SOCKET_PATH || DEFAULT_DOCKER_SOCKET_PATH;
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

      const dockerResource = getDockerResource(requestUrl.pathname, dockerPath);
      if (dockerResource) {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' }, dockerHeaders());
        const payload = dockerResource === 'summary'
          ? await getDockerSummary({ socketPath: dockerSocketPath })
          : await getDockerContainers({ socketPath: dockerSocketPath });
        return sendJson(res, 200, payload, dockerHeaders());
      }

      if (mode === 'whoami') {
        if (req.method === 'GET' && requestUrl.pathname === '/') {
          return sendJson(res, 200, {
            service: 'server-dashboard whoami',
            whoamiUrl: new URL(whoamiPath, requestUrl.origin).toString(),
            dockerSummaryUrl: new URL(`${dockerPath}/summary`, requestUrl.origin).toString(),
            dockerContainersUrl: new URL(`${dockerPath}/containers`, requestUrl.origin).toString(),
          });
        }
        return sendJson(res, 404, { error: `Not found. This container is running in whoami mode; use ${whoamiPath}.` });
      }

      if (req.method === 'GET' && requestUrl.pathname === '/api/servers') {
        return sendJson(res, 200, await readServers(dataFile, { registerSelf, requestUrl, whoamiPath, dockerPath }));
      }

      if (req.method === 'GET' && requestUrl.pathname.startsWith('/api/servers/') && requestUrl.pathname.endsWith('/whoami')) {
        const id = getServerIdFromNestedPath(requestUrl.pathname, '/whoami');
        const servers = await readServers(dataFile, { registerSelf, requestUrl, whoamiPath, dockerPath });
        const server = servers.find((candidate) => candidate.id === id);

        if (!server) {
          return sendJson(res, 404, { error: 'Server not found.' });
        }

        const details = await resolveWhoamiDetails(server, { mode, whoamiPath });
        return sendJson(res, 200, details);
      }

      const dockerProxyMatch = requestUrl.pathname.match(/^\/api\/servers\/(.+)\/docker\/(summary|containers)$/);
      if (req.method === 'GET' && dockerProxyMatch) {
        const id = decodeURIComponent(dockerProxyMatch[1]);
        const resource = dockerProxyMatch[2];
        const servers = await readServers(dataFile, { registerSelf, requestUrl, whoamiPath, dockerPath });
        const server = servers.find((candidate) => candidate.id === id);

        if (!server) return sendJson(res, 404, { error: 'Server not found.' });

        const payload = await resolveDockerDetails(server, resource, { socketPath: dockerSocketPath });
        return sendJson(res, 200, payload);
      }

      if (req.method === 'POST' && requestUrl.pathname === '/api/servers') {
        const server = validateServer(await readJsonBody(req));
        const servers = await readServers(dataFile, { registerSelf, requestUrl, whoamiPath, dockerPath });
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
        const servers = await readServers(dataFile, { registerSelf, requestUrl, whoamiPath, dockerPath });
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
        const servers = await readServers(dataFile, { registerSelf, requestUrl, whoamiPath, dockerPath });
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
        return sendJson(res, error.statusCode, { error: error.message, ...(error.code ? { code: error.code } : {}) });
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

  const selfServer = buildSelfServer(options.requestUrl, options.whoamiPath, options.dockerPath);
  const nextServers = [selfServer, ...servers];
  await writeServers(dataFile, nextServers);
  return nextServers;
}

function buildSelfServer(requestUrl, whoamiPath = DEFAULT_WHOAMI_PATH, dockerPath = DEFAULT_DOCKER_PATH) {
  const origin = getEnv('SELF_ORIGIN', 'DASHBOARD_ORIGIN') || requestUrl?.origin || `http://localhost:${process.env.PORT || DEFAULT_PORT}`;
  const whoamiUrl = getEnv('SELF_WHOAMI_URL', 'WHOAMI_URL') || new URL(whoamiPath, origin).toString();
  const dockerBaseUrl = getEnv('SELF_DOCKER_BASE_URL') || new URL(dockerPath, origin).toString();

  return {
    id: SELF_SERVER_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isSelf: true,
    name: getEnv('SELF_NAME', 'SERVER_NAME', 'WHOAMI_NAME') || os.hostname(),
    ipAddress: getEnv('SELF_IP_ADDRESS', 'WHOAMI_IP_ADDRESS') || firstPrivateAddress() || '127.0.0.1',
    host: getEnv('SELF_HOST', 'WHOAMI_HOST') || os.hostname(),
    whoamiUrl,
    dockerBaseUrl,
    whoamiUsername: getEnv('SELF_WHOAMI_USERNAME', 'WHOAMI_USERNAME'),
    whoamiPassword: getEnv('SELF_WHOAMI_PASSWORD', 'WHOAMI_PASSWORD'),
  };
}

async function writeServers(dataFile, servers) {
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  await fs.writeFile(dataFile, `${JSON.stringify(servers, null, 2)}\n`);
}

function getServerIdFromNestedPath(pathname, suffix) {
  return decodeURIComponent(pathname.slice('/api/servers/'.length, -suffix.length));
}

async function resolveWhoamiDetails(server, options = {}) {
  if (isSelfServer(server)) {
    return getWhoamiDetails(options);
  }

  return fetchWhoamiDetails(server);
}

function isSelfServer(server) {
  return server?.id === SELF_SERVER_ID || server?.isSelf === true;
}

async function fetchWhoamiDetails(server) {
  let response;
  try {
    response = await fetch(server.whoamiUrl, {
      cache: 'no-store',
      headers: whoamiAuthHeaders(server),
    });
  } catch (error) {
    const fetchError = new Error(`Unable to reach whoami endpoint: ${error.message}`);
    fetchError.statusCode = 502;
    throw fetchError;
  }

  if (!response.ok) {
    const error = new Error(`Whoami endpoint returned HTTP ${response.status}.`);
    error.statusCode = 502;
    throw error;
  }

  try {
    return await response.json();
  } catch (error) {
    const parseError = new Error('Whoami endpoint did not return valid JSON.');
    parseError.statusCode = 502;
    throw parseError;
  }
}

function whoamiAuthHeaders(server) {
  if (!server.whoamiUsername && !server.whoamiPassword) return {};

  return {
    Authorization: `Basic ${Buffer.from(`${server.whoamiUsername || ''}:${server.whoamiPassword || ''}`).toString('base64')}`,
  };
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

  let dockerBaseUrl = '';
  if (String(input.dockerBaseUrl || '').trim()) {
    try {
      const parsed = new URL(input.dockerBaseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
      dockerBaseUrl = parsed.toString().replace(/\/$/, '');
    } catch (error) {
      const validationError = new Error('dockerBaseUrl must be a valid http or https URL.');
      validationError.statusCode = 400;
      throw validationError;
    }
  }

  return {
    name: String(input.name).trim(),
    ipAddress: String(input.ipAddress).trim(),
    host: String(input.host).trim(),
    whoamiUrl: whoamiUrl.toString(),
    dockerBaseUrl,
    whoamiUsername: String(input.whoamiUsername || '').trim(),
    whoamiPassword: String(input.whoamiPassword || ''),
  };
}

function getDockerResource(pathname, dockerPath) {
  if (pathname === `${dockerPath}/summary`) return 'summary';
  if (pathname === `${dockerPath}/containers`) return 'containers';
  return '';
}

async function resolveDockerDetails(server, resource, options = {}) {
  if (isSelfServer(server)) {
    return resource === 'summary' ? getDockerSummary(options) : getDockerContainers(options);
  }

  const baseUrl = server.dockerBaseUrl || deriveDockerBaseUrl(server.whoamiUrl);
  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/${resource}`, {
      cache: 'no-store',
      headers: whoamiAuthHeaders(server),
    });
  } catch (error) {
    const fetchError = new Error(`Unable to reach Docker endpoint: ${error.message}`);
    fetchError.statusCode = 502;
    fetchError.code = 'docker_upstream_unavailable';
    throw fetchError;
  }

  if (!response.ok) {
    const error = new Error(`Docker endpoint returned HTTP ${response.status}.`);
    error.statusCode = 502;
    error.code = 'docker_upstream_unavailable';
    throw error;
  }

  try {
    return await response.json();
  } catch (error) {
    const parseError = new Error('Docker endpoint did not return valid JSON.');
    parseError.statusCode = 502;
    parseError.code = 'docker_upstream_invalid_response';
    throw parseError;
  }
}

function deriveDockerBaseUrl(whoamiUrl) {
  return new URL(DEFAULT_DOCKER_PATH, whoamiUrl).toString().replace(/\/$/, '');
}

async function getDockerSummary(options = {}) {
  const socketPath = options.socketPath || DEFAULT_DOCKER_SOCKET_PATH;
  const [version, info, rawContainers, images, volumes] = await Promise.all([
    dockerRequest('/version', socketPath),
    dockerRequest('/info', socketPath),
    dockerRequest('/containers/json?all=1', socketPath),
    dockerRequest('/images/json', socketPath),
    dockerRequest('/volumes', socketPath),
  ]);
  const containers = ensureArray(rawContainers, 'containers');
  const normalized = containers.map(normalizeDockerContainer);
  const states = normalized.reduce((counts, container) => {
    const state = container.state || 'unknown';
    counts[state] = (counts[state] || 0) + 1;
    return counts;
  }, {});
  const health = normalized.reduce((counts, container) => {
    if (container.health) counts[container.health] = (counts[container.health] || 0) + 1;
    return counts;
  }, { healthy: 0, unhealthy: 0, starting: 0 });
  const projects = new Set(normalized.map((container) => container.composeProject).filter(Boolean));

  return {
    available: true,
    engine: {
      name: info.Name || '',
      version: version.Version || '',
      apiVersion: version.ApiVersion || '',
      os: info.OperatingSystem || '',
      architecture: info.Architecture || '',
    },
    resources: {
      cpus: Number(info.NCPU) || 0,
      memoryBytes: Number(info.MemTotal) || 0,
    },
    containers: {
      total: normalized.length,
      running: states.running || 0,
      paused: states.paused || 0,
      stopped: normalized.length - (states.running || 0) - (states.paused || 0),
      states,
      health,
    },
    stacks: projects.size,
    standaloneContainers: normalized.filter((container) => !container.composeProject).length,
    images: ensureArray(images, 'images').length,
    volumes: ensureArray(volumes?.Volumes || [], 'volumes').length,
    timestamp: new Date().toISOString(),
  };
}

async function getDockerContainers(options = {}) {
  const rawContainers = await dockerRequest('/containers/json?all=1', options.socketPath || DEFAULT_DOCKER_SOCKET_PATH);
  return {
    containers: ensureArray(rawContainers, 'containers').map(normalizeDockerContainer),
    timestamp: new Date().toISOString(),
  };
}

function normalizeDockerContainer(container) {
  const labels = container.Labels || {};
  const statusText = String(container.Status || '');
  const health = statusText.match(/\((healthy|unhealthy|starting)\)/i)?.[1]?.toLowerCase() || '';
  const names = ensureArray(container.Names || [], 'container names').map((name) => String(name).replace(/^\//, ''));

  return {
    id: String(container.Id || ''),
    shortId: String(container.Id || '').slice(0, 12),
    name: names[0] || String(container.Id || '').slice(0, 12),
    names,
    image: String(container.Image || ''),
    imageId: String(container.ImageID || ''),
    state: String(container.State || 'unknown').toLowerCase(),
    health,
    status: statusText,
    createdAt: container.Created ? new Date(Number(container.Created) * 1000).toISOString() : '',
    ports: ensureArray(container.Ports || [], 'container ports').map((port) => ({
      ip: port.IP || '',
      private: Number(port.PrivatePort) || 0,
      public: Number(port.PublicPort) || 0,
      type: port.Type || '',
    })),
    composeProject: String(labels['com.docker.compose.project'] || ''),
  };
}

function ensureArray(value, label) {
  if (Array.isArray(value)) return value;
  const error = new Error(`Docker returned an invalid ${label} response.`);
  error.statusCode = 503;
  error.code = 'docker_invalid_response';
  throw error;
}

function dockerRequest(requestPath, socketPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: requestPath, method: 'GET' }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(`Docker Engine returned HTTP ${response.statusCode}.`);
          error.statusCode = 503;
          error.code = 'docker_unavailable';
          return reject(error);
        }
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (parseError) {
          const error = new Error('Docker Engine returned invalid JSON.');
          error.statusCode = 503;
          error.code = 'docker_invalid_response';
          reject(error);
        }
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('Docker Engine request timed out.')));
    request.on('error', (cause) => {
      const error = new Error(`Docker Engine is unavailable: ${cause.message}`);
      error.statusCode = 503;
      error.code = 'docker_unavailable';
      reject(error);
    });
    request.end();
  });
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
    const used = Math.max(total - free, 0);
    return {
      path: storagePath,
      total,
      free,
      used,
      unit: 'bytes',
      totalGb: bytesToGigabytes(total),
      freeGb: bytesToGigabytes(free),
      usedGb: bytesToGigabytes(used),
      usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    };
  } catch (error) {
    return {
      path: storagePath,
      total: 0,
      free: 0,
      used: 0,
      unit: 'bytes',
      totalGb: 0,
      freeGb: 0,
      usedGb: 0,
      usedPercent: 0,
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

function dockerHeaders() {
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
  deriveDockerBaseUrl,
  getDockerContainers,
  getDockerSummary,
  getWhoamiDetails,
  readServers,
  validateServer,
  writeServers,
};
