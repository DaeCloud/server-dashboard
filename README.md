# Server Dashboard

A polished, JSON-backed web dashboard for tracking servers and their capacity at a glance. The same container can also run as a lightweight `whoami` provider, so each machine can publish its own capacity data for the dashboard to read.

## Features

- Run as a full dashboard or a whoami-only provider with `APP_MODE`.
- Dashboard mode also exposes its own `/whoami` endpoint and registers itself in the inventory by default.
- Add, edit, and remove servers with a name, IP address, host, and whoami endpoint URL.
- Persist server inventory in `data/servers.json` as plain JSON.
- Fetch whoami endpoints from the browser to show online/offline status.
- Summarize servers up, total CPUs, total memory, and total storage.
- Display each server as a responsive glassmorphism card.

## Modes

Set `APP_MODE` (or `SERVICE_MODE`) to choose what the container does:

| Mode | Behavior |
| --- | --- |
| `dashboard` (default) | Serves the dashboard UI/API and also exposes the local whoami endpoint. |
| `whoami` | Serves only the whoami endpoint and a small root JSON helper response. Dashboard APIs and static assets are disabled. |

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port for either mode. |
| `APP_MODE` / `SERVICE_MODE` | `dashboard` | `dashboard` or `whoami`. |
| `DATA_FILE` | `data/servers.json` | Dashboard inventory JSON path. Mount this path as a volume in Docker for persistence. |
| `WHOAMI_PATH` | `/whoami` | Path where the whoami JSON is served. |
| `REGISTER_SELF` | `true` in dashboard mode | Auto-add the dashboard container to the inventory. Set to `false` to start empty. |
| `SELF_NAME`, `SERVER_NAME`, `WHOAMI_NAME` | host name | Name used for the auto-registered dashboard server and/or whoami payload. |
| `SELF_HOST`, `WHOAMI_HOST` | host name | Host label used for the auto-registered dashboard server and/or whoami payload. |
| `SELF_IP_ADDRESS`, `WHOAMI_IP_ADDRESS` | first non-internal IPv4 | IP address used for the auto-registered dashboard server and/or whoami payload. |
| `SELF_ORIGIN`, `DASHBOARD_ORIGIN` | request origin | Public origin used to build the dashboard's default self whoami URL. Useful behind reverse proxies. |
| `SELF_WHOAMI_URL`, `WHOAMI_URL` | derived from origin + path | Explicit self whoami URL for the dashboard inventory. |
| `WHOAMI_STORAGE_PATH` | `/` | Filesystem path used to calculate storage totals. |

## Whoami response shape

The bundled whoami provider returns fields similar to this:

```json
{
  "service": "server-dashboard whoami",
  "mode": "dashboard",
  "name": "api-01",
  "host": "api-01.example.com",
  "ipAddress": "10.0.0.20",
  "cpus": 8,
  "cpu": { "cores": 8, "model": "Example CPU" },
  "memoryGb": 32,
  "memory": { "total": 34359738368, "free": 8589934592, "unit": "bytes" },
  "storageGb": 512,
  "storage": { "total": 549755813888, "free": 274877906944, "unit": "bytes" },
  "os": "Linux 6.8.0",
  "system": { "os": "Linux 6.8.0", "platform": "linux", "arch": "x64", "cpus": 8 }
}
```

The dashboard accepts several common field names when reading whoami JSON. Nested forms like `memory.total`, `storage.total`, `cpu.cores`, and `system.os` are also supported. Gigabyte fields such as `memoryGb`, `storageGb`, `memory.totalGb`, and `storage.totalGb` are treated as already converted values even when byte-based nested details are present.

## Run locally

```bash
npm start
```

Then open <http://localhost:3000>. The local whoami endpoint is available at <http://localhost:3000/whoami>.

Run as a whoami-only provider:

```bash
APP_MODE=whoami PORT=3001 SERVER_NAME=api-01 npm start
```

Then add `http://localhost:3001/whoami` to the dashboard.

## Docker

Build the image:

```bash
docker build -t server-dashboard .
```

Run the dashboard with persistent inventory:

```bash
docker run --rm -p 3000:3000 \
  -e APP_MODE=dashboard \
  -e SERVER_NAME="Dashboard host" \
  -e SELF_ORIGIN=http://localhost:3000 \
  -v server-dashboard-data:/app/data \
  server-dashboard
```

Run a whoami provider on another server:

```bash
docker run --rm -p 3001:3000 \
  -e APP_MODE=whoami \
  -e SERVER_NAME="API host" \
  -e WHOAMI_HOST=api-01.example.com \
  server-dashboard
```

Add `http://<provider-host>:3001/whoami` to the dashboard inventory.

## Test

```bash
npm test
```
