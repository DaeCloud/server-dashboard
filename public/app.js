const state = {
  servers: [],
  details: new Map(),
  editingServerId: '',
};

const elements = {
  grid: document.querySelector('#server-grid'),
  empty: document.querySelector('#empty-state'),
  dialog: document.querySelector('#server-dialog'),
  form: document.querySelector('#server-form'),
  formError: document.querySelector('#form-error'),
  dialogEyebrow: document.querySelector('#dialog-eyebrow'),
  dialogTitle: document.querySelector('#dialog-title'),
  submitServer: document.querySelector('#submit-server'),
  openAddServer: document.querySelector('#open-add-server'),
  closeDialog: document.querySelector('#close-dialog'),
  refresh: document.querySelector('#refresh'),
  serversUp: document.querySelector('#servers-up'),
  totalCpus: document.querySelector('#total-cpus'),
  totalMemory: document.querySelector('#total-memory'),
  totalStorage: document.querySelector('#total-storage'),
};

const numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

async function loadServers() {
  const response = await fetch('/api/servers');
  state.servers = await response.json();
  render();
  await refreshWhoamiDetails();
}

async function refreshWhoamiDetails() {
  await Promise.all(state.servers.map(async (server) => {
    state.details.set(server.id, { status: 'loading' });
    render();

    try {
      const response = await fetch(server.whoamiUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const details = await response.json();
      state.details.set(server.id, normalizeDetails(details));
    } catch (error) {
      state.details.set(server.id, { status: 'down', error: error.message });
    }
    render();
  }));
}

function normalizeDetails(details) {
  const memory = findNumberWithPath(details, [
    'memoryGb', 'memoryGB', 'memory_gb', 'memory.totalGb', 'memory.totalGB',
    'memory.total', 'memory.totalBytes', 'mem.total', 'ram.total',
  ]);
  const storage = findNumberWithPath(details, [
    'storageGb', 'storageGB', 'storage_gb', 'storage.totalGb', 'storage.totalGB',
    'storage.total', 'storage.totalBytes', 'disk.total', 'disks.total',
  ]);
  const storageFree = findNumberWithPath(details, [
    'storage.freeGb', 'storage.freeGB', 'storage.free', 'storage.freeBytes',
    'storage.availableGb', 'storage.available', 'disk.free', 'disks.free',
  ]);
  const storageUsed = findNumberWithPath(details, [
    'storage.usedGb', 'storage.usedGB', 'storage.used', 'storage.usedBytes',
    'disk.used', 'disks.used',
  ]);
  const explicitStoragePercent = findNumber(details, [
    'storage.usedPercent', 'storage.percentUsed', 'storage.usagePercent',
    'disk.usedPercent', 'disks.usedPercent',
  ]);

  const memoryGb = toGigabytes(memory, details);
  const storageGb = toGigabytes(storage, details);
  const storageFreeGb = toGigabytes(storageFree, details);
  const storageUsedGb = toGigabytes(storageUsed, details) || Math.max(storageGb - storageFreeGb, 0);
  const storageUsedPercent = clampPercent(
    explicitStoragePercent || (storageGb > 0 ? (storageUsedGb / storageGb) * 100 : 0),
  );

  return {
    status: 'up',
    cpus: findNumber(details, ['cpus', 'cpuCount', 'cpu_count', 'cpu.cores', 'system.cpus']) || 0,
    memoryGb,
    storageGb,
    storageFreeGb,
    storageUsedGb,
    storageUsedPercent,
    os: findString(details, ['os', 'platform', 'system.os', 'host.os']) || 'Unknown OS',
    raw: details,
  };
}

function findNumber(source, paths) {
  return findNumberWithPath(source, paths).value;
}

function findNumberWithPath(source, paths) {
  for (const path of paths) {
    const rawValue = getPathValue(source, path);
    const parsed = parseNumber(rawValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      return { value: parsed, path, rawValue, unit: parseUnit(rawValue) };
    }
  }
  return { value: 0, path: '', rawValue: undefined, unit: '' };
}

function getPathValue(source, path) {
  return path.split('.').reduce((current, key) => current?.[key], source);
}

function parseNumber(value) {
  if (typeof value === 'string') return Number(value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)?.[0]);
  return Number(value);
}

function parseUnit(value) {
  if (typeof value !== 'string') return '';
  return value.toLowerCase().match(/\b(bytes?|b|kib|kb|mib|mb|gib|gb|tib|tb)\b/)?.[1] || '';
}

function findString(source, paths) {
  for (const path of paths) {
    const value = getPathValue(source, path);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function toGigabytes(measurement, details) {
  const value = typeof measurement === 'object' ? measurement.value : measurement;
  const sourcePath = typeof measurement === 'object' ? measurement.path : '';
  const inlineUnit = typeof measurement === 'object' ? measurement.unit : '';

  if (!value) return 0;
  if (isGigabytePath(sourcePath)) return value;

  const unit = (inlineUnit || findUnitForPath(details, sourcePath)).toLowerCase();
  if (unit === 'tb' || unit === 'tib') return value * 1024;
  if (unit === 'gb' || unit === 'gib') return value;
  if (unit === 'mb' || unit === 'mib' || unit === 'megabytes') return value / 1024;
  if (unit === 'kb' || unit === 'kib') return value / 1024 / 1024;
  if (unit === 'bytes' || unit === 'byte' || unit === 'b' || value > 1024 * 1024) return value / 1024 / 1024 / 1024;
  return value;
}

function isGigabytePath(sourcePath) {
  return /g(?:i)?b$/i.test(sourcePath);
}

function findUnitForPath(details, sourcePath = '') {
  const unitPaths = sourcePath.startsWith('storage.') || sourcePath.startsWith('disk.') || sourcePath.startsWith('disks.')
    ? ['storage.unit', 'disk.unit', 'disks.unit', 'unit']
    : ['memory.unit', 'mem.unit', 'ram.unit', 'unit'];
  return findString(details, unitPaths);
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function render() {
  renderSummary();
  elements.empty.classList.toggle('visible', state.servers.length === 0);
  elements.grid.innerHTML = state.servers.map(renderCard).join('');
}

function renderSummary() {
  const details = state.servers.map((server) => state.details.get(server.id) || { status: 'loading' });
  const upCount = details.filter((detail) => detail.status === 'up').length;
  const totals = details.reduce((acc, detail) => {
    if (detail.status !== 'up') return acc;
    acc.cpus += detail.cpus || 0;
    acc.memoryGb += detail.memoryGb || 0;
    acc.storageGb += detail.storageGb || 0;
    return acc;
  }, { cpus: 0, memoryGb: 0, storageGb: 0 });

  elements.serversUp.textContent = `${upCount} / ${state.servers.length}`;
  elements.totalCpus.textContent = numberFormatter.format(totals.cpus);
  elements.totalMemory.textContent = `${numberFormatter.format(totals.memoryGb)} GB`;
  elements.totalStorage.textContent = `${numberFormatter.format(totals.storageGb)} GB`;
}

function renderCard(server) {
  const detail = state.details.get(server.id) || { status: 'loading' };
  const statusClass = detail.status === 'up' ? 'status-up' : detail.status === 'down' ? 'status-down' : 'status-loading';
  const statusLabel = detail.status === 'up' ? 'Online' : detail.status === 'down' ? 'Offline' : 'Checking';
  const selfBadge = server.isSelf ? '<span class="self-badge">Dashboard</span>' : '';
  const storagePercent = Math.round(detail.storageUsedPercent || 0);

  return `
    <article class="server-card">
      <div class="card-content">
        <div class="card-top">
          <div>
            <div class="server-title-row">
              <h3 class="server-name">${escapeHtml(server.name)}</h3>
              ${selfBadge}
            </div>
            <p class="server-host">${escapeHtml(server.host)}</p>
          </div>
          <span class="status-pill ${statusClass}"><span class="status-dot"></span>${statusLabel}</span>
        </div>
        <div class="meta">
          <div class="meta-row"><span>IP address</span><strong>${escapeHtml(server.ipAddress)}</strong></div>
          <div class="meta-row"><span>Operating system</span><strong>${escapeHtml(detail.os || 'Pending')}</strong></div>
        </div>
        <div class="metric-grid">
          <div class="metric"><span>CPUs</span><strong>${metric(detail.cpus)}</strong></div>
          <div class="metric"><span>Memory</span><strong>${metric(detail.memoryGb, ' GB')}</strong></div>
          <div class="metric storage-metric">
            <span>Storage</span>
            <strong>${metric(detail.storageGb, ' GB')}</strong>
            ${renderStorageUsage(detail, storagePercent)}
          </div>
        </div>
        ${detail.error ? `<p class="form-error">${escapeHtml(detail.error)}</p>` : ''}
        <div class="card-actions">
          <a class="card-link" href="${escapeAttribute(server.whoamiUrl)}" target="_blank" rel="noreferrer">Open whoami</a>
          <button class="edit-button" type="button" data-edit-id="${escapeAttribute(server.id)}">Edit</button>
          <button class="delete-button" type="button" data-delete-id="${escapeAttribute(server.id)}">Remove</button>
        </div>
      </div>
    </article>`;
}

function renderStorageUsage(detail, storagePercent) {
  if (detail.status !== 'up' || !detail.storageGb) return '';

  return `
    <div class="storage-usage" aria-label="Storage usage: ${storagePercent}% used">
      <div class="storage-usage-copy">
        <span>${metric(detail.storageUsedGb, ' GB')} used</span>
        <span>${storagePercent}%</span>
      </div>
      <div class="storage-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${storagePercent}">
        <span style="width: ${storagePercent}%"></span>
      </div>
    </div>`;
}

function metric(value, suffix = '') {
  return value ? `${numberFormatter.format(value)}${suffix}` : '—';
}

function openServerDialog(server = null) {
  state.editingServerId = server?.id || '';
  elements.formError.textContent = '';
  elements.form.reset();

  if (server) {
    elements.dialogEyebrow.textContent = server.isSelf ? 'Dashboard node' : 'Known node';
    elements.dialogTitle.textContent = 'Edit server';
    elements.submitServer.textContent = 'Save changes';
    elements.form.elements.name.value = server.name;
    elements.form.elements.ipAddress.value = server.ipAddress;
    elements.form.elements.host.value = server.host;
    elements.form.elements.whoamiUrl.value = server.whoamiUrl;
  } else {
    elements.dialogEyebrow.textContent = 'New node';
    elements.dialogTitle.textContent = 'Add server';
    elements.submitServer.textContent = 'Save server';
  }

  elements.dialog.showModal();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

elements.openAddServer.addEventListener('click', () => openServerDialog());
elements.closeDialog.addEventListener('click', () => elements.dialog.close());
elements.refresh.addEventListener('click', refreshWhoamiDetails);

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.formError.textContent = '';

  const payload = Object.fromEntries(new FormData(elements.form));
  const isEditing = Boolean(state.editingServerId);
  const response = await fetch(isEditing ? `/api/servers/${state.editingServerId}` : '/api/servers', {
    method: isEditing ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const result = await response.json();
    elements.formError.textContent = result.error || 'Unable to save server.';
    return;
  }

  elements.form.reset();
  state.editingServerId = '';
  elements.dialog.close();
  await loadServers();
});

elements.grid.addEventListener('click', async (event) => {
  const editButton = event.target.closest('[data-edit-id]');
  if (editButton) {
    const server = state.servers.find((candidate) => candidate.id === editButton.dataset.editId);
    if (server) openServerDialog(server);
    return;
  }

  const deleteButton = event.target.closest('[data-delete-id]');
  if (!deleteButton) return;
  await fetch(`/api/servers/${deleteButton.dataset.deleteId}`, { method: 'DELETE' });
  await loadServers();
});

loadServers();
