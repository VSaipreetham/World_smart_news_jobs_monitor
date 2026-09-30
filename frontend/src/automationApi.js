// Owner credentials live in this module's memory only. Never persist them in storage.
let ownerKey = '';
const base = (import.meta.env?.VITE_API_BASE_URL || '').replace(/\/$/, '');

export function setOwnerKey(value) { ownerKey = String(value || '').trim(); }
export function hasOwnerKey() { return Boolean(ownerKey); }
export function getOwnerKey() { return ownerKey; }
export function isReadOnlyPreview() { return Boolean(globalThis.__WORLD_JOBS_PREVIEW__); }

function previewResponse(path, method) {
  const preview = globalThis.__WORLD_JOBS_PREVIEW__;
  if (method && method !== 'GET') throw new Error('This is a read-only preview. Run the application backend to connect services or make changes.');
  const url = new URL(path, 'https://preview.invalid');
  const rows = preview.rows || preview.directory || [];
  const counts = { directory: rows.length, companies: rows.filter(row => row.kind === 'company').length, portals: rows.filter(row => row.kind === 'portal').length, jobs: 0 };
  if (url.pathname === '/summary' || url.pathname === '/status') return { counts, capacity: { companies: 100000, portals: 10000 }, integrations: {}, ownerConfigured: false, runs: [] };
  if (url.pathname === '/directory') {
    const search = (url.searchParams.get('search') || '').toLowerCase();
    const filtered = rows.filter(row => (!search || `${row.name} ${row.url}`.toLowerCase().includes(search)) && ['kind', 'provider'].every(key => !url.searchParams.get(key) || row[key] === url.searchParams.get(key)));
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    return { rows: filtered.slice((page - 1) * limit, page * limit), total: filtered.length, page, limit };
  }
  throw new Error('Private data and live services are unavailable in this read-only preview.');
}

export async function automationApi(path, options = {}) {
  if (isReadOnlyPreview()) return previewResponse(path, options.method);
  const { body, headers, ...rest } = options;
  const multipart = typeof FormData !== 'undefined' && body instanceof FormData;
  const response = await fetch(`${base}/api/automation${path}`, {
    ...rest,
    headers: {
      Accept: 'application/json',
      ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}),
      ...(ownerKey ? { Authorization: `Bearer ${ownerKey}` } : {}),
      ...headers,
    },
    ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}),
  });
  let data;
  try { data = await response.json(); } catch {
    throw new Error(`The automation API is unavailable (${response.status}). Check the backend connection.`);
  }
  if (!response.ok) {
    const error = new Error(data.message || data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function downloadPrivateFile(path, filename) {
  if (isReadOnlyPreview()) throw new Error('Private downloads are unavailable in this read-only preview.');
  const response = await fetch(`${base}/api/automation${path}`, { headers: { Authorization: `Bearer ${ownerKey}` } });
  if (!response.ok) throw new Error('The private download is unavailable. Connect your workspace and try again.');
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJson(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
