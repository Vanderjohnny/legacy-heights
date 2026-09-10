"""End-to-end test of the sales backend (Google Apps Script deployment or the local mock in tools/dev_server.py).

    python tools/backend/test_backend.py <backend url> --reserve <sales password> --admin <admin password> [--pid LH_...]

Covers the happy paths (reserve, sold, release, lead), the failure paths (wrong password, wrong role, reserving a
reserved property, invalid lead) and a concurrency test (8 parallel reservations of the same property: exactly one
wins). The property used for the test is left AVAILABLE at the end.
"""
import argparse, concurrent.futures, json, os, sys, time
import requests

ap = argparse.ArgumentParser()
ap.add_argument('url')
ap.add_argument('--reserve', default=os.environ.get('LH_RESERVE_PASSWORD', 'reserve123'))
ap.add_argument('--admin', default=os.environ.get('LH_ADMIN_PASSWORD') or None, help='separate admin password (defaults to the sales password)')
ap.add_argument('--pid', default=None)
ap.add_argument('--skip-lead', action='store_true', help='do not send the test lead (avoids a test e-mail to the sales team)')
args = ap.parse_args()
if not args.admin: args.admin = args.reserve
URL = args.url.rstrip('/')

SITE = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
if not args.pid:
    reg = json.load(open(os.path.join(SITE, 'data', 'properties.json'), encoding='utf-8'))['properties']
    args.pid = sorted(reg)[-1]     # any property; the last id keeps the test away from the first lots people look at
    CODE = reg[args.pid]['code']
else:
    CODE = 'TEST'

def _retry(fn, tries=4):
    # the Apps Script answer is served through a googleusercontent redirect that occasionally 404s: retry a few times
    for i in range(tries):
        try: return fn()
        except Exception as e:
            if i == tries - 1: raise
            time.sleep(1.5 * (i + 1))

def post(payload):
    def go():
        r = requests.post(URL, data=json.dumps(payload), headers={'Content-Type': 'text/plain;charset=utf-8'}, timeout=60, allow_redirects=True)
        r.raise_for_status()
        return r.json()
    return _retry(go)

def get_statuses():
    def go():
        r = requests.get(f'{URL}?action=statuses&t={int(time.time() * 1000)}', timeout=60)
        r.raise_for_status()
        return r.json()['statuses']
    return _retry(go)

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if detail and not cond else ''))

pid = args.pid
print(f'backend: {URL}\nproperty: {pid} ({CODE})\n')

# make sure the property starts available (release needs the admin password; ignore "not-available")
post({'action': 'release', 'pid': pid, 'code': CODE, 'password': args.admin, 'by': 'test'})
check('statuses endpoint answers', isinstance(get_statuses(), dict))
check('property starts available', pid not in get_statuses())

r = post({'action': 'reserve', 'pid': pid, 'code': CODE, 'password': 'definitely-wrong', 'by': 'test'})
check('wrong password is rejected', r.get('error') == 'unauthorized', json.dumps(r))
r = post({'action': 'sold', 'pid': pid, 'code': CODE, 'password': args.reserve, 'by': 'test'})
check('sales password cannot mark as sold (only when a separate admin password is set)', r.get('error') == 'unauthorized' if args.admin != args.reserve else r.get('ok') is True, json.dumps(r))
if args.admin == args.reserve and r.get('ok'): post({'action': 'release', 'pid': pid, 'code': CODE, 'password': args.admin, 'by': 'test'})
r = post({'action': 'reserve', 'pid': 'LH_notanid', 'code': CODE, 'password': args.reserve, 'by': 'test'})
check('malformed property id is rejected', r.get('error') == 'bad-request', json.dumps(r))

# concurrency: 8 parallel reservations, exactly one succeeds
def try_reserve(i):
    try: return post({'action': 'reserve', 'pid': pid, 'code': CODE, 'password': args.reserve, 'by': f'racer-{i}'})
    except Exception as e: return {'error': f'exception: {e}'}
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
    outs = list(ex.map(try_reserve, range(8)))
oks = [o for o in outs if o.get('ok')]
busy = [o for o in outs if o.get('error') == 'busy']
check('concurrent reserve: exactly one wins', len(oks) == 1, json.dumps(outs))
check('concurrent reserve: the others get not-available (or busy)', all(o.get('ok') or o.get('error') in ('not-available', 'busy') for o in outs), json.dumps(outs))
st = get_statuses().get(pid, {})
check('property is now reserved', st.get('status') == 'reserved', json.dumps(st))
check('reserved record carries who / when', bool(st.get('updatedAt')) and bool(st.get('by')), json.dumps(st))

r = post({'action': 'reserve', 'pid': pid, 'code': CODE, 'password': args.reserve, 'by': 'test'})
check('reserving a reserved property fails with not-available', r.get('error') == 'not-available', json.dumps(r))
r = post({'action': 'sold', 'pid': pid, 'code': CODE, 'password': args.admin, 'by': 'test-admin'})
check('admin marks as sold', r.get('ok') and r['status']['status'] == 'sold', json.dumps(r))
r = post({'action': 'sold', 'pid': pid, 'code': CODE, 'password': args.admin, 'by': 'test-admin'})
check('selling twice fails with not-available', r.get('error') == 'not-available', json.dumps(r))
r = post({'action': 'release', 'pid': pid, 'code': CODE, 'password': args.admin, 'by': 'test-admin'})
check('admin releases back to available', r.get('ok') and r['status']['status'] == 'available', json.dumps(r))
check('property available again', pid not in get_statuses())

r = post({'action': 'interest', 'lead': {'pid': pid, 'code': CODE, 'name': 'X', 'email': 'not-an-email'}})
check('invalid lead is rejected', r.get('error') == 'invalid-lead', json.dumps(r))
if not args.skip_lead:
    r = post({'action': 'interest', 'lead': {'pid': pid, 'code': CODE, 'name': 'Backend test', 'email': 'test@example.com', 'phone': '+1 246 000 0000', 'message': 'automated test lead - please ignore', 'model': 'Test', 'parcel': 'A', 'lang': 'en', 'page': URL}})
    check('valid lead is accepted', r.get('ok') is True, json.dumps(r))
    check('lead does not change the status', pid not in get_statuses())
r = post({'action': 'nonsense'})
check('unknown action is rejected', r.get('error') == 'unknown-action', json.dumps(r))

failed = [n for n, ok in results if not ok]
print(f'\n{len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
