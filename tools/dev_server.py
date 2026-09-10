"""Development server for the site.

* Static files with caching disabled (python -m http.server lets Chrome keep stale index.html / JS between edits).
* A mock of the sales backend at /api with the same contract and rules as tools/backend/Code.gs, so the reserve /
  sold / lead flows can be tested locally without Google. State is in memory (restart = everything available again).
  Passwords: LH_RESERVE_PASSWORD / LH_ADMIN_PASSWORD environment variables (default reserve123 / admin123).

Run:  python tools/dev_server.py [port] [root]      (default 5173, the SITE folder)
Then open http://localhost:5173/?backend=http://localhost:5173/api to point the page at the mock backend.
"""
import functools, http.server, json, os, re, sys, threading, time
from urllib.parse import urlparse, parse_qs

PID_RE = re.compile(r'^LH_[0-9a-f]{32}(-[12])?$')   # -1 / -2 = the two sides of a semi-detached house
STATUSES = ('available', 'reserved', 'sold')
RESERVE_PW = os.environ.get('LH_RESERVE_PASSWORD', 'reserve123')
ADMIN_PW = os.environ.get('LH_ADMIN_PASSWORD') or RESERVE_PW   # one password for everything unless an admin one is set
MAX_FAILED_LOGINS, MAX_LEADS_PER_HOUR = 8, 40

class Backend:
    """In-memory twin of Code.gs: same transitions, same error codes, one change at a time."""
    def __init__(self):
        self.lock = threading.Lock()
        self.statuses = {}          # pid -> {status, updatedAt, by}
        self.log, self.leads = [], []
        self.failed, self.failed_at = 0, 0.0
        self.leads_hour = []

    def role(self, password):
        if password and password == ADMIN_PW: return 'admin'
        if password and password == RESERVE_PW: return 'sales'
        return None

    def unlock(self, body):
        if time.time() - self.failed_at > 600: self.failed = 0
        if self.failed >= MAX_FAILED_LOGINS: return {'error': 'throttled'}
        if self.role(str(body.get('password', ''))) is None:
            self.failed += 1; self.failed_at = time.time(); return {'error': 'unauthorized'}
        return {'ok': True}

    def public(self):
        return {pid: s for pid, s in self.statuses.items() if s['status'] != 'available'}

    def change(self, action, body):
        pid = str(body.get('pid', '')).strip()
        if not PID_RE.match(pid): return {'error': 'bad-request'}
        by = str(body.get('by', '')).strip()[:80]
        if time.time() - self.failed_at > 600: self.failed = 0
        if self.failed >= MAX_FAILED_LOGINS: return {'error': 'throttled'}
        role = self.role(str(body.get('password', '')))
        allowed = role in ('sales', 'admin') if action == 'reserve' else role == 'admin'
        if not allowed:
            self.failed += 1; self.failed_at = time.time()
            self.log.append((time.time(), pid, action, 'DENIED', by))
            return {'error': 'unauthorized'}
        with self.lock:
            current = self.statuses.get(pid, {}).get('status', 'available')
            time.sleep(0.05)   # widen the window so a race would show up if the lock were missing
            if action == 'reserve':
                if current != 'available': return {'error': 'not-available', 'current': current}
                nxt = 'reserved'
            elif action == 'sold':
                if current == 'sold': return {'error': 'not-available', 'current': current}
                nxt = 'sold'
            else:
                if current == 'available': return {'error': 'not-available', 'current': current}
                nxt = 'available'
            now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            rec = {'status': nxt, 'updatedAt': now, 'by': by or role}
            self.statuses[pid] = rec
            self.log.append((time.time(), pid, action, f'{current} -> {nxt}', by or role))
            print(f'[api] {action} {body.get("code", "")} {pid} {current} -> {nxt} by {by or role}', flush=True)
            return {'ok': True, 'status': rec, 'statuses': self.public()}

    def interest(self, lead):
        name = str(lead.get('name', '')).strip()[:120]; email = str(lead.get('email', '')).strip()[:160]
        pid = str(lead.get('pid', '')).strip()
        if str(lead.get('website', '')): return {'ok': True}
        if len(name) < 2 or not re.match(r'^[^\s@]+@[^\s@]+\.[^\s@]{2,}$', email): return {'error': 'invalid-lead'}
        if not PID_RE.match(pid): return {'error': 'bad-request'}
        now = time.time()
        self.leads_hour = [t for t in self.leads_hour if now - t < 3600]
        if len(self.leads_hour) >= MAX_LEADS_PER_HOUR: return {'error': 'throttled'}
        self.leads_hour.append(now)
        self.leads.append(dict(lead, receivedAt=now))
        print(f'[api] LEAD {lead.get("code")} {pid} {name} <{email}> {lead.get("phone", "")}: {str(lead.get("message", ""))[:80]}', flush=True)
        return {'ok': True, 'emailed': False, 'mock': True}

BACKEND = Backend()

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '404' in str(args): super().log_message(fmt, *args)

    def _json(self, obj, code=200):
        data = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path.rstrip('/') == '/api':
            action = parse_qs(u.query).get('action', ['statuses'])[0]
            if action == 'statuses': return self._json({'statuses': BACKEND.public(), 'serverTime': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
            if action == 'ping': return self._json({'ok': True, 'version': 'mock'})
            if action == 'leads': return self._json({'leads': BACKEND.leads})
            if action == 'log': return self._json({'log': BACKEND.log})
            return self._json({'error': 'unknown-action'})
        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        if u.path.rstrip('/') != '/api': return self._json({'error': 'not-found'}, 404)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0)) or 0) or b'{}')
        except Exception:
            return self._json({'error': 'bad-request'})
        action = str(body.get('action', ''))
        if action == 'interest': return self._json(BACKEND.interest(body.get('lead') or {}))
        if action in ('reserve', 'sold', 'release'): return self._json(BACKEND.change(action, body))
        if action == 'unlock': return self._json(BACKEND.unlock(body))
        return self._json({'error': 'unknown-action'})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    root = sys.argv[2] if len(sys.argv) > 2 else os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
    handler = functools.partial(Handler, directory=root)
    http.server.ThreadingHTTPServer.allow_reuse_address = False   # on Windows "reuse" would silently share the port with a stale server
    with http.server.ThreadingHTTPServer(('127.0.0.1', port), handler) as httpd:
        print(f'serving {root} on http://localhost:{port} (no-cache) - mock sales API at /api', flush=True)
        httpd.serve_forever()
