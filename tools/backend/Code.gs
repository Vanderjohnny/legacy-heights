/**
 * Legacy Heights — sales backend (Google Apps Script web app bound to a Google Sheet).
 *
 * Authoritative store of the commercial status of every property (AVAILABLE / RESERVED / SOLD), the change log
 * and the "I'm interested" leads. The website (src/api.js) talks to this script only; passwords never reach the
 * browser code: they live in the script properties of this project and every change is validated here.
 *
 *   GET  ?action=statuses            -> { statuses: { [pid]: { status, updatedAt, by } }, serverTime }
 *   POST { action: 'reserve'|'sold'|'release', pid, code, password, by }
 *   POST { action: 'interest', lead: { pid, code, name, email, phone, message, ... } }
 *
 * Setup (see README.md next to this file): run setup() once, fill the script properties
 * RESERVE_PASSWORD, SALES_EMAIL (optionally ADMIN_PASSWORD for a separate sold/release password, NOTIFY_EMAILS, SITE_URL), then deploy as a web app
 * ("Execute as: me", "Who has access: anyone") and paste the /exec URL into src/config.js (BACKEND.url).
 */
const VERSION = '2026-09-09';
const SHEET_STATUS = 'Status', SHEET_LOG = 'Log', SHEET_LEADS = 'Leads';
const STATUSES = ['available', 'reserved', 'sold'];
const PID_RE = /^LH_[0-9a-f]{32}(-[12])?$/;   // -1 / -2 = the two sides of a semi-detached house
const MAX_FAILED_LOGINS = 8;          // per 10 minutes, across all clients (Apps Script has no client IP)
const MAX_LEADS_PER_HOUR = 40;

// ---------------------------------------------------------------------------------------------------------------
// HTTP entry points
// ---------------------------------------------------------------------------------------------------------------
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'statuses';
  if (action === 'statuses') return json_({ statuses: readStatuses_(true), serverTime: new Date().toISOString() });
  if (action === 'ping') return json_({ ok: true, version: VERSION, serverTime: new Date().toISOString() });
  return json_({ error: 'unknown-action' });
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'bad-request' }); }
  var action = String(body.action || '');
  try {
    if (action === 'interest') return json_(handleInterest_(body.lead || {}));
    if (action === 'reserve' || action === 'sold' || action === 'release') return json_(handleStatusChange_(action, body));
    return json_({ error: 'unknown-action' });
  } catch (err) {
    console.error(err);
    return json_({ error: 'server-error', detail: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------------------------------------------
// Status changes (reserve / sold / release): password checked here, one change at a time (LockService)
// ---------------------------------------------------------------------------------------------------------------
function handleStatusChange_(action, body) {
  var pid = String(body.pid || '').trim();
  if (!PID_RE.test(pid)) return { error: 'bad-request' };
  var by = String(body.by || '').trim().slice(0, 80);
  var password = String(body.password || '');
  var cache = CacheService.getScriptCache();
  var failKey = 'failed-logins';
  var failed = Number(cache.get(failKey) || 0);
  if (failed >= MAX_FAILED_LOGINS) return { error: 'throttled' };

  var role = checkPassword_(password);           // 'admin' | 'sales' | null
  var allowed = action === 'reserve' ? (role === 'sales' || role === 'admin') : role === 'admin';
  if (!allowed) {
    cache.put(failKey, String(failed + 1), 600);
    appendLog_(pid, body.code, action, 'DENIED', by, role ? 'insufficient role' : 'wrong password');
    return { error: 'unauthorized' };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { error: 'busy' };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_STATUS) || setup_().statusSheet;
    var rows = sheet.getDataRange().getValues();
    var rowIndex = -1, current = 'available';
    for (var i = 1; i < rows.length; i++) if (String(rows[i][0]) === pid) { rowIndex = i + 1; current = normalize_(rows[i][2]); break; }

    var next;
    if (action === 'reserve') { if (current !== 'available') return { error: 'not-available', current: current }; next = 'reserved'; }
    else if (action === 'sold') { if (current === 'sold') return { error: 'not-available', current: current }; next = 'sold'; }
    else { if (current === 'available') return { error: 'not-available', current: current }; next = 'available'; }

    var now = new Date();
    var code = String(body.code || (rowIndex > 0 ? rows[rowIndex - 1][1] : '')).slice(0, 40);
    var record = [pid, code, next, now.toISOString(), by || role, action];
    if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, record.length).setValues([record]);
    else sheet.appendRow(record);
    SpreadsheetApp.flush();
    appendLog_(pid, code, action, current + ' -> ' + next, by || role, '');
    cache.remove('statuses');
    notify_('Legacy Heights: ' + code + ' ' + next.toUpperCase(), 'Property ' + code + ' (' + pid + ') changed from ' + current + ' to ' + next + ' by ' + (by || role) + ' at ' + now.toISOString() + '.');
    return { ok: true, status: { status: next, updatedAt: now.toISOString(), by: by || role }, statuses: readStatuses_(false) };
  } finally {
    lock.releaseLock();
  }
}

// Passwords live in the script properties (Project settings > Script properties). Never in this code, never in the site.
function checkPassword_(password) {
  if (!password) return null;
  var p = PropertiesService.getScriptProperties();
  var sales = p.getProperty('RESERVE_PASSWORD') || p.getProperty('SALES_PASSWORD') || '';
  var admin = p.getProperty('ADMIN_PASSWORD') || sales;   // one password for everything when ADMIN_PASSWORD is not set
  if (admin && safeEqual_(password, admin)) return 'admin';
  if (sales && safeEqual_(password, sales)) return 'sales';
  return null;
}
function safeEqual_(a, b) {   // compare digests so the comparison time does not depend on where the strings differ
  var da = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, a, Utilities.Charset.UTF_8);
  var db = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, b, Utilities.Charset.UTF_8);
  var diff = 0;
  for (var i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}
function normalize_(s) { s = String(s || '').trim().toLowerCase(); return STATUSES.indexOf(s) >= 0 ? s : 'available'; }

function readStatuses_(useCache) {
  var cache = CacheService.getScriptCache();
  if (useCache) { var hit = cache.get('statuses'); if (hit) return JSON.parse(hit); }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_STATUS);
  var out = {};
  if (sheet) {
    var rows = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      var pid = String(rows[i][0]).trim();
      if (!PID_RE.test(pid)) continue;
      var st = normalize_(rows[i][2]);
      if (st === 'available') continue;   // the site treats missing entries as available: keeps the payload small
      out[pid] = { status: st, updatedAt: rows[i][3] instanceof Date ? rows[i][3].toISOString() : String(rows[i][3] || ''), by: String(rows[i][4] || '') };
    }
  }
  try { cache.put('statuses', JSON.stringify(out), 20); } catch (err) { /* payload too large for the cache: fine */ }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Leads ("I'm interested"): stored in the Leads sheet and e-mailed to the sales team. Never changes a status.
// ---------------------------------------------------------------------------------------------------------------
function handleInterest_(lead) {
  var name = String(lead.name || '').trim().slice(0, 120);
  var email = String(lead.email || '').trim().slice(0, 160);
  var phone = String(lead.phone || '').trim().slice(0, 60);
  var message = String(lead.message || '').trim().slice(0, 2000);
  var pid = String(lead.pid || '').trim(), code = String(lead.code || '').trim().slice(0, 40);
  if (String(lead.website || '')) return { ok: true };                       // honeypot field filled by a bot: pretend success
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { error: 'invalid-lead' };
  if (!PID_RE.test(pid)) return { error: 'bad-request' };
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get('leads-hour') || 0);
  if (n >= MAX_LEADS_PER_HOUR) return { error: 'throttled' };
  cache.put('leads-hour', String(n + 1), 3600);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_LEADS) || setup_().leadsSheet;
  var now = new Date();
  sheet.appendRow([now.toISOString(), code, pid, String(lead.model || ''), String(lead.parcel || ''), name, email, phone, message, String(lead.lang || ''), String(lead.page || '')]);
  var p = PropertiesService.getScriptProperties();
  var to = p.getProperty('SALES_EMAIL');
  if (to) {
    var subject = 'Legacy Heights lead: Lot ' + code + ' - ' + name;
    var text = ['New interest registered on the Legacy Heights website', '', 'Property: Lot ' + code + ' (' + String(lead.model || '') + ', parcel ' + String(lead.parcel || '') + ')', 'Property ID: ' + pid, '', 'Name: ' + name, 'E-mail: ' + email, 'Phone: ' + (phone || '-'), '', 'Message:', message || '-', '', 'Page: ' + String(lead.page || ''), 'Received: ' + now.toISOString()].join('\n');
    try { MailApp.sendEmail({ to: to, subject: subject, body: text, replyTo: email, name: 'Legacy Heights website' }); }
    catch (err) { console.error('lead e-mail failed', err); return { ok: true, emailed: false }; }
  }
  return { ok: true, emailed: !!to };
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------
function appendLog_(pid, code, action, result, by, note) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_LOG) || setup_().logSheet;
    sheet.appendRow([new Date().toISOString(), pid, String(code || ''), action, result, String(by || ''), String(note || '')]);
  } catch (err) { console.error('log failed', err); }
}
function notify_(subject, body) {
  var to = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAILS');
  if (!to) return;
  try { MailApp.sendEmail({ to: to, subject: subject, body: body, name: 'Legacy Heights website' }); } catch (err) { console.error('notify failed', err); }
}

/** Run once from the editor: creates the sheets with their headers. Then fill the script properties. */
function setup() {
  var r = setup_();
  var p = PropertiesService.getScriptProperties();
  var missing = ['RESERVE_PASSWORD', 'SALES_EMAIL'].filter(function (k) { return !p.getProperty(k); });
  Logger.log('Sheets ready: ' + [r.statusSheet.getName(), r.logSheet.getName(), r.leadsSheet.getName()].join(', '));
  Logger.log(missing.length ? 'Now set the script properties: ' + missing.join(', ') + ' (Project settings > Script properties)' : 'Script properties present.');
}
function setup_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ensure = function (name, headers) {
    var s = ss.getSheetByName(name);
    if (!s) { s = ss.insertSheet(name); s.appendRow(headers); s.setFrozenRows(1); }
    return s;
  };
  return {
    statusSheet: ensure(SHEET_STATUS, ['property_id', 'lot', 'status', 'updated_at', 'by', 'last_action']),
    logSheet: ensure(SHEET_LOG, ['time', 'property_id', 'lot', 'action', 'result', 'by', 'note']),
    leadsSheet: ensure(SHEET_LEADS, ['time', 'lot', 'property_id', 'model', 'parcel', 'name', 'email', 'phone', 'message', 'lang', 'page']),
  };
}

/** Optional: pre-fill the Status sheet with every property of the site (SITE_URL script property = the public site URL). */
function importRegistry() {
  var base = PropertiesService.getScriptProperties().getProperty('SITE_URL');
  if (!base) throw new Error('Set the SITE_URL script property first (e.g. https://vanderjohnny.github.io/legacy-heights/)');
  var doc = JSON.parse(UrlFetchApp.fetch(base.replace(/\/?$/, '/') + 'data/properties.json').getContentText());
  var sheet = setup_().statusSheet;
  var rows = sheet.getDataRange().getValues();
  var have = {};
  for (var i = 1; i < rows.length; i++) have[String(rows[i][0])] = true;
  var add = [];
  Object.keys(doc.properties).forEach(function (pid) { if (!have[pid]) add.push([pid, doc.properties[pid].code, 'available', '', '', 'import']); });
  if (add.length) sheet.getRange(sheet.getLastRow() + 1, 1, add.length, 6).setValues(add);
  Logger.log('added ' + add.length + ' properties');
}
