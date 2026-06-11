const assert = require('node:assert/strict');
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  SELF_SERVER_ID,
  createApp,
  getWhoamiDetails,
  validateServer,
} = require('../server');

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
  });

  assert.equal(server.name, 'API');
  assert.equal(server.whoamiUrl, 'https://api.local/whoami');
});

test('validateServer rejects invalid whoami URLs', () => {
  assert.throws(() => validateServer({
    name: 'API',
    ipAddress: '10.0.0.1',
    host: 'api.local',
    whoamiUrl: 'not-a-url',
  }), /valid URL/);
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
      }),
    });
    const created = await createdResponse.json();

    assert.equal(createdResponse.status, 201);
    assert.equal(created.name, 'Database');

    const updatedResponse = await fetch(`${baseUrl}/api/servers/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Database primary',
        ipAddress: '10.0.0.21',
        host: 'db-primary.local',
        whoamiUrl: 'http://db-primary.local/whoami',
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

    const stored = JSON.parse(await fs.readFile(dataFile, 'utf8'));
    assert.equal(stored[0].id, created.id);
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
  assert.ok(details.memoryGb > 0);
  assert.equal(details.memory.unit, 'bytes');
});
