// #ash Mesh — API client. Sends the CSRF token from its cookie on every mutation.
const CSRF_COOKIE = 'ash_csrf';

function readCookie(name) {
  const match = document.cookie.split('; ').find((row) => row.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api(path, options = {}) {
  const { method = 'GET', body, form, headers = {}, raw = false } = options;
  const init = { method, credentials: 'same-origin', headers: { ...headers } };
  if (method !== 'GET' && method !== 'HEAD') init.headers['x-csrf-token'] = readCookie(CSRF_COOKIE);
  if (form) {
    init.body = form;
  } else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch('/api' + path, init);
  if (raw) {
    if (!res.ok) throw new ApiError('Could not load file.', res.status, null);
    return res;
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    throw new ApiError(data?.message || data?.error || `Request failed (${res.status})`, res.status, data);
  }
  return data;
}

export const mediaUrl = (id) => (id ? `/api/media/${id}` : null);
export const formatTime = (iso) => {
  if (!iso) return '';
  const date = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return date.toLocaleDateString();
};
export const naira = (kobo) =>
  '₦' + (Number(kobo || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
