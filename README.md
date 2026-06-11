# Server Dashboard

A polished, JSON-backed web dashboard for tracking servers and their capacity at a glance.

## Features

- Add servers with a name, IP address, host, and whoami endpoint URL.
- Persist server inventory in `data/servers.json` as plain JSON.
- Fetch whoami endpoints from the browser to show online/offline status.
- Summarize servers up, total CPUs, total memory, and total storage.
- Display each server as a responsive glassmorphism card.
- Remove servers from the inventory.

## Whoami response shape

The dashboard accepts several common field names when reading whoami JSON. For the best results, return fields similar to this:

```json
{
  "cpus": 8,
  "memoryGb": 32,
  "storageGb": 512,
  "os": "Ubuntu 24.04"
}
```

Nested forms like `memory.total`, `storage.total`, `cpu.cores`, and `system.os` are also supported.

## Run locally

```bash
npm start
```

Then open <http://localhost:3000>.

## Test

```bash
npm test
```
