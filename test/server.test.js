const assert = require('node:assert/strict');
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createApp, validateServer } = require('../server');

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

test('API stores servers in a JSON file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'server-dashboard-'));
  const dataFile = path.join(directory, 'servers.json');
  const { server, baseUrl } = await listen(createApp({ dataFile }));

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

    const listedResponse = await fetch(`${baseUrl}/api/servers`);
    const listed = await listedResponse.json();
    assert.equal(listedResponse.status, 200);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].host, 'db.local');

    const stored = JSON.parse(await fs.readFile(dataFile, 'utf8'));
    assert.equal(stored[0].id, created.id);
  } finally {
    server.close();
  }
});
