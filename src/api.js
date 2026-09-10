// Sales backend client. The authoritative state lives in the Google Apps Script web app (tools/backend/Code.gs).
// Without a backend URL the page runs read-only: statuses come from data/status.json and leads fall back to e-mail.
import { BACKEND } from './config.js?v=15';

// local testing only: http://localhost:5173/?backend=http://localhost:5173/api points the page at the mock backend of tools/dev_server.py
const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const override = LOCAL ? new URLSearchParams(location.search).get('backend') : null;
if (override && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(override)) BACKEND.url = override;

const hasBackend = () => !!(BACKEND.url && (BACKEND.url.startsWith('https://') || (LOCAL && BACKEND.url.startsWith('http://'))));

async function call(action, payload = {}) {
  if (!hasBackend()) throw new Error('no-backend');
  // text/plain keeps the request "simple" (no CORS preflight), which is what Apps Script web apps support
  const res = await fetch(BACKEND.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, ...payload }), redirect: 'follow' });
  if (!res.ok) throw new Error(`http-${res.status}`);
  const data = await res.json();
  if (data && data.error) throw new Error(data.error);
  return data;
}

export const api = {
  hasBackend,
  // -> { statuses: { [pid]: { status, updatedAt, by } }, serverTime }
  async statuses() {
    if (hasBackend()) {
      const res = await fetch(`${BACKEND.url}?action=statuses&t=${Date.now()}`, { redirect: 'follow' });
      if (!res.ok) throw new Error(`http-${res.status}`);
      return res.json();
    }
    const res = await fetch('data/status.json', { cache: 'no-cache' });
    return res.ok ? res.json() : { statuses: {} };
  },
  reserve: (pid, code, password, by) => call('reserve', { pid, code, password, by }),
  markSold: (pid, code, password, by) => call('sold', { pid, code, password, by }),
  release: (pid, code, password, by) => call('release', { pid, code, password, by }),
  interest: (lead) => call('interest', { lead }),
};
