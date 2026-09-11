// Sales backend client. The authoritative state lives in the Google Apps Script web app (tools/backend/Code.gs).
// Without a backend URL the page runs read-only: statuses come from data/status.json and leads fall back to e-mail.
import { BACKEND } from './config.js?v=24';

// local testing only: http://localhost:5173/?backend=http://localhost:5173/api points the page at the mock backend of tools/dev_server.py
const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const override = LOCAL ? new URLSearchParams(location.search).get('backend') : null;
if (override && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(override)) BACKEND.url = override;

const hasBackend = () => !!(BACKEND.url && (BACKEND.url.startsWith('https://') || (LOCAL && BACKEND.url.startsWith('http://'))));

// Apps Script answers through a googleusercontent redirect that occasionally fails (404 / network): retry a few times
async function fetchJson(url, init, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`http-${res.status}`);
      return await res.json();
    } catch (e) { last = e; await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
  }
  throw last;
}
async function call(action, payload = {}) {
  if (!hasBackend()) throw new Error('no-backend');
  // text/plain keeps the request "simple" (no CORS preflight), which is what Apps Script web apps support
  const data = await fetchJson(BACKEND.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, ...payload }), redirect: 'follow' }, 2);
  if (data && data.error) throw new Error(data.error);
  return data;
}

export const api = {
  hasBackend,
  // -> { statuses: { [pid]: { status, updatedAt, by } }, serverTime }
  async statuses() {
    if (hasBackend()) return fetchJson(`${BACKEND.url}?action=statuses&t=${Date.now()}`, { redirect: 'follow' }, 3);
    const res = await fetch('data/status.json', { cache: 'no-cache' });
    return res.ok ? res.json() : { statuses: {} };
  },
  // colour = facade colour chosen in the panel (stored with the reservation by the backend)
  reserve: (pid, code, password, by, colour) => call('reserve', { pid, code, password, by, colour }),
  markSold: (pid, code, password, by, colour) => call('sold', { pid, code, password, by, colour }),
  release: (pid, code, password, by, colour) => call('release', { pid, code, password, by, colour }),
  // phases gate: the password is checked by the backend, never in the page. Deployments older than the 'unlock'
  // action are probed with a 'release' on a property id that cannot exist: the server answers 'not-available' when
  // the password is right (nothing changes) and 'unauthorized' when it is not.
  unlock: async (password) => {
    try { return await call('unlock', { password }); }
    catch (e) {
      if (e.message !== 'unknown-action') throw e;
      try { await call('release', { pid: 'LH_' + '0'.repeat(32), code: '-', password, by: 'unlock' }); }
      catch (e2) { if (e2.message === 'not-available') return { ok: true }; throw e2; }
      return { ok: true };
    }
  },
  interest: (lead) => call('interest', { lead }),
};
