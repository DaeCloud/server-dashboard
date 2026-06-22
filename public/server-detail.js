const serverId = new URLSearchParams(location.search).get('id');
const numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

const elements = {
  breadcrumbName: document.querySelector('#breadcrumb-name'),
  name: document.querySelector('#server-name'),
  address: document.querySelector('#server-address'),
  status: document.querySelector('#server-status'),
  whoamiLink: document.querySelector('#whoami-link'),
  refresh: document.querySelector('#refresh-detail'),
  os: document.querySelector('#host-os'),
  cpus: document.querySelector('#host-cpus'),
  memory: document.querySelector('#host-memory'),
  storage: document.querySelector('#host-storage'),
  dockerStatus: document.querySelector('#docker-status'),
  dockerError: document.querySelector('#docker-error'),
  dockerKpis: document.querySelector('#docker-kpis'),
  engineMeta: document.querySelector('#engine-meta'),
  containerCount: document.querySelector('#container-count'),
  containerBody: document.querySelector('#container-table-body'),
};

async function load() {
  if (!serverId) return showMissingServer();
  elements.refresh.disabled = true;
  elements.refresh.textContent = 'Refreshing';

  try {
    const response = await fetch('/api/servers', { cache: 'no-store' });
    const servers = await response.json();
    const server = servers.find((candidate) => candidate.id === serverId);
    if (!server) return showMissingServer();
    renderServer(server);
    await Promise.all([loadWhoami(), loadDockerSummary(), loadContainers()]);
  } catch (error) {
    elements.address.textContent = `Unable to load server: ${error.message}`;
  } finally {
    elements.refresh.disabled = false;
    elements.refresh.textContent = 'Refresh';
  }
}

function renderServer(server) {
  document.title = `${server.name} · Server Dashboard`;
  elements.name.textContent = server.name;
  elements.breadcrumbName.textContent = server.name;
  elements.address.textContent = `${server.host} · ${server.ipAddress}`;
  elements.whoamiLink.href = server.whoamiUrl;
}

async function loadWhoami() {
  setPill(elements.status, 'loading', 'Checking');
  try {
    const response = await fetch(`/api/servers/${encodeURIComponent(serverId)}/whoami`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    setPill(elements.status, 'up', 'Online');
    elements.os.textContent = result.os || result.system?.os || 'Unknown';
    elements.cpus.textContent = numberFormatter.format(result.cpus || result.cpu?.cores || 0);
    elements.memory.textContent = formatBytes(result.memory?.total) || formatGigabytes(result.memoryGb);
    elements.storage.textContent = formatBytes(result.storage?.total) || formatGigabytes(result.storageGb);
  } catch (error) {
    setPill(elements.status, 'down', 'Offline');
  }
}

async function loadDockerSummary() {
  setPill(elements.dockerStatus, 'loading', 'Checking');
  elements.dockerError.hidden = true;
  try {
    const response = await fetch(`/api/servers/${encodeURIComponent(serverId)}/docker/summary`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    setPill(elements.dockerStatus, 'up', 'Connected');
    renderDockerKpis(result);
  } catch (error) {
    setPill(elements.dockerStatus, 'down', 'Unavailable');
    elements.dockerError.hidden = false;
    elements.dockerError.textContent = error.message;
    elements.dockerKpis.innerHTML = '';
    elements.engineMeta.hidden = true;
  }
}

function renderDockerKpis(summary) {
  const health = summary.containers?.health || {};
  const kpis = [
    ['Containers', `${summary.containers?.running || 0} / ${summary.containers?.total || 0}`, 'running'],
    ['Unhealthy', health.unhealthy || 0, 'health checks'],
    ['Stacks', summary.stacks || 0, 'Compose projects'],
    ['Standalone', summary.standaloneContainers || 0, 'containers'],
    ['Images', summary.images || 0, 'local images'],
    ['Volumes', summary.volumes || 0, 'local volumes'],
  ];
  elements.dockerKpis.innerHTML = kpis.map(([label, value, note]) => `
    <article class="summary-card"><span class="summary-label">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`).join('');
  elements.engineMeta.hidden = false;
  elements.engineMeta.innerHTML = `
    <div><span>Engine</span><strong>Docker ${escapeHtml(summary.engine?.version || 'Unknown')}</strong></div>
    <div><span>API</span><strong>${escapeHtml(summary.engine?.apiVersion || 'Unknown')}</strong></div>
    <div><span>Engine host</span><strong>${escapeHtml(summary.engine?.name || 'Unknown')}</strong></div>
    <div><span>Resources</span><strong>${numberFormatter.format(summary.resources?.cpus || 0)} CPU · ${formatBytes(summary.resources?.memoryBytes) || '—'}</strong></div>`;
}

async function loadContainers() {
  elements.containerCount.textContent = 'Loading';
  elements.containerBody.innerHTML = '<tr><td colspan="7" class="loading-cell">Loading container inventory…</td></tr>';
  try {
    const response = await fetch(`/api/servers/${encodeURIComponent(serverId)}/docker/containers`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    const containers = result.containers || [];
    elements.containerCount.textContent = `${containers.length} container${containers.length === 1 ? '' : 's'}`;
    elements.containerBody.innerHTML = containers.length ? containers.map(renderContainer).join('') : '<tr><td colspan="7" class="loading-cell">No containers found.</td></tr>';
  } catch (error) {
    elements.containerCount.textContent = 'Unavailable';
    elements.containerBody.innerHTML = `<tr><td colspan="7" class="loading-cell error-cell">${escapeHtml(error.message)}</td></tr>`;
  }
}

function renderContainer(container) {
  const ports = (container.ports || []).map((port) => port.public
    ? `${port.ip && port.ip !== '0.0.0.0' ? `${port.ip}:` : ''}${port.public}:${port.private}/${port.type}`
    : `${port.private}/${port.type}`).join(', ') || '—';
  return `<tr>
    <td><strong>${escapeHtml(container.name)}</strong><span class="container-id">${escapeHtml(container.shortId)}</span></td>
    <td>${containerPill(container.state)}</td>
    <td>${container.health ? containerPill(container.health) : '<span class="muted-cell">—</span>'}</td>
    <td class="truncate-cell" title="${escapeAttribute(container.image)}">${escapeHtml(container.image)}</td>
    <td>${escapeHtml(container.composeProject || 'Standalone')}</td>
    <td class="status-text">${escapeHtml(container.status || '—')}</td>
    <td class="ports-cell">${escapeHtml(ports)}</td>
  </tr>`;
}

function containerPill(value) {
  const healthy = value === 'running' || value === 'healthy';
  const pending = value === 'starting' || value === 'created' || value === 'paused';
  const status = healthy ? 'up' : pending ? 'loading' : 'down';
  return `<span class="status-pill status-${status}"><span class="status-dot" aria-hidden="true"></span>${escapeHtml(value)}</span>`;
}

function setPill(element, status, label) {
  element.className = `status-pill status-${status}`;
  element.innerHTML = `<span class="status-dot" aria-hidden="true"></span>${label}`;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!bytes) return '';
  return `${numberFormatter.format(bytes / 1024 / 1024 / 1024)} GB`;
}

function formatGigabytes(value) {
  return Number(value) ? `${numberFormatter.format(Number(value))} GB` : '—';
}

function showMissingServer() {
  elements.name.textContent = 'Server not found';
  elements.address.textContent = 'Return to the dashboard and choose an existing server.';
  elements.refresh.disabled = true;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

elements.refresh.addEventListener('click', load);
load();
