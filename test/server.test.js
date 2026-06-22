const assert = require('node:assert/strict');
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  SELF_SERVER_ID,
  createApp,
  getDockerContainers,
  getDockerSummary,
  getWhoamiDetails,
  validateServer,
} = require('../server');

async function listenDockerSocket(handler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'server-dashboard-docker-'));
  const socketPath = path.join(directory, 'docker.sock');
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return { server, socketPath };
}

function dockerFixture(req, res) {
  const responses = {
    '/version': { Version: '28.1.0', ApiVersion: '1.49' },
    '/info': { Name: 'docker-host', NCPU: 8, MemTotal: 34359738368, OperatingSystem: 'Linux', Architecture: 'x86_64' },
    '/containers/json?all=1': [
      { Id: 'a'.repeat(64), Names: ['/web'], Image: 'nginx:latest', ImageID: 'sha256:1', State: 'running', Status: 'Up 2 hours (healthy)', Created: 1710000000, Labels: { 'com.docker.compose.project': 'frontend' }, Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: 'tcp', IP: '0.0.0.0' }] },
      { Id: 'b'.repeat(64), Names: ['/worker'], Image: 'worker:latest', State: 'running', Status: 'Up 1 hour (unhealthy)', Created: 1710000100, Labels: { 'com.docker.compose.project': 'jobs' }, Ports: [] },
      { Id: 'c'.repeat(64), Names: ['/backup'], Image: 'backup:latest', State: 'exited', Status: 'Exited (0) 3 hours ago', Created: 1710000200, Labels: {}, Ports: [] },
    ],
    '/images/json': [{ Id: 'image-1' }, { Id: 'image-2' }],
    '/volumes': { Volumes: [{ Name: 'data' }, { Name: 'backups' }, { Name: 'cache' }] },
  };
  if (!Object.hasOwn(responses, req.url)) {
    res.writeHead(404);
    return res.end('{}');
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(responses[req.url]));
}

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

test('validateServer accepts required fields and normalizes the whoami URL', () => {
  const server = validateServer({
    name: ' API ',
    ipAddress: '10.0.0.1',
    host: 'api.local',
    whoamiUrl: 'https://api.local/whoami',
    whoamiUsername: ' monitor ',
    whoamiPassword: ' secret ',
  });

  assert.equal(server.name, 'API');
  assert.equal(server.whoamiUrl, 'https://api.local/whoami');
  assert.equal(server.whoamiUsername, 'monitor');
  assert.equal(server.whoamiPassword, ' secret ');
});

test('validateServer rejects invalid whoami URLs', () => {
  assert.throws(() => validateServer({
    name: 'API',
    ipAddress: '10.0.0.1',
    host: 'api.local',
    whoamiUrl: 'not-a-url',
  }), /valid URL/);
});

test('validateServer accepts an optional Docker base URL and rejects invalid protocols', () => {
  const server = validateServer({
    name: 'API', ipAddress: '10.0.0.1', host: 'api.local',
    whoamiUrl: 'https://api.local/whoami', dockerBaseUrl: 'https://monitor.local/docker/',
  });
  assert.equal(server.dockerBaseUrl, 'https://monitor.local/docker');
  assert.throws(() => validateServer({
    name: 'API', ipAddress: '10.0.0.1', host: 'api.local',
    whoamiUrl: 'https://api.local/whoami', dockerBaseUrl: 'file:///var/run/docker.sock',
  }), /valid http or https URL/);
});

test('Docker socket adapter aggregates summaries and normalizes containers', async () => {
  const docker = await listenDockerSocket(dockerFixture);
  try {
    const summary = await getDockerSummary({ socketPath: docker.socketPath });
    assert.equal(summary.engine.version, '28.1.0');
    assert.equal(summary.resources.cpus, 8);
    assert.deepEqual(summary.containers, {
      total: 3,
      running: 2,
      paused: 0,
      stopped: 1,
      states: { running: 2, exited: 1 },
      health: { healthy: 1, unhealthy: 1, starting: 0 },
    });
    assert.equal(summary.stacks, 2);
    assert.equal(summary.standaloneContainers, 1);
    assert.equal(summary.images, 2);
    assert.equal(summary.volumes, 3);

    const inventory = await getDockerContainers({ socketPath: docker.socketPath });
    assert.equal(inventory.containers[0].name, 'web');
    assert.equal(inventory.containers[0].health, 'healthy');
    assert.equal(inventory.containers[0].composeProject, 'frontend');
    assert.equal(inventory.containers[0].ports[0].public, 8080);
  } finally {
    await new Promise((resolve) => docker.server.close(resolve));
  }
});

test('Docker socket adapter returns a stable unavailable error for a missing socket', async () => {
  await assert.rejects(
    getDockerSummary({ socketPath: path.join(os.tmpdir(), `missing-${Date.now()}.sock`) }),
    (error) => error.statusCode === 503 && error.code === 'docker_unavailable',
  );
});

test('Docker socket adapter rejects malformed and non-success Engine responses', async () => {
  const malformed = await listenDockerSocket((req, res) => res.end('{not-json'));
  try {
    await assert.rejects(
      getDockerContainers({ socketPath: malformed.socketPath }),
      (error) => error.statusCode === 503 && error.code === 'docker_invalid_response',
    );
  } finally {
    await new Promise((resolve) => malformed.server.close(resolve));
  }

  const failed = await listenDockerSocket((req, res) => {
    res.writeHead(500);
    res.end('{}');
  });
  try {
    await assert.rejects(
      getDockerContainers({ socketPath: failed.socketPath }),
      (error) => error.statusCode === 503 && error.code === 'docker_unavailable',
    );
  } finally {
    await new Promise((resolve) => failed.server.close(resolve));
  }
});

test('whoami mode exposes Docker monitoring endpoints without changing whoami', async () => {
  const docker = await listenDockerSocket(dockerFixture);
  const appServer = await listen(createApp({ mode: 'whoami', dockerSocketPath: docker.socketPath }));
  try {
    const whoamiResponse = await fetch(`${appServer.baseUrl}/whoami`);
    const summaryResponse = await fetch(`${appServer.baseUrl}/docker/summary`);
    const containersResponse = await fetch(`${appServer.baseUrl}/docker/containers`);
    assert.equal(whoamiResponse.status, 200);
    assert.equal((await whoamiResponse.json()).service, 'server-dashboard whoami');
    assert.equal(summaryResponse.status, 200);
    assert.equal((await summaryResponse.json()).containers.total, 3);
    assert.equal(containersResponse.status, 200);
    assert.equal((await containersResponse.json()).containers.length, 3);
  } finally {
    appServer.server.close();
    await new Promise((resolve) => docker.server.close(resolve));
  }
});

test('API stores and updates servers in a JSON file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'server-dashboard-'));
  const dataFile = path.join(directory, 'servers.json');
  const { server, baseUrl } = await listen(createApp({ dataFile, registerSelf: false }));

  try {
    const createdResponse = await fetch(`${baseUrl}/api/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Database',
        ipAddress: '10.0.0.20',
        host: 'db.local',
        whoamiUrl: 'http://db.local/whoami',
        whoamiUsername: 'nginx-user',
        whoamiPassword: 'nginx-password',
      }),
    });
    const created = await createdResponse.json();

    assert.equal(createdResponse.status, 201);
    assert.equal(created.name, 'Database');
    assert.equal(created.whoamiUsername, 'nginx-user');
    assert.equal(created.whoamiPassword, 'nginx-password');

    const updatedResponse = await fetch(`${baseUrl}/api/servers/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Database primary',
        ipAddress: '10.0.0.21',
        host: 'db-primary.local',
        whoamiUrl: 'http://db-primary.local/whoami',
        whoamiUsername: 'primary-user',
        whoamiPassword: 'primary-password',
      }),
    });
    const updated = await updatedResponse.json();
    assert.equal(updatedResponse.status, 200);
    assert.equal(updated.name, 'Database primary');

    const listedResponse = await fetch(`${baseUrl}/api/servers`);
    const listed = await listedResponse.json();
    assert.equal(listedResponse.status, 200);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].host, 'db-primary.local');
    assert.equal(listed[0].whoamiUsername, 'primary-user');
    assert.equal(listed[0].whoamiPassword, 'primary-password');

    const stored = JSON.parse(await fs.readFile(dataFile, 'utf8'));
    assert.equal(stored[0].id, created.id);
  } finally {
    server.close();
  }
});

test('server whoami proxy fetches basic-auth protected endpoints without browser preflight', async () => {
  const upstream = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="whoami"' });
      return res.end();
    }

    if (req.headers.authorization !== `Basic ${Buffer.from('monitor:secret').toString('base64')}`) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="whoami"' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'protected whoami', cpus: 4, memoryGb: 16, storageGb: 128 }));
  });

  const upstreamBaseUrl = await new Promise((resolve) => {
    upstream.listen(0, () => resolve(`http://127.0.0.1:${upstream.address().port}`));
  });

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'server-dashboard-'));
  const dataFile = path.join(directory, 'servers.json');
  await fs.writeFile(dataFile, JSON.stringify([{
    id: 'protected-node',
    name: 'Protected node',
    ipAddress: '10.0.0.30',
    host: 'protected.local',
    whoamiUrl: `${upstreamBaseUrl}/whoami`,
    whoamiUsername: 'monitor',
    whoamiPassword: 'secret',
  }]));
  const { server, baseUrl } = await listen(createApp({ dataFile, registerSelf: false }));

  try {
    const proxiedResponse = await fetch(`${baseUrl}/api/servers/protected-node/whoami`);
    const proxied = await proxiedResponse.json();

    assert.equal(proxiedResponse.status, 200);
    assert.equal(proxied.service, 'protected whoami');
    assert.equal(proxied.cpus, 4);
  } finally {
    server.close();
    upstream.close();
  }
});

test('server Docker proxy uses the configured base URL and existing basic auth', async () => {
  const expectedAuth = `Basic ${Buffer.from('monitor:secret').toString('base64')}`;
  const upstream = http.createServer((req, res) => {
    if (req.url !== '/restricted/docker/summary' || req.headers.authorization !== expectedAuth) {
      res.writeHead(401);
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ available: true, containers: { total: 7, running: 5 } }));
  });
  const upstreamBaseUrl = await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${upstream.address().port}`)));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'server-dashboard-'));
  const dataFile = path.join(directory, 'servers.json');
  await fs.writeFile(dataFile, JSON.stringify([{
    id: 'docker-node', name: 'Docker node', ipAddress: '10.0.0.31', host: 'docker.local',
    whoamiUrl: `${upstreamBaseUrl}/whoami`, dockerBaseUrl: `${upstreamBaseUrl}/restricted/docker`,
    whoamiUsername: 'monitor', whoamiPassword: 'secret',
  }]));
  const dashboard = await listen(createApp({ dataFile, registerSelf: false }));
  try {
    const response = await fetch(`${dashboard.baseUrl}/api/servers/docker-node/docker/summary`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).containers.running, 5);
  } finally {
    dashboard.server.close();
    upstream.close();
  }
});

test('self server Docker proxy reads the local socket instead of its stored URL', async () => {
  const docker = await listenDockerSocket(dockerFixture);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'server-dashboard-'));
  const dataFile = path.join(directory, 'servers.json');
  await fs.writeFile(dataFile, JSON.stringify([{
    id: SELF_SERVER_ID, isSelf: true, name: 'Dashboard', ipAddress: '127.0.0.1',
    host: 'dashboard.local', whoamiUrl: 'http://127.0.0.1:1/whoami', dockerBaseUrl: 'http://127.0.0.1:1/docker',
  }]));
  const dashboard = await listen(createApp({ dataFile, registerSelf: true, dockerSocketPath: docker.socketPath }));
  try {
    const response = await fetch(`${dashboard.baseUrl}/api/servers/${SELF_SERVER_ID}/docker/summary`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).engine.name, 'docker-host');
  } finally {
    dashboard.server.close();
    await new Promise((resolve) => docker.server.close(resolve));
  }
});

test('self server whoami is served locally instead of proxying through its stored URL', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'server-dashboard-'));
  const dataFile = path.join(directory, 'servers.json');
  await fs.writeFile(dataFile, JSON.stringify([{
    id: SELF_SERVER_ID,
    isSelf: true,
    name: 'Dashboard',
    ipAddress: '127.0.0.1',
    host: 'dashboard.local',
    whoamiUrl: 'http://127.0.0.1:1/whoami',
  }]));
  const { server, baseUrl } = await listen(createApp({ dataFile, registerSelf: true }));

  try {
    const response = await fetch(`${baseUrl}/api/servers/${SELF_SERVER_ID}/whoami`);
    const details = await response.json();

    assert.equal(response.status, 200);
    assert.equal(details.service, 'server-dashboard whoami');
    assert.equal(details.mode, 'dashboard');
    assert.ok(details.cpus >= 1);
  } finally {
    server.close();
  }
});

test('dashboard mode exposes whoami and can register itself by default', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'server-dashboard-'));
  const dataFile = path.join(directory, 'servers.json');
  const { server, baseUrl } = await listen(createApp({ dataFile, registerSelf: true }));

  try {
    const whoamiResponse = await fetch(`${baseUrl}/whoami`);
    const whoami = await whoamiResponse.json();
    assert.equal(whoamiResponse.status, 200);
    assert.equal(whoami.service, 'server-dashboard whoami');
    assert.ok(whoami.cpus >= 1);

    const listedResponse = await fetch(`${baseUrl}/api/servers`);
    const listed = await listedResponse.json();
    assert.equal(listedResponse.status, 200);
    assert.equal(listed[0].id, SELF_SERVER_ID);
    assert.equal(listed[0].whoamiUrl, `${baseUrl}/whoami`);
  } finally {
    server.close();
  }
});

test('whoami mode serves only the provider endpoint and disables dashboard APIs', async () => {
  const { server, baseUrl } = await listen(createApp({ mode: 'whoami' }));

  try {
    const whoamiResponse = await fetch(`${baseUrl}/whoami`);
    const whoami = await whoamiResponse.json();
    assert.equal(whoamiResponse.status, 200);
    assert.equal(whoami.mode, 'whoami');

    const optionsResponse = await fetch(`${baseUrl}/whoami`, {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Headers': 'authorization' },
    });
    assert.equal(optionsResponse.status, 204);
    assert.match(optionsResponse.headers.get('access-control-allow-headers'), /Authorization/);

    const apiResponse = await fetch(`${baseUrl}/api/servers`);
    assert.equal(apiResponse.status, 404);
  } finally {
    server.close();
  }
});

test('getWhoamiDetails includes dashboard capacity fields', async () => {
  const details = await getWhoamiDetails();
  assert.equal(details.service, 'server-dashboard whoami');
  assert.ok(details.cpus >= 1);
  assert.equal(details.cpu.cores, details.cpus);
  assert.equal(details.system.cpus, details.cpus);
  assert.equal(details.system.os, details.os);
  assert.ok(details.memoryGb > 0);
  assert.equal(details.memory.unit, 'bytes');
  assert.ok(details.storageGb > 0);
  assert.ok(details.storage.used >= 0);
  assert.equal(details.storage.usedGb, Math.round((details.storage.used / 1024 / 1024 / 1024) * 10) / 10);
  assert.ok(details.storage.usedPercent >= 0);
  assert.ok(details.storage.usedPercent <= 100);
});
