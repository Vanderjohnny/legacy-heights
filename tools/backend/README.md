# Legacy Heights — sales backend (Google Apps Script)

**Deployed on 2026-09-10.** Sheet: *Legacy Heights - Vendas* (https://docs.google.com/spreadsheets/d/1wRDb_w3OYBIOkZGBAqLkqmvOWeoV8xB-hfBJ7kvOG-k),
Apps Script project *Legacy Heights Sales* (Extensions > Apps Script from that sheet), web app URL in `src/config.js`
(`BACKEND.url`). The sales password is the `RESERVE_PASSWORD` script property (it serves reserve, sold and release).

The commercial status of each property (AVAILABLE / RESERVED / SOLD), the change log and the leads live in a
Google Sheet. `Code.gs` is a small web app bound to that sheet; the website calls it through `src/api.js`.
Passwords are **script properties** of the Apps Script project: they are never written in the website code.

## Deploy (about 10 minutes, once)

1. Create a Google Sheet, e.g. **Legacy Heights – Sales** (any Google account of the sales team).
2. In the sheet: **Extensions → Apps Script**. Delete the sample code, paste the content of `Code.gs`, save.
3. In the editor choose the function **`setup`** and click **Run**. Authorise the script when asked
   (it needs access to this spreadsheet and to send e-mail). The sheets `Status`, `Log`, `Leads` are created.
4. **Project settings (gear icon) → Script properties → Add script property**:

   | property           | value                                                                 |
   |--------------------|-----------------------------------------------------------------------|
   | `RESERVE_PASSWORD` | the sales password: reserve, mark as sold, release                    |
   | `ADMIN_PASSWORD`   | optional: a separate password for sold / release (defaults to the one above) |
   | `SALES_EMAIL`      | who receives the "I'm interested" leads, e.g. `sales@unk.group`       |
   | `NOTIFY_EMAILS`    | optional: comma-separated addresses notified of every status change   |
   | `SITE_URL`         | optional: public site URL, used by `importRegistry` (pre-fills lots)  |

5. **Deploy → New deployment → type: Web app**. *Execute as:* **Me**. *Who has access:* **Anyone**. Deploy and
   copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).
6. In the site, `src/config.js`: set `BACKEND.url` to that URL (and `salesEmail` if different), bump the
   `?v=` query of `config.js`/`api.js`/`main.js` imports, publish the site.
7. Optional: run `importRegistry` once (after setting `SITE_URL`) so the `Status` sheet lists every property.

After changing `Code.gs` later: **Deploy → Manage deployments → edit → version: New version → Deploy**
(the URL stays the same).

## Behaviour

* `reserve` needs the sales or admin password and only works while the property is AVAILABLE.
  Two people reserving the same property at the same time: the script lock serialises the requests, the second one
  gets `not-available` and the site refreshes its statuses.
* `sold` needs the admin password (from AVAILABLE or RESERVED). `release` (admin) puts a property back to AVAILABLE.
* `interest` stores the lead in the `Leads` sheet and e-mails `SALES_EMAIL` (reply-to = the visitor). It never
  changes a status.
* 8 wrong passwords within 10 minutes block further attempts for 10 minutes (`throttled`); leads are capped at 40/hour.
* Errors returned to the site: `unauthorized`, `not-available`, `throttled`, `busy`, `invalid-lead`, `bad-request`.

## Test

```
python tools/backend/test_backend.py https://script.google.com/macros/s/…/exec --reserve <sales pw> --admin <admin pw>
```

runs the happy paths, the failure paths and a concurrency test (8 parallel reservations of one property: exactly
one succeeds) and leaves the test property AVAILABLE. Locally, `tools/dev_server.py` exposes the same API at
`http://localhost:5173/api` (passwords from the `LH_RESERVE_PASSWORD` / `LH_ADMIN_PASSWORD` environment variables,
default `reserve123` / `admin123`) for testing the site without Google.
