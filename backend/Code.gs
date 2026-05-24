// ===== PublicCards Backend (Google Apps Script) =====
// Bound to the "Public-Cards-DB" spreadsheet.
// Web App: "Execute as Me", "Access: Anyone".
//
// One-time setup: run setup() once from the editor. It creates the 4 tabs with
// the exact headers from the spec and a Drive folder for image uploads, storing
// the folder id in Script Properties (so no constant needs editing).

const SS = SpreadsheetApp.getActiveSpreadsheet();
const PROPS = PropertiesService.getScriptProperties();

// Tab headers (must match spec §4 exactly).
const SCHEMA = {
  users:    ['namespace', 'firstName', 'lastName', 'displayName', 'tokenHash', 'createdAt'],
  cards:    ['id', 'ownerNamespace', 'title', 'body', 'images', 'visibility', 'spaceId', 'slug', 'createdAt', 'updatedAt'],
  comments: ['id', 'cardId', 'parentId', 'authorNamespace', 'authorDisplay', 'body', 'createdAt', 'deleted'],
  spaces:   ['id', 'name', 'slug', 'ownerNamespace', 'members', 'createdAt', 'color'],
};

// Curated accent palette for spaces (all medium-dark -> readable on white text).
const SPACE_PALETTE = ['#4f46e5', '#2563eb', '#0891b2', '#0d9488', '#16a34a', '#ca8a04', '#dc2626', '#db2777', '#7c3aed', '#475569'];
function pickSpaceColor(seed) {
  let h = 0; for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SPACE_PALETTE[h % SPACE_PALETTE.length];
}

// --- one-time setup ---
// Creates the 4 tabs with headers and a Drive folder for uploads. Idempotent.
function setup() {
  // 1) create / verify tabs + headers
  Object.keys(SCHEMA).forEach(name => {
    let sh = SS.getSheetByName(name);
    if (!sh) sh = SS.insertSheet(name);
    const headers = SCHEMA[name];
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  // remove the default empty sheet if it still exists and is now redundant
  const def = SS.getSheetByName('Tabellenblatt1') || SS.getSheetByName('Sheet1');
  if (def && SS.getSheets().length > 1) SS.deleteSheet(def);

  // 2) create the Drive folder for image uploads (once)
  let folderId = PROPS.getProperty('DRIVE_FOLDER_ID');
  if (!folderId) {
    const folder = DriveApp.createFolder('PublicCards-Images');
    folderId = folder.getId();
    PROPS.setProperty('DRIVE_FOLDER_ID', folderId);
  }
  Logger.log('Setup done. DRIVE_FOLDER_ID = ' + folderId);
  return folderId;
}

function getDriveFolder() {
  const id = PROPS.getProperty('DRIVE_FOLDER_ID');
  if (!id) throw new Error('DRIVE_FOLDER_NOT_CONFIGURED'); // run setup() once
  return DriveApp.getFolderById(id);
}

// --- entry points ---
function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const { action, payload = {}, auth = null } = req;
    return json({ ok: true, data: route(action, payload, auth) });
  } catch (err) {
    return json({ ok: false, error: err.message });
  }
}

// --- REST READ API (GET) ---
// Auth optional via query: ?ns=<namespace>&token=<token>
// Public data needs no token; private/space data requires valid token.
// Routes (param `r`):
//   (none)            -> health check
//   r=cards           -> list visible cards (public + own + space, depending on auth)
//   r=card&id=|slug=  -> single card + comment tree (visibility enforced)
//   r=comments&card=  -> comment tree for a card (visibility enforced)
//   r=spaces          -> spaces the authed user is a member of (token required)
//   r=me              -> echo identity (token required)
function doGet(e) {
  try {
    const q = (e && e.parameter) || {};
    const auth = (q.ns && q.token) ? { namespace: q.ns, token: q.token } : null;
    if (auth) requireAuth(auth); // validate token early if provided; throws on bad token
    const r = q.r || '';
    let data;
    switch (r) {
      case '':         data = 'PublicCards API alive'; break;
      case 'cards':    data = listCards({}, auth); break;
      case 'card':     data = getCard({ id: q.id, slug: q.slug }, auth); break;
      case 'comments': {
        const c = rows('cards').find(x => x.id === q.card || x.slug === q.card);
        if (!c) throw new Error('CARD_NOT_FOUND');
        enforceVisibility(c, auth);
        data = buildCommentTree(c.id);
        break;
      }
      case 'spaces':   data = listSpaces({}, requireAuth(auth)); break;
      case 'me':       { const u = requireAuth(auth);
                         data = { namespace: u.namespace, firstName: u.firstName,
                                  lastName: u.lastName, displayName: u.displayName }; break; }
      default: throw new Error('UNKNOWN_ROUTE: ' + r);
    }
    return json({ ok: true, data });
  } catch (err) {
    return json({ ok: false, error: err.message });
  }
}

function route(action, payload, auth) {
  switch (action) {
    case 'register':       return register(payload);
    case 'claim':          return claim(payload);
    case 'createCard':     return createCard(payload, requireAuth(auth));
    case 'updateCard':     return updateCard(payload, requireAuth(auth));
    case 'deleteCard':     return deleteCard(payload, requireAuth(auth));
    case 'getCard':        return getCard(payload, auth);
    case 'listCards':      return listCards(payload, auth);
    case 'uploadImage':    return uploadImage(payload, requireAuth(auth));
    case 'uploadFile':     return uploadFile(payload, requireAuth(auth));
    case 'addComment':     return addComment(payload, requireAuth(auth));
    case 'deleteComment':  return deleteComment(payload, requireAuth(auth));
    case 'createSpace':    return createSpace(payload, requireAuth(auth));
    case 'addSpaceMember': return addSpaceMember(payload, requireAuth(auth));
    case 'listSpaces':     return listSpaces(payload, requireAuth(auth));
    default: throw new Error('UNKNOWN_ACTION: ' + action);
  }
}

// --- helpers ---
function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
function sheet(n) { const s = SS.getSheetByName(n); if (!s) throw new Error('MISSING_TAB: ' + n); return s; }
function rows(n) {
  const v = sheet(n).getDataRange().getValues();
  const h = v.shift();
  return v.map((r, i) => { const o = { _row: i + 2 }; h.forEach((k, c) => o[k] = r[c]); return o; });
}
function appendRow(n, obj) {
  const s = sheet(n);
  const h = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  s.appendRow(h.map(k => obj[k] !== undefined ? obj[k] : ''));
}
function updateCell(n, row, col, val) {
  const s = sheet(n);
  const h = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  s.getRange(row, h.indexOf(col) + 1).setValue(val);
}
function sha256(str) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
function uuid() { return Utilities.getUuid(); }
function now() { return new Date().toISOString(); }
function safeJson(s, f) { try { return JSON.parse(s); } catch (e) { return f; } }

function requireAuth(auth) {
  if (!auth || !auth.namespace || !auth.token) throw new Error('AUTH_REQUIRED');
  const u = rows('users').find(x => x.namespace === auth.namespace);
  if (!u) throw new Error('UNKNOWN_USER');
  if (u.tokenHash !== sha256(auth.token)) throw new Error('BAD_TOKEN');
  return u;
}

// --- identity ---
function register(p) {
  const ns = String(p.namespace || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,20}$/.test(ns)) throw new Error('INVALID_NAMESPACE');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // prevent race on namespace uniqueness
  try {
    if (rows('users').some(u => u.namespace === ns)) throw new Error('NAMESPACE_TAKEN');
    const token = p.token || uuid();
    appendRow('users', {
      namespace: ns, firstName: p.firstName || '', lastName: p.lastName || '',
      displayName: p.displayName || '', tokenHash: sha256(token), createdAt: now()
    });
    return { namespace: ns, token };
  } finally { lock.releaseLock(); }
}
function claim(p) {
  const u = rows('users').find(x => x.namespace === p.namespace);
  if (!u) throw new Error('UNKNOWN_USER');
  if (u.tokenHash !== sha256(p.token)) throw new Error('BAD_TOKEN');
  return { namespace: u.namespace, firstName: u.firstName, lastName: u.lastName, displayName: u.displayName };
}

// --- image upload (Drive) ---
function uploadImage(p, user) {
  // p.dataUrl = "data:image/png;base64,...." ; p.filename optional
  const m = String(p.dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error('BAD_IMAGE');
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1],
    (p.filename || ('img_' + uuid())));
  const folder = getDriveFolder();
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  // Direct image host that renders inline in <img> without a download redirect.
  // (drive.google.com/uc?export=view now 303-redirects to a download endpoint
  // and no longer serves images inline cross-origin.)
  const url = 'https://lh3.googleusercontent.com/d/' + file.getId();
  return { url };
}

// Upload an arbitrary (non-image) file; returns a public download URL + name.
function uploadFile(p, user) {
  const m = String(p.dataUrl || '').match(/^data:([^;]*);base64,(.+)$/);
  if (!m) throw new Error('BAD_FILE');
  const name = p.filename || ('file_' + uuid());
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1] || 'application/octet-stream', name);
  const folder = getDriveFolder();
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { url: 'https://drive.google.com/uc?export=download&id=' + file.getId(), name };
}

// --- cards ---
function createCard(p, user) {
  const id = 'card_' + uuid();
  appendRow('cards', {
    id, ownerNamespace: user.namespace, title: p.title || 'Untitled',
    body: p.body || '', images: JSON.stringify(p.images || []),
    visibility: p.visibility || 'private', spaceId: p.spaceId || '',
    slug: makeSlug(p.title, id), createdAt: now(), updatedAt: now()
  });
  const card = rows('cards').find(c => c.id === id);
  return { id, slug: card.slug };
}
function updateCard(p, user) {
  const c = rows('cards').find(x => x.id === p.id);
  if (!c) throw new Error('CARD_NOT_FOUND');
  if (c.ownerNamespace !== user.namespace) throw new Error('NOT_OWNER');
  ['title', 'body', 'visibility', 'spaceId'].forEach(f => {
    if (p[f] !== undefined) updateCell('cards', c._row, f, p[f]);
  });
  if (p.images !== undefined) updateCell('cards', c._row, 'images', JSON.stringify(p.images));
  updateCell('cards', c._row, 'updatedAt', now());
  return { id: c.id };
}
function deleteCard(p, user) {
  const c = rows('cards').find(x => x.id === p.id);
  if (!c) throw new Error('CARD_NOT_FOUND');
  if (c.ownerNamespace !== user.namespace) throw new Error('NOT_OWNER');
  sheet('cards').deleteRow(c._row);
  // delete comments bottom-up to keep row indices valid
  rows('comments').filter(x => x.cardId === p.id)
    .sort((a, b) => b._row - a._row)
    .forEach(x => sheet('comments').deleteRow(x._row));
  return { id: p.id };
}
function getCard(p, auth) {
  const c = rows('cards').find(x => x.id === p.id || x.slug === p.slug);
  if (!c) throw new Error('CARD_NOT_FOUND');
  enforceVisibility(c, auth);
  return { card: publicCard(c), comments: buildCommentTree(c.id) };
}
function listCards(p, auth) {
  const ns = auth ? auth.namespace : null;
  const myspaces = ns ? rows('spaces').filter(s => safeJson(s.members, []).indexOf(ns) >= 0).map(s => s.id) : [];
  return rows('cards').filter(c =>
    c.visibility === 'public' ||
    (ns && c.ownerNamespace === ns) ||
    (c.visibility === 'space' && myspaces.indexOf(c.spaceId) >= 0)
  ).map(publicCard);
}
function enforceVisibility(c, auth) {
  if (c.visibility === 'public') return;
  const ns = auth ? auth.namespace : null;
  if (c.ownerNamespace === ns) return;
  if (c.visibility === 'space') {
    const sp = rows('spaces').find(s => s.id === c.spaceId);
    if (sp && safeJson(sp.members, []).indexOf(ns) >= 0) return;
  }
  throw new Error('NOT_AUTHORIZED');
}
function publicCard(c) {
  return {
    // Coerce to string: a numeric-only title/body comes back from Sheets as a Number.
    id: c.id, slug: String(c.slug), title: String(c.title), body: String(c.body),
    images: safeJson(c.images, []), visibility: c.visibility, spaceId: c.spaceId,
    ownerNamespace: c.ownerNamespace, createdAt: c.createdAt, updatedAt: c.updatedAt
  };
}

// --- comments ---
function addComment(p, user) {
  if (!rows('cards').some(c => c.id === p.cardId)) throw new Error('CARD_NOT_FOUND');
  const id = 'cmt_' + uuid();
  appendRow('comments', {
    id, cardId: p.cardId, parentId: p.parentId || '',
    authorNamespace: user.namespace,
    authorDisplay: user.displayName || (user.firstName + ' ' + user.lastName),
    body: p.body || '', createdAt: now(), deleted: false
  });
  return { id }; // id == comment anchor
}
function deleteComment(p, user) {
  const c = rows('comments').find(x => x.id === p.id);
  if (!c) throw new Error('COMMENT_NOT_FOUND');
  if (c.authorNamespace !== user.namespace) throw new Error('NOT_AUTHOR');
  updateCell('comments', c._row, 'deleted', true);
  updateCell('comments', c._row, 'body', '[deleted]');
  return { id: c.id };
}
function buildCommentTree(cardId) {
  const all = rows('comments').filter(c => c.cardId === cardId).map(c => ({
    id: c.id, parentId: c.parentId, body: String(c.body), author: String(c.authorDisplay),
    authorNamespace: c.authorNamespace,
    deleted: c.deleted === true || c.deleted === 'TRUE',
    createdAt: c.createdAt, children: []
  }));
  const byId = {}; all.forEach(c => byId[c.id] = c);
  const roots = [];
  all.forEach(c => (c.parentId && byId[c.parentId]) ? byId[c.parentId].children.push(c) : roots.push(c));
  return roots;
}

// --- spaces ---
function createSpace(p, user) {
  const id = 'spc_' + uuid();
  const color = /^#[0-9a-fA-F]{6}$/.test(p.color || '') ? p.color : pickSpaceColor(id);
  appendRow('spaces', {
    id, name: p.name || 'Space', slug: makeSlug(p.name, id),
    ownerNamespace: user.namespace, members: JSON.stringify([user.namespace]), createdAt: now(), color
  });
  return { id, slug: rows('spaces').find(s => s.id === id).slug, color };
}
function addSpaceMember(p, user) {
  const s = rows('spaces').find(x => x.id === p.spaceId);
  if (!s) throw new Error('SPACE_NOT_FOUND');
  if (s.ownerNamespace !== user.namespace) throw new Error('NOT_OWNER');
  if (!rows('users').some(u => u.namespace === p.namespace)) throw new Error('UNKNOWN_USER');
  const members = safeJson(s.members, []);
  if (members.indexOf(p.namespace) < 0) members.push(p.namespace);
  updateCell('spaces', s._row, 'members', JSON.stringify(members));
  return { id: s.id, members };
}
function listSpaces(p, user) {
  return rows('spaces')
    .filter(s => safeJson(s.members, []).indexOf(user.namespace) >= 0)
    .map(s => ({ id: s.id, name: s.name, slug: s.slug, ownerNamespace: s.ownerNamespace,
                 members: safeJson(s.members, []), color: s.color || pickSpaceColor(s.id) }));
}

// --- util ---
function makeSlug(title, id) {
  const base = String(title || 'item').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return base + '-' + id.slice(-6);
}
