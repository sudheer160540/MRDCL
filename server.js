/* MRDCL Household Survey Portal — dependency-free Node.js server. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5890);
const DATASET = path.join(ROOT, 'data', 'households.geojson');
const MAP_LAYERS = path.join(ROOT, 'data', 'map-layers.json');
const BIFURCATED_LAYER = path.join(ROOT, 'data', 'bifurcated-buildings.geojson');
const DB_FILE = path.join(ROOT, 'database', 'mrdcl-surveys.db');
const UPLOAD_DIR = path.join(ROOT, 'data', 'uploads');
const EDITABLE_FIELDS = new Set([
  'BuildingID', 'BuiType', 'StructType', 'NameOwnRep', 'Contact', 'HNoPlotNo', 'TPIN',
  'ColnyStrtN', 'SyTsNo', 'WardBlockN', 'Use', 'Extent', 'PlinthArea', 'Classifica',
  'Caste', 'FinanDepen', 'HHSize', 'NoAdults', 'NoChild', 'Govtbenefi', 'Borewell',
  'Courtcase', 'NameStruct', 'ReliType', 'Remarks', 'CommStatus', 'Trees', 'Occupation',
  'SkilledOcc', 'Craftsmen', 'ReliStruct', 'Cremetoriu', 'Email', 'SurvyeorNa',
  'Survey_Dat', 'Survey_Loc', 'UUID', 'email_id', 'Mandals', 'Zone', 'Income', 'Dist',
  'PCs', 'Assembly_C', 'S_Fall', 'Zone_1', 'Affected_S', 'Zonewise', 'no_of_Floo',
  'assigned_team', 'survey_status', 'verification_status', 'field_notes', 'follow_up_date'
]);
function isEditableField(key) { return EDITABLE_FIELDS.has(key) || /^q_[a-z0-9_]{2,90}$/.test(key) || key === 'household_members' || key === 'occupier_members'; }
const STATIC_DIR = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

function now() { return new Date().toISOString(); }
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
function text(res, status, body) { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(body); }
function download(res, filename, contentType, body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(bytes);
}
function parseJson(value, fallback = {}) { try { return JSON.parse(value); } catch { return fallback; } }
function hash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, value: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function secureEqual(left, right) {
  const a = Buffer.from(left || ''); const b = Buffer.from(right || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(item => {
    const point = item.indexOf('='); return [item.slice(0, point).trim(), decodeURIComponent(item.slice(point + 1))];
  }));
}
function currentUser(req) {
  const token = parseCookies(req).mrdcl_session;
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.team_id, t.name AS team_name FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN teams t ON t.id=u.team_id WHERE s.token=? AND s.expires_at>?`).get(token, now());
  return row || null;
}
function requireUser(req, res, roles = ['admin', 'editor', 'authority']) {
  const user = currentUser(req);
  if (!user) { json(res, 401, { error: 'Please sign in to continue.' }); return null; }
  if (!roles.includes(user.role)) { json(res, 403, { error: 'Your role does not have access to this action.' }); return null; }
  return user;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > 12_000_000) reject(new Error('Request is too large.')); else body += chunk; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON.')); } });
    req.on('error', reject);
  });
}
function toHousehold(row, includeGeometry = true) {
  const baseline = parseJson(row.baseline); const survey = parseJson(row.survey);
  return {
    id: row.id,
    geometry: includeGeometry ? parseJson(row.geometry, null) : undefined,
    baseline,
    survey,
    properties: { ...baseline, ...survey, household_id: row.id },
    revision: row.revision,
    updated_at: row.updated_at,
    updated_by: row.updated_by
  };
}
function addAudit(user, action, householdId, detail) {
  db.prepare('INSERT INTO audit_log (at, user_id, username, action, household_id, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(now(), user.id, user.username, action, householdId || null, detail || null);
}
function teamForUser(user) {
  if (user.team_name) return user.team_name;
  if (user.username === 'team1') return 'Team 1';
  if (user.username === 'team2') return 'Team 2';
  return user.display_name;
}
function xml(value) { return String(value ?? '').replace(/[<>&'\"]/g, char => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', "'":'&apos;', '"':'&quot;' }[char])); }
function exportRows() { return db.prepare('SELECT * FROM households ORDER BY id').all().map(row => toHousehold(row)); }
function exportProperties(item) { return { household_id: item.id, ...item.properties, gis_geometry_geojson: JSON.stringify(item.geometry) }; }
function csvCell(value) { const textValue = String(value ?? ''); return /[",\r\n]/.test(textValue) ? `"${textValue.replace(/"/g, '""')}"` : textValue; }
function buildCsv(rows) {
  const records = rows.map(exportProperties); const columns = [...new Set(records.flatMap(record => Object.keys(record)))];
  return [columns.map(csvCell).join(','), ...records.map(record => columns.map(column => csvCell(record[column])).join(','))].join('\r\n');
}
function polygonCoordinates(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}
function buildKml(rows) {
  const placemarks = rows.map(item => {
    const p = item.properties; const polygons = polygonCoordinates(item.geometry).map(polygon => `<Polygon><outerBoundaryIs><LinearRing><coordinates>${polygon[0].map(point => `${point[0]},${point[1]},0`).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>`).join('');
    return `<Placemark><name>${xml(p.BuildingID || item.id)}</name><description>${xml(`Household ID: ${item.id}\nPlot: ${p.HNoPlotNo || 'Not recorded'}\nStatus: ${p.survey_status || 'Not started'}`)}</description>${polygons ? `<MultiGeometry>${polygons}</MultiGeometry>` : ''}</Placemark>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>MRDCL Household Survey Export</name>${placemarks}</Document></kml>`;
}
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function zip(files) {
  let offset = 0; const locals = []; const directory = [];
  for (const file of files) {
    const name = Buffer.from(file.name); const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8'); const compressed = zlib.deflateRawSync(raw); const crc = crc32(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    const localFile = Buffer.concat([local, name, compressed]); locals.push(localFile); directory.push(Buffer.concat([central, name])); offset += localFile.length;
  }
  const directoryBytes = Buffer.concat(directory); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, directoryBytes, end]);
}
function excelColumn(index) { let name = ''; for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + ((value - 1) % 26)) + name; return name; }
function xlsxCell(value, index, row) { const safe = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 32767); return `<c r="${excelColumn(index)}${row}" t="inlineStr"><is><t${/^\s|\s$/.test(safe) ? ' xml:space="preserve"' : ''}>${xml(safe)}</t></is></c>`; }
function buildXlsx(rows) {
  const records = rows.map(exportProperties); const columns = [...new Set(records.flatMap(record => Object.keys(record)))];
  const sheetRows = [columns, ...records.map(record => columns.map(column => record[column]))].map((values, rowIndex) => `<row r="${rowIndex + 1}">${values.map((value, index) => xlsxCell(value, index, rowIndex + 1)).join('')}</row>`).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  return zip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Household register" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheet }
  ]);
}
function buildWord(rows) {
  const records = rows.map(exportProperties); const columns = [...new Set(records.flatMap(record => Object.keys(record)))];
  const header = columns.map(column => `<th>${xml(column.replace(/_/g, ' '))}</th>`).join(''); const body = records.map(record => `<tr>${columns.map(column => `<td>${xml(record[column])}</td>`).join('')}</tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>MRDCL Household Survey Export</title><style>body{font-family:Arial,sans-serif;font-size:9pt}h1{font-size:16pt;color:#102a43}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d9e2ec;padding:4px;text-align:left;vertical-align:top}th{background:#102a43;color:#fff}</style></head><body><h1>MRDCL Household Survey Register</h1><p>Exported ${xml(new Date().toLocaleString())}. ${rows.length} household records.</p><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}
function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','editor','authority')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS households (
      id TEXT PRIMARY KEY, geometry TEXT NOT NULL, baseline TEXT NOT NULL, survey TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT, updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id INTEGER, username TEXT NOT NULL,
      action TEXT NOT NULL, household_id TEXT, detail TEXT
    );
    CREATE TABLE IF NOT EXISTS photo_uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, household_id TEXT NOT NULL, filename TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL, mime_type TEXT NOT NULL, latitude REAL, longitude REAL,
      captured_at TEXT NOT NULL, uploaded_at TEXT NOT NULL, uploaded_by TEXT NOT NULL,
      FOREIGN KEY(household_id) REFERENCES households(id) ON DELETE CASCADE
    );
  `);
  fs.mkdirSync(UPLOAD_DIR, { recursive:true });
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
  if (!userColumns.includes('team_id')) db.exec('ALTER TABLE users ADD COLUMN team_id INTEGER REFERENCES teams(id)');
  const createTeam = db.prepare('INSERT OR IGNORE INTO teams (name, created_at) VALUES (?, ?)');
  createTeam.run('Team 1', now()); createTeam.run('Team 2', now());
  if (db.prepare('SELECT COUNT(*) AS count FROM households').get().count === 0) {
    if (!fs.existsSync(DATASET)) throw new Error(`Missing baseline data: ${DATASET}. Run npm run import:households first.`);
    const source = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
    const insert = db.prepare('INSERT INTO households (id, geometry, baseline) VALUES (?, ?, ?)');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const feature of source.features) insert.run(feature.id, JSON.stringify(feature.geometry), JSON.stringify(feature.properties));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0) {
    const seedUsers = [
      ['admin', 'MRDCL Administrator', 'admin', process.env.ADMIN_PASSWORD || 'ChangeMe!589'],
      ['team1', 'Survey Team 1', 'editor', process.env.TEAM1_PASSWORD || 'Team1!589'],
      ['team2', 'Survey Team 2', 'editor', process.env.TEAM2_PASSWORD || 'Team2!589'],
      ['authority', 'MRDCL Authority', 'authority', process.env.AUTHORITY_PASSWORD || 'ViewOnly!589']
    ];
    const insert = db.prepare('INSERT INTO users (username, display_name, role, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [username, display, role, password] of seedUsers) { const hashed = hash(password); insert.run(username, display, role, hashed.value, hashed.salt, now()); }
  }
  const seedTeam = db.prepare('UPDATE users SET team_id=(SELECT id FROM teams WHERE name=?) WHERE username=? AND team_id IS NULL');
  seedTeam.run('Team 1', 'team1'); seedTeam.run('Team 2', 'team2');
}

function setSecurityHeaders(res) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' https://unpkg.com; script-src 'self' https://unpkg.com; img-src 'self' data:; connect-src 'self';");
}
async function api(req, res, url) {
  const pathname = url.pathname;
  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await readBody(req); const username = String(body.username || '').trim().toLowerCase(); const password = String(body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if (!user || !secureEqual(hash(password, user.password_salt).value, user.password_hash)) { json(res, 401, { error: 'Invalid user ID or password.' }); return; }
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString());
    res.setHeader('Set-Cookie', `mrdcl_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
    json(res, 200, { user: { username: user.username, display_name: user.display_name, role: user.role } }); return;
  }
  if (req.method === 'POST' && pathname === '/api/logout') {
    const token = parseCookies(req).mrdcl_session; if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
    res.setHeader('Set-Cookie', 'mrdcl_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); json(res, 200, { ok: true }); return;
  }
  if (req.method === 'GET' && pathname === '/api/me') { const user = currentUser(req); if (!user) { json(res, 401, { error: 'Not signed in.' }); } else json(res, 200, { user }); return; }
  if (req.method === 'GET' && pathname === '/api/map-layers') {
    if (!requireUser(req, res)) return;
    if (!fs.existsSync(MAP_LAYERS)) { json(res, 200, { layers: [] }); return; }
    json(res, 200, JSON.parse(fs.readFileSync(MAP_LAYERS, 'utf8'))); return;
  }
  if (req.method === 'GET' && pathname === '/api/bifurcated-buildings') {
    if (!requireUser(req, res)) return;
    if (!fs.existsSync(BIFURCATED_LAYER)) { json(res, 200, { type:'FeatureCollection', features:[] }); return; }
    json(res, 200, JSON.parse(fs.readFileSync(BIFURCATED_LAYER, 'utf8'))); return;
  }
  if (req.method === 'GET' && pathname === '/api/households') {
    if (!requireUser(req, res)) return;
    const q = (url.searchParams.get('q') || '').trim().toLowerCase(); const status = url.searchParams.get('status') || ''; const team = url.searchParams.get('team') || '';
    const rows = db.prepare('SELECT * FROM households').all();
    const features = rows.map(row => toHousehold(row)).filter(item => {
      const p = item.properties;
      const haystack = [item.id, p.NameOwnRep, p.BuildingID, p.HNoPlotNo, p.Contact, p.ColnyStrtN, p.TPIN].join(' ').toLowerCase();
      const teamMatches = !team || (team === 'Unassigned' ? !p.assigned_team || p.assigned_team === 'Unassigned' : p.assigned_team === team);
      return (!q || haystack.includes(q)) && (!status || (p.survey_status || 'Not started') === status) && teamMatches;
    }).map(item => ({ type: 'Feature', id: item.id, geometry: item.geometry, properties: { ...item.properties, revision: item.revision, updated_at: item.updated_at, updated_by: item.updated_by } }));
    json(res, 200, { type: 'FeatureCollection', features }); return;
  }
  const householdPhotosMatch = pathname.match(/^\/api\/households\/([^/]+)\/photos$/);
  if (householdPhotosMatch && req.method === 'GET') {
    const user = requireUser(req, res); if (!user) return; const id = decodeURIComponent(householdPhotosMatch[1]);
    const photos = db.prepare('SELECT id, household_id, filename, original_name, mime_type, latitude, longitude, captured_at, uploaded_at, uploaded_by FROM photo_uploads WHERE household_id=? ORDER BY id DESC').all(id).map(photo => ({ ...photo, url:`/api/photos/${photo.id}/file`, download_url:`/api/photos/${photo.id}/download` }));
    json(res, 200, { photos }); return;
  }
  if (householdPhotosMatch && req.method === 'POST') {
    const user = requireUser(req, res, ['admin', 'editor']); if (!user) return; const id = decodeURIComponent(householdPhotosMatch[1]); const row = db.prepare('SELECT id FROM households WHERE id=?').get(id); if (!row) { json(res, 404, { error:'Household not found.' }); return; }
    const body = await readBody(req); const mime = String(body.mime_type || ''); const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data_url || ''));
    if (!match || match[1] !== mime) { json(res, 400, { error:'Use a JPG, PNG, or WebP photo.' }); return; }
    const bytes = Buffer.from(match[2], 'base64'); if (!bytes.length || bytes.length > 8_000_000) { json(res, 400, { error:'Photo must be smaller than 8 MB.' }); return; }
    const ext = ({ 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp' })[mime]; const filename = `${id.replace(/[^A-Za-z0-9_-]/g, '_')}-${crypto.randomUUID()}.${ext}`; const original = String(body.filename || `photo.${ext}`).slice(0, 180); const lat = Number(body.latitude); const lng = Number(body.longitude);
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), bytes); const stamp = now(); const result = db.prepare('INSERT INTO photo_uploads (household_id, filename, original_name, mime_type, latitude, longitude, captured_at, uploaded_at, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, filename, original, mime, Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null, String(body.captured_at || stamp), stamp, user.username); addAudit(user, 'uploaded field photo', id, original);
    json(res, 201, { photo:{ id:Number(result.lastInsertRowid), household_id:id, filename, original_name:original, mime_type:mime, latitude:Number.isFinite(lat) ? lat : null, longitude:Number.isFinite(lng) ? lng : null, captured_at:String(body.captured_at || stamp), uploaded_at:stamp, uploaded_by:user.username, url:`/api/photos/${Number(result.lastInsertRowid)}/file`, download_url:`/api/photos/${Number(result.lastInsertRowid)}/download` } }); return;
  }
  const householdMatch = pathname.match(/^\/api\/households\/([^/]+)$/);
  if (householdMatch && req.method === 'GET') {
    if (!requireUser(req, res)) return; const row = db.prepare('SELECT * FROM households WHERE id=?').get(decodeURIComponent(householdMatch[1]));
    if (!row) { json(res, 404, { error: 'Household not found.' }); return; } json(res, 200, { household: toHousehold(row) }); return;
  }
  if (householdMatch && req.method === 'PUT') {
    const user = requireUser(req, res, ['admin', 'editor']); if (!user) return;
    const id = decodeURIComponent(householdMatch[1]); const body = await readBody(req); const row = db.prepare('SELECT * FROM households WHERE id=?').get(id);
    if (!row) { json(res, 404, { error: 'Household not found.' }); return; }
    if (!Number.isInteger(body.revision) || body.revision !== row.revision) { json(res, 409, { error: 'This household was changed by another user. Reload it before saving.', household: toHousehold(row) }); return; }
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) { json(res, 400, { error: 'A questionnaire data object is required.' }); return; }
    const incoming = {};
    for (const [key, rawValue] of Object.entries(body.data)) {
      if (!isEditableField(key)) continue;
      const value = rawValue === null ? null : String(rawValue).trim();
      if (user.role !== 'admin' && ['assigned_team', 'verification_status'].includes(key)) continue;
      if (user.role !== 'admin' && key === 'survey_status' && value === 'Verified') { json(res, 403, { error: 'Only an administrator can finalise a household as Verified.' }); return; }
      const lengthLimit = key.startsWith('q_') || key === 'household_members' || key === 'occupier_members' ? 12000 : 2000;
      if (value !== null && value.length > lengthLimit) { json(res, 400, { error: `${key} is too long.` }); return; }
      incoming[key] = value;
    }
    const previous = parseJson(row.survey); const survey = { ...previous, ...incoming };
    const changed = Object.keys(incoming).filter(key => previous[key] !== incoming[key]);
    if (!changed.length) { json(res, 200, { household: toHousehold(row), unchanged: true }); return; }
    const timestamp = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE households SET survey=?, revision=revision+1, updated_at=?, updated_by=? WHERE id=? AND revision=?').run(JSON.stringify(survey), timestamp, user.username, id, row.revision);
      addAudit(user, 'updated questionnaire', id, `Changed: ${changed.join(', ')}`); db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    json(res, 200, { household: toHousehold(db.prepare('SELECT * FROM households WHERE id=?').get(id)), changed }); return;
  }
  const householdReviewMatch = pathname.match(/^\/api\/households\/([^/]+)\/review$/);
  if (householdReviewMatch && req.method === 'GET') {
    const user = requireUser(req, res, ['admin']); if (!user) return;
    const id = decodeURIComponent(householdReviewMatch[1]); const row = db.prepare('SELECT id FROM households WHERE id=?').get(id);
    if (!row) { json(res, 404, { error:'Household not found.' }); return; }
    const items = db.prepare('SELECT at, username, action, detail FROM audit_log WHERE household_id=? ORDER BY id DESC LIMIT 30').all(id);
    json(res, 200, { items }); return;
  }
  if (householdReviewMatch && req.method === 'POST') {
    const user = requireUser(req, res, ['admin']); if (!user) return;
    const id = decodeURIComponent(householdReviewMatch[1]); const body = await readBody(req); const row = db.prepare('SELECT * FROM households WHERE id=?').get(id);
    if (!row) { json(res, 404, { error:'Household not found.' }); return; }
    if (!Number.isInteger(body.revision) || body.revision !== row.revision) { json(res, 409, { error:'This household was changed by another user. Reload it before reviewing.', household:toHousehold(row) }); return; }
    const decisions = { checked:['Checked', null], corrections:['Correction required', 'In progress'], approved:['Approved', 'Verified'] };
    if (!Object.hasOwn(decisions, body.decision)) { json(res, 400, { error:'Choose a valid review decision.' }); return; }
    const note = String(body.notes || '').trim(); if (note.length > 2000) { json(res, 400, { error:'Review note is too long.' }); return; }
    const previous = parseJson(row.survey); const [verificationStatus, surveyStatus] = decisions[body.decision]; const survey = { ...previous, verification_status:verificationStatus, review_notes:note || previous.review_notes || '' };
    if (surveyStatus) survey.survey_status = surveyStatus;
    const timestamp = now(); db.exec('BEGIN IMMEDIATE');
    try { db.prepare('UPDATE households SET survey=?, revision=revision+1, updated_at=?, updated_by=? WHERE id=? AND revision=?').run(JSON.stringify(survey), timestamp, user.username, id, row.revision); addAudit(user, body.decision === 'approved' ? 'verified and finalised household' : 'reviewed household', id, `${verificationStatus}${note ? ` — ${note}` : ''}`); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    json(res, 200, { household:toHousehold(db.prepare('SELECT * FROM households WHERE id=?').get(id)), decision:body.decision }); return;
  }
  if (req.method === 'GET' && pathname === '/api/dashboard') {
    if (!requireUser(req, res)) return;
    const rows = db.prepare('SELECT survey, updated_at FROM households').all(); const counts = { total: rows.length, 'Not started': 0, 'In progress': 0, Completed: 0, Verified: 0 };
    let updated = 0;
    for (const row of rows) { const status = parseJson(row.survey).survey_status || 'Not started'; counts[status] = (counts[status] || 0) + 1; if (row.updated_at) updated++; }
    json(res, 200, { counts, updated }); return;
  }
  if (req.method === 'GET' && pathname === '/api/activity') {
    if (!requireUser(req, res)) return;
    json(res, 200, { items: db.prepare('SELECT at, username, action, household_id, detail FROM audit_log ORDER BY id DESC LIMIT 50').all() }); return;
  }
  const photoDownloadMatch = pathname.match(/^\/api\/photos\/(\d+)\/download$/);
  if (photoDownloadMatch && req.method === 'GET') {
    const user = requireUser(req, res); if (!user) return; const photo = db.prepare('SELECT * FROM photo_uploads WHERE id=?').get(Number(photoDownloadMatch[1]));
    if (!photo || !fs.existsSync(path.join(UPLOAD_DIR, photo.filename))) { json(res, 404, { error:'Photo not found.' }); return; }
    download(res, photo.original_name, photo.mime_type, fs.readFileSync(path.join(UPLOAD_DIR, photo.filename))); return;
  }
  const photoFileMatch = pathname.match(/^\/api\/photos\/(\d+)\/file$/);
  if (photoFileMatch && req.method === 'GET') {
    const user = requireUser(req, res); if (!user) return; const photo = db.prepare('SELECT * FROM photo_uploads WHERE id=?').get(Number(photoFileMatch[1]));
    if (!photo || !fs.existsSync(path.join(UPLOAD_DIR, photo.filename))) { json(res, 404, { error:'Photo not found.' }); return; }
    const bytes = fs.readFileSync(path.join(UPLOAD_DIR, photo.filename)); res.writeHead(200, { 'Content-Type':photo.mime_type, 'Content-Length':bytes.length, 'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff' }); res.end(bytes); return;
  }
  if (req.method === 'GET' && pathname === '/api/photos') {
    const user = requireUser(req, res); if (!user) return; const mine = user.role !== 'admin';
    const rows = mine ? db.prepare('SELECT * FROM photo_uploads WHERE uploaded_by=? ORDER BY id DESC').all(user.username) : db.prepare('SELECT * FROM photo_uploads ORDER BY id DESC').all();
    json(res, 200, { photos:rows.map(photo => ({ ...photo, url:`/api/photos/${photo.id}/file`, download_url:`/api/photos/${photo.id}/download` })), scope:mine ? 'mine' : 'all' }); return;
  }
  const photoDeleteMatch = pathname.match(/^\/api\/photos\/(\d+)$/);
  if (photoDeleteMatch && req.method === 'DELETE') {
    const user = requireUser(req, res, ['admin']); if (!user) return; const photo = db.prepare('SELECT * FROM photo_uploads WHERE id=?').get(Number(photoDeleteMatch[1]));
    if (!photo) { json(res, 404, { error:'Photo not found.' }); return; }
    const source = path.join(UPLOAD_DIR, photo.filename); if (fs.existsSync(source)) fs.unlinkSync(source); db.prepare('DELETE FROM photo_uploads WHERE id=?').run(photo.id); addAudit(user, 'removed field photo', photo.household_id, photo.original_name); json(res, 200, { ok:true }); return;
  }
  if (req.method === 'GET' && pathname === '/api/my-work') {
    const user = requireUser(req, res); if (!user) return;
    const team = teamForUser(user);
    const items = db.prepare('SELECT * FROM households').all().map(row => toHousehold(row, false)).filter(item => item.properties.assigned_team === team).map(item => ({ id:item.id, label:item.properties.NameOwnRep || item.properties.BuildingID || item.id, status:item.properties.survey_status || 'Not started', plot:item.properties.HNoPlotNo || 'Not recorded', updated_at:item.updated_at, assigned_team:item.properties.assigned_team }));
    json(res, 200, { team, items }); return;
  }
  if (req.method === 'GET' && pathname === '/api/team-management') {
    const user = requireUser(req, res, ['admin']); if (!user) return;
    const households = db.prepare('SELECT id, survey FROM households').all(); const counts = { 'Unassigned':0, 'Team 1':0, 'Team 2':0 };
    for (const row of households) { const team = parseJson(row.survey).assigned_team || 'Unassigned'; counts[team] = (counts[team] || 0) + 1; }
    const teams = db.prepare('SELECT id, name, created_at FROM teams ORDER BY name').all();
    const users = db.prepare('SELECT u.id, u.username, u.display_name, u.role, u.team_id, t.name AS team_name, u.created_at FROM users u LEFT JOIN teams t ON t.id=u.team_id ORDER BY u.role, u.display_name').all().map(item => ({ ...item, assigned: counts[item.team_name] || 0 }));
    json(res, 200, { users, teams, counts, households: households.map(row => { const item = toHousehold(row, false); return { id:item.id, ...item.properties }; }) }); return;
  }
  if (req.method === 'POST' && pathname === '/api/teams') {
    const user = requireUser(req, res, ['admin']); if (!user) return; const body = await readBody(req); const name = String(body.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 60) { json(res, 400, { error:'Team name must be 2–60 characters.' }); return; }
    try { const result = db.prepare('INSERT INTO teams (name, created_at) VALUES (?, ?)').run(name, now()); addAudit(user, 'created team', null, name); json(res, 201, { team:{ id:Number(result.lastInsertRowid), name } }); } catch { json(res, 409, { error:'A team with that name already exists.' }); } return;
  }
  if (req.method === 'PUT' && pathname === '/api/teams/members') {
    const user = requireUser(req, res, ['admin']); if (!user) return; const body = await readBody(req); const userId = Number(body.user_id); const teamId = body.team_id === null || body.team_id === '' ? null : Number(body.team_id);
    if (!Number.isInteger(userId) || (teamId !== null && !Number.isInteger(teamId))) { json(res, 400, { error:'Choose a valid user and team.' }); return; }
    if (teamId !== null && !db.prepare('SELECT id FROM teams WHERE id=?').get(teamId)) { json(res, 404, { error:'Team not found.' }); return; }
    const member = db.prepare('SELECT username FROM users WHERE id=?').get(userId); if (!member) { json(res, 404, { error:'User not found.' }); return; }
    db.prepare('UPDATE users SET team_id=? WHERE id=?').run(teamId, userId); const teamName = teamId === null ? 'No team' : db.prepare('SELECT name FROM teams WHERE id=?').get(teamId).name; addAudit(user, 'moved user to team', null, `${member.username} → ${teamName}`); json(res, 200, { ok:true, team_name:teamName }); return;
  }
  if (req.method === 'POST' && pathname === '/api/assignments') {
    const user = requireUser(req, res, ['admin']); if (!user) return; const body = await readBody(req);
    const ids = Array.isArray(body.household_ids) ? body.household_ids.map(item => String(item)) : []; const team = String(body.team || '');
    const validTeams = new Set(['Unassigned', ...db.prepare('SELECT name FROM teams').all().map(row => row.name)]);
    if (!ids.length || !validTeams.has(team)) { json(res, 400, { error:'Select one or more households and a valid team.' }); return; }
    const rows = db.prepare(`SELECT * FROM households WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids); const update = db.prepare('UPDATE households SET survey=?, revision=revision+1, updated_at=?, updated_by=? WHERE id=?'); const stamp = now();
    db.exec('BEGIN IMMEDIATE'); try { for (const row of rows) { const survey = { ...parseJson(row.survey), assigned_team:team }; update.run(JSON.stringify(survey), stamp, user.username, row.id); addAudit(user, 'assigned household', row.id, team); } db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    json(res, 200, { ok:true, changed:rows.length }); return;
  }
  if (req.method === 'GET' && pathname === '/api/verification') {
    const user = requireUser(req, res, ['admin']); if (!user) return;
    const items = db.prepare('SELECT * FROM households').all().map(row => toHousehold(row, false)).filter(item => ['Completed', 'Verified'].includes(item.properties.survey_status || 'Not started')).map(item => ({ id:item.id, label:item.properties.NameOwnRep || item.properties.BuildingID || item.id, status:item.properties.survey_status || 'Not started', verification:item.properties.verification_status || 'Pending', team:item.properties.assigned_team || 'Unassigned' }));
    json(res, 200, { items }); return;
  }
  if (req.method === 'POST' && pathname === '/api/verification/finalise') {
    const user = requireUser(req, res, ['admin']); if (!user) return; const body = await readBody(req); const ids = Array.isArray(body.household_ids) ? body.household_ids.map(item => String(item)) : [];
    if (!ids.length) { json(res, 400, { error:'Select at least one completed household.' }); return; }
    const rows = db.prepare(`SELECT * FROM households WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids); const update = db.prepare('UPDATE households SET survey=?, revision=revision+1, updated_at=?, updated_by=? WHERE id=?'); const stamp = now();
    db.exec('BEGIN IMMEDIATE'); try { for (const row of rows) { const previous = parseJson(row.survey); const survey = { ...previous, survey_status:'Verified', verification_status:'Approved' }; update.run(JSON.stringify(survey), stamp, user.username, row.id); addAudit(user, 'verified and finalised household', row.id, 'Approved'); } db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    json(res, 200, { ok:true, changed:rows.length }); return;
  }
  if (req.method === 'GET' && pathname === '/api/profile') {
    const user = requireUser(req, res); if (!user) return; json(res, 200, { user }); return;
  }
  if (req.method === 'PUT' && pathname === '/api/profile') {
    const user = requireUser(req, res); if (!user) return; const body = await readBody(req); const display = String(body.display_name || '').trim(); const password = String(body.password || '');
    if (!display || display.length > 100 || (password && password.length < 10)) { json(res, 400, { error:'Provide a display name and, if changing it, a password of at least 10 characters.' }); return; }
    if (password) { const hashed = hash(password); db.prepare('UPDATE users SET display_name=?, password_hash=?, password_salt=? WHERE id=?').run(display, hashed.value, hashed.salt, user.id); }
    else db.prepare('UPDATE users SET display_name=? WHERE id=?').run(display, user.id);
    const updated = db.prepare('SELECT id, username, display_name, role FROM users WHERE id=?').get(user.id); addAudit(updated, 'updated profile', null, null); json(res, 200, { user:updated }); return;
  }
  const exportMatch = pathname.match(/^\/api\/exports\/(geojson|kml|xlsx|word|csv)$/);
  if (exportMatch && req.method === 'GET') {
    const user = requireUser(req, res, ['admin', 'authority']); if (!user) return;
    const rows = exportRows(); const type = exportMatch[1]; const stamp = new Date().toISOString().slice(0, 10);
    if (type === 'geojson') {
      const features = rows.map(item => ({ type: 'Feature', id: item.id, geometry: item.geometry, properties: exportProperties(item) }));
      download(res, `mrdcl-household-survey-${stamp}.geojson`, 'application/geo+json; charset=utf-8', JSON.stringify({ type: 'FeatureCollection', name: 'MRDCL household survey export', features })); return;
    }
    if (type === 'kml') { download(res, `mrdcl-household-survey-${stamp}.kml`, 'application/vnd.google-earth.kml+xml; charset=utf-8', buildKml(rows)); return; }
    if (type === 'xlsx') { download(res, `mrdcl-household-survey-${stamp}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buildXlsx(rows)); return; }
    if (type === 'word') { download(res, `mrdcl-household-survey-${stamp}.doc`, 'application/msword; charset=utf-8', buildWord(rows)); return; }
    download(res, `mrdcl-household-survey-${stamp}.csv`, 'text/csv; charset=utf-8', buildCsv(rows)); return;
  }
  if (req.method === 'GET' && pathname === '/api/users') {
    if (!requireUser(req, res, ['admin'])) return;
    json(res, 200, { users: db.prepare('SELECT u.id, u.username, u.display_name, u.role, u.team_id, t.name AS team_name, u.created_at FROM users u LEFT JOIN teams t ON t.id=u.team_id ORDER BY username').all(), teams:db.prepare('SELECT id, name FROM teams ORDER BY name').all() }); return;
  }
  if (req.method === 'POST' && pathname === '/api/users') {
    const user = requireUser(req, res, ['admin']); if (!user) return; const body = await readBody(req);
    const username = String(body.username || '').trim().toLowerCase(); const display = String(body.display_name || '').trim(); const password = String(body.password || ''); const role = String(body.role || ''); const teamId = body.team_id === null || body.team_id === '' || body.team_id === undefined ? null : Number(body.team_id);
    if (!/^[a-z0-9._-]{3,40}$/.test(username) || !display || password.length < 10 || !['admin', 'editor', 'authority'].includes(role)) { json(res, 400, { error: 'Use a 3–40 character user ID, display name, 10+ character password, and valid role.' }); return; }
    if (teamId !== null && (!Number.isInteger(teamId) || !db.prepare('SELECT id FROM teams WHERE id=?').get(teamId))) { json(res, 400, { error:'Choose a valid team.' }); return; }
    try { const hashed = hash(password); db.prepare('INSERT INTO users (username, display_name, role, team_id, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(username, display, role, teamId, hashed.value, hashed.salt, now()); addAudit(user, 'created user', null, `${username} (${role})`); json(res, 201, { ok: true }); } catch { json(res, 409, { error: 'That user ID already exists.' }); } return;
  }
  json(res, 404, { error: 'API route not found.' });
}
function serveStatic(req, res, url) {
  // The phone clients previously retained an early interface in their browser
  // cache. Always route the normal address to the current release URL once.
  if (url.pathname === '/' && url.searchParams.get('release') !== 'mobile-v20') {
    res.writeHead(302, { Location: '/?release=mobile-v20', 'Cache-Control': 'no-store, max-age=0' }); res.end(); return;
  }
  let requested = url.pathname === '/' ? '/index.html' : url.pathname;
  requested = path.normalize(requested).replace(/^([/\\])+/, ''); const file = path.join(STATIC_DIR, requested);
  if (!file.startsWith(STATIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { text(res, 404, 'Not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store, max-age=0, must-revalidate', 'X-Content-Type-Options': 'nosniff' }); fs.createReadStream(file).pipe(res);
}
init();
const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res); const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try { if (url.pathname.startsWith('/api/')) await api(req, res, url); else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url); else text(res, 405, 'Method not allowed'); }
  catch (error) { console.error(error); if (!res.headersSent) json(res, 500, { error: 'The server could not complete this request.' }); }
});
server.listen(PORT, '0.0.0.0', () => console.log(`MRDCL Household Survey Portal is running at http://localhost:${PORT}`));
