'use strict';
/* ===== PublicCards frontend (vanilla JS, no build step) ===== */

const API_URL = 'https://script.google.com/macros/s/AKfycbw4RIPVeNI9zqq7QL99dflbV49B4MbBiJpuWiiu_dTstSei0UiTG8tw47V9ySHZrChTJw/exec';

/* ---------- API client (§9) ---------- */
// Single action-based POST endpoint. text/plain avoids a CORS preflight while
// the body stays JSON. Auth is attached automatically whenever an identity exists.
async function api(action, payload = {}) {
  const id = getIdentity();
  const auth = id ? { namespace: id.namespace, token: id.token } : null;
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, payload, auth }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'UNKNOWN_ERROR');
  return data.data;
}

/* ---------- identity (LocalStorage, §3/§9) ---------- */
const ID_KEY = 'publiccards.identity';
const getIdentity = () => { try { return JSON.parse(localStorage.getItem(ID_KEY) || 'null'); } catch { return null; } };
const setIdentity = (id) => localStorage.setItem(ID_KEY, JSON.stringify(id));
const clearIdentity = () => localStorage.removeItem(ID_KEY);

async function registerIdentity(firstName, lastName, namespace, displayName) {
  const token = crypto.randomUUID();
  const res = await api('register', { firstName, lastName, namespace, displayName, token });
  setIdentity({ firstName, lastName, namespace: res.namespace, displayName, token });
}
async function claimIdentity(namespace, token) {
  const u = await api('claim', { namespace, token });
  setIdentity({ ...u, token });
}

/* ---------- small utils ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const main = () => document.getElementById('main');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function initials(name, ns) {
  const src = (name || '').trim() || (ns || '');
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (src.slice(0, 2) || '??').toUpperCase();
}
function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'gerade eben';
  const m = Math.round(s / 60); if (m < 60) return `vor ${m} Min.`;
  const h = Math.round(m / 60); if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24); if (d < 30) return `vor ${d} T.`;
  return new Date(iso).toLocaleDateString('de-DE');
}
// Always sanitize rendered markdown (§9/§13).
function renderMd(src) { return DOMPurify.sanitize(marked.parse(src || '', { breaks: true })); }

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}
function avatarHtml(name, ns, cls = '') {
  return `<span class="avatar ${cls}">${escapeHtml(initials(name, ns))}</span>`;
}

/* ---------- image handling: downscale -> base64 -> uploadImage (§9/§13) ---------- */
function fileToImage(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = r.result; };
    r.onerror = rej; r.readAsDataURL(file);
  });
}
async function downscaleToDataUrl(file, max = 1600) {
  const img = await fileToImage(file);
  let { width: w, height: h } = img;
  if (w > max || h > max) { const s = Math.min(max / w, max / h); w = Math.round(w * s); h = Math.round(h * s); }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  const type = /png/i.test(file.type) ? 'image/png' : 'image/jpeg';
  return canvas.toDataURL(type, 0.85);
}
async function uploadImageFile(file) {
  const dataUrl = await downscaleToDataUrl(file);
  const { url } = await api('uploadImage', { dataUrl, filename: file.name });
  return url;
}

/* ---------- routing (§7) ---------- */
// Hash routes; comment anchor encoded as "__cmt_<uuid>" suffix on the card slug.
const ANCHOR = '__cmt_';
const go = (path) => { location.hash = path; };
function cardLink(slug, commentId) {
  let p = '#/c/' + slug;
  if (commentId) p += ANCHOR + String(commentId).replace(/^cmt_/, '');
  return p;
}
// Magic link: carries namespace + token so a new device auto-claims the identity.
// The token is the secret — only ever share this link with yourself.
function magicLink(id) {
  return location.origin + location.pathname +
    '#/claim/' + encodeURIComponent(id.namespace) + '/' + encodeURIComponent(id.token);
}

function parseHash() {
  let h = (location.hash || '').replace(/^#/, '');
  if (!h || h === '/') return { name: 'feed' };
  const seg = h.split('/').filter(Boolean); // e.g. ['c','slug__cmt_x']
  switch (seg[0]) {
    case 'onboard': return { name: 'onboard' };
    case 'claim': return { name: 'claim', ns: decodeURIComponent(seg[1] || ''), token: decodeURIComponent(seg.slice(2).join('/')) };
    case 'new': return { name: 'editor', slug: null };
    case 'edit': return { name: 'editor', slug: seg[1] };
    case 'spaces': return { name: 'spaces' };
    case 's': return { name: 'feed', spaceSlug: seg[1] };
    case 'c': {
      const raw = seg.slice(1).join('/');
      const i = raw.indexOf(ANCHOR);
      if (i >= 0) return { name: 'card', slug: raw.slice(0, i), anchorId: 'cmt_' + raw.slice(i + ANCHOR.length) };
      return { name: 'card', slug: raw };
    }
    default: return { name: 'feed' };
  }
}

async function router() {
  closeDrawer();
  const r = parseHash();
  renderSidebar(r);
  try {
    if (r.name === 'feed') await viewFeed(r.spaceSlug);
    else if (r.name === 'card') await viewCard(r.slug, r.anchorId);
    else if (r.name === 'editor') await viewEditor(r.slug);
    else if (r.name === 'onboard') viewOnboard();
    else if (r.name === 'claim') await viewClaim(r.ns, r.token);
    else if (r.name === 'spaces') await viewSpaces();
    else await viewFeed();
  } catch (err) {
    main().innerHTML = `<div class="main-col"><div class="empty">Fehler: ${escapeHtml(err.message)}</div></div>`;
  }
}

/* ---------- sidebar shell (§11) ---------- */
async function renderSidebar(route) {
  const id = getIdentity();
  const sb = document.getElementById('sidebar');
  let spacesHtml = '';
  if (id) {
    try {
      const spaces = await api('listSpaces', {});
      spacesHtml = spaces.length
        ? spaces.map(s => `<a class="sb-link ${route && route.spaceSlug === s.slug ? 'active' : ''}" href="#/s/${escapeHtml(s.slug)}"><span class="ic">#</span>${escapeHtml(s.name)}</a>`).join('')
        : `<div class="sb-section" style="text-transform:none;font-weight:400">Noch keine Spaces</div>`;
    } catch { spacesHtml = ''; }
  }
  const isFeed = route && route.name === 'feed' && !route.spaceSlug;
  sb.innerHTML = `
    <div class="sb-brand"><span class="dot"></span>PublicCards</div>
    <nav class="sb-nav">
      <a class="sb-link ${isFeed ? 'active' : ''}" href="#/"><span class="ic">▦</span>Feed</a>
      <a class="sb-link ${route && route.name === 'editor' ? 'active' : ''}" href="#/new"><span class="ic">＋</span>Neue Card</a>
      <a class="sb-link ${route && route.name === 'spaces' ? 'active' : ''}" href="#/spaces"><span class="ic">⊕</span>Spaces verwalten</a>
    </nav>
    ${id ? `<div class="sb-section">Spaces</div><nav class="sb-nav">${spacesHtml}</nav>` : ''}
    <div class="sb-spacer"></div>
    ${id
      ? `<div class="sb-identity" id="sbIdentity" title="Identität verwalten">
           ${avatarHtml(id.displayName || (id.firstName + ' ' + id.lastName), id.namespace)}
           <div class="who"><div class="nm">${escapeHtml(id.displayName || (id.firstName + ' ' + id.lastName))}</div><div class="ns">@${escapeHtml(id.namespace)}</div></div>
         </div>`
      : `<div class="sb-identity" id="sbIdentity"><span class="avatar">?</span><div class="who"><div class="nm">Anmelden</div><div class="ns">Identität anlegen</div></div></div>`}
  `;
  $('#sbIdentity').onclick = () => go('/onboard');
}

/* ---------- views ---------- */
function visBadge(v) {
  const map = { public: 'public', private: 'private', space: 'space' };
  return `<span class="badge">${escapeHtml(map[v] || v)}</span>`;
}

async function viewFeed(spaceSlug) {
  const id = getIdentity();
  main().innerHTML = `<div class="main-col"><div class="empty">Lädt…</div></div>`;
  let space = null;
  if (spaceSlug && id) {
    const spaces = await api('listSpaces', {});
    space = spaces.find(s => s.slug === spaceSlug);
  }
  const cards = await api('listCards', {});
  const list = spaceSlug
    ? cards.filter(c => c.visibility === 'space' && space && c.spaceId === space.id)
    : cards;
  list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  const head = spaceSlug
    ? `<div class="page-head"><h1># ${escapeHtml(space ? space.name : spaceSlug)}</h1><a class="btn sm" href="#/new">＋ Card</a></div>`
    : `<div class="page-head"><h1>Feed</h1><a class="btn sm" href="#/new">＋ Card</a></div>`;

  const banner = id ? '' :
    `<div class="card"><strong>Willkommen.</strong> Du siehst öffentliche Cards. <a class="btn sm" href="#/onboard">Identität anlegen</a> um eigene Cards & Kommentare zu erstellen.</div>`;

  const items = list.length ? list.map(c => cardItemHtml(c)).join('') :
    `<div class="empty">Keine Cards${spaceSlug ? ' in diesem Space' : ''}.</div>`;

  main().innerHTML = `<div class="main-col">${head}${banner}${items}</div>`;
  $$('.card.click').forEach(el => el.onclick = () => go('/c/' + el.dataset.slug));
}

function snippet(body) {
  const txt = (body || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')     // images -> drop
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // links -> keep label
    .replace(/https?:\/\/\S+/g, '')           // bare URLs -> drop
    .replace(/[#>*_`~]/g, ' ')                // remaining md punctuation
    .replace(/\s+/g, ' ').trim();
  return escapeHtml(txt.slice(0, 180));
}
function cardItemHtml(c) {
  return `<div class="card click" data-slug="${escapeHtml(c.slug)}">
    <div class="c-head">
      ${avatarHtml(c.ownerNamespace, c.ownerNamespace, 'sm')}
      <div class="meta"><div class="nm">@${escapeHtml(c.ownerNamespace)}</div><div class="tm">${timeAgo(c.updatedAt)}</div></div>
      <span class="sp"></span>${visBadge(c.visibility)}
    </div>
    <h2 class="c-title">${escapeHtml(c.title)}</h2>
    <div class="c-snippet">${snippet(c.body)}</div>
  </div>`;
}

async function viewCard(slug, anchorId) {
  const id = getIdentity();
  main().innerHTML = `<div class="main-col"><div class="empty">Lädt…</div></div>`;
  const { card, comments } = await api('getCard', { slug });
  const isOwner = id && id.namespace === card.ownerNamespace;
  const gallery = (card.images && card.images.length)
    ? `<div class="gallery">${card.images.map(u => `<img src="${escapeHtml(u)}" alt="" loading="lazy">`).join('')}</div>` : '';

  main().innerHTML = `
    <div class="main-col">
      <div class="page-head">
        <a class="btn ghost sm" href="#/">← Feed</a>
        <div class="row">
          ${isOwner ? `<a class="btn secondary sm" href="#/edit/${escapeHtml(card.slug)}">Bearbeiten</a>
                       <button class="btn danger sm" id="delCard">Löschen</button>` : ''}
        </div>
      </div>
      <div class="card">
        <div class="c-head">
          ${avatarHtml(card.ownerNamespace, card.ownerNamespace, 'sm')}
          <div class="meta"><div class="nm">@${escapeHtml(card.ownerNamespace)}</div><div class="tm">${timeAgo(card.updatedAt)}</div></div>
          <span class="sp"></span>${visBadge(card.visibility)}
        </div>
        <h1 class="c-title" style="font-size:24px">${escapeHtml(card.title)}</h1>
        <div class="md">${renderMd(card.body)}</div>
        ${gallery}
      </div>
      ${commentsSectionHtml(card, comments)}
    </div>`;

  if (isOwner) $('#delCard').onclick = async () => {
    if (!confirm('Diese Card und alle Kommentare löschen?')) return;
    await api('deleteCard', { id: card.id }); toast('Card gelöscht'); go('/');
  };

  wireComments(card);

  if (anchorId) {
    const node = document.getElementById(anchorId);
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      node.classList.add('highlight');
      setTimeout(() => node.classList.remove('highlight'), 2100);
    }
  }
}

/* ---------- comments (§10) ---------- */
function commentsSectionHtml(card, comments) {
  const id = getIdentity();
  const count = countComments(comments);
  const composer = id
    ? `<div class="reply-box"><textarea id="newComment" placeholder="Kommentar schreiben… (Markdown)"></textarea>
         <div class="row" style="margin-top:8px"><button class="btn sm" id="postComment">Kommentieren</button></div></div>`
    : `<div class="card">Zum Kommentieren <a href="#/onboard">Identität anlegen</a>.</div>`;
  return `<h3 class="comments-head">${count} Kommentar${count === 1 ? '' : 'e'}</h3>
    ${composer}
    <div id="commentTree">${comments.map(c => commentHtml(c, 0)).join('')}</div>`;
}
function countComments(nodes) {
  return nodes.reduce((n, c) => n + 1 + countComments(c.children || []), 0);
}
function commentHtml(c, depth) {
  const id = getIdentity();
  const mine = id && id.namespace === c.authorNamespace;
  const body = c.deleted ? `<em>[gelöscht]</em>` : renderMd(c.body);
  const children = (c.children || []).map(ch => commentHtml(ch, depth + 1)).join('');
  // cap visual indentation at ~6 levels, then keep flat
  const childWrap = children ? `<div class="cmt-children" ${depth >= 6 ? 'style="margin-left:0;padding-left:0;border:none"' : ''}>${children}</div>` : '';
  return `<div class="cmt ${c.deleted ? 'deleted' : ''}" id="${escapeHtml(c.id)}" data-id="${escapeHtml(c.id)}">
    <div class="cmt-body-wrap"><div class="cmt-card">
      <div class="cmt-meta">${avatarHtml(c.author, c.authorNamespace, 'sm')}
        <span class="nm">${escapeHtml(c.author || c.authorNamespace)}</span>
        <span class="tm">· ${timeAgo(c.createdAt)}</span></div>
      <div class="cmt-text md">${body}</div>
      <div class="cmt-actions">
        ${id ? `<button class="btn ghost" data-act="reply">Antworten</button>` : ''}
        <button class="btn ghost" data-act="link">Link</button>
        ${mine && !c.deleted ? `<button class="btn ghost" data-act="del">Löschen</button>` : ''}
      </div>
    </div></div>
    ${childWrap}
  </div>`;
}
function wireComments(card) {
  const post = $('#postComment');
  if (post) post.onclick = async () => {
    const ta = $('#newComment'); const body = ta.value.trim();
    if (!body) return;
    post.disabled = true;
    try { await api('addComment', { cardId: card.id, body }); await viewCard(card.slug); }
    catch (e) { alert(e.message); post.disabled = false; }
  };
  const tree = $('#commentTree');
  if (!tree) return;
  tree.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const cmt = btn.closest('.cmt'); const cid = cmt.dataset.id;
    const act = btn.dataset.act;
    if (act === 'link') {
      const url = location.origin + location.pathname + cardLink(card.slug, cid);
      try { await navigator.clipboard.writeText(url); toast('Link kopiert'); }
      catch { prompt('Link kopieren:', url); }
    } else if (act === 'del') {
      if (!confirm('Kommentar löschen?')) return;
      await api('deleteComment', { id: cid }); await viewCard(card.slug);
    } else if (act === 'reply') {
      openReply(cmt, card, cid);
    }
  });
}
function openReply(cmt, card, parentId) {
  if ($('.reply-inline', cmt)) { $('.reply-inline', cmt).remove(); return; }
  const wrap = document.createElement('div');
  wrap.className = 'reply-inline reply-box';
  wrap.innerHTML = `<textarea placeholder="Antwort… (Markdown)"></textarea>
    <div class="row" style="margin-top:8px"><button class="btn sm">Antworten</button>
    <button class="btn ghost sm" data-cancel>Abbrechen</button></div>`;
  $('.cmt-body-wrap', cmt).appendChild(wrap);
  const ta = $('textarea', wrap); ta.focus();
  $('button.btn.sm', wrap).onclick = async () => {
    const body = ta.value.trim(); if (!body) return;
    await api('addComment', { cardId: card.id, parentId, body }); await viewCard(card.slug);
  };
  $('[data-cancel]', wrap).onclick = () => wrap.remove();
}

/* ---------- editor (new + edit) ---------- */
async function viewEditor(slug) {
  const id = getIdentity();
  if (!id) { main().innerHTML = `<div class="main-col"><div class="empty">Erst <a href="#/onboard">Identität anlegen</a>.</div></div>`; return; }

  let card = { id: null, title: '', body: '', images: [], visibility: 'public', spaceId: '' };
  if (slug) {
    const r = await api('getCard', { slug });
    card = { ...r.card };
    if (r.card.ownerNamespace !== id.namespace) { main().innerHTML = `<div class="main-col"><div class="empty">Nicht dein Card.</div></div>`; return; }
  }
  const spaces = await api('listSpaces', {});

  main().innerHTML = `
    <div class="main-col">
      <div class="page-head"><h1>${slug ? 'Card bearbeiten' : 'Neue Card'}</h1>
        <a class="btn ghost sm" href="${slug ? '#/c/' + escapeHtml(slug) : '#/'}">Abbrechen</a></div>
      <div class="field"><label>Titel</label><input type="text" id="fTitle" value="${escapeHtml(card.title)}" placeholder="Titel der Card"></div>
      <div class="field"><label>Sichtbarkeit</label>
        <select id="fVis">
          <option value="public" ${card.visibility === 'public' ? 'selected' : ''}>public — jeder mit Link</option>
          <option value="private" ${card.visibility === 'private' ? 'selected' : ''}>private — nur ich</option>
          <option value="space" ${card.visibility === 'space' ? 'selected' : ''}>space — Mitglieder eines Space</option>
        </select>
        <div class="hint" id="visHint"></div>
      </div>
      <div class="field" id="spaceWrap" hidden><label>Space</label>
        <select id="fSpace">${spaces.map(s => `<option value="${escapeHtml(s.id)}" ${card.spaceId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select>
        ${spaces.length ? '' : '<div class="hint">Du bist in keinem Space — erst unter „Spaces verwalten" einen anlegen.</div>'}
      </div>

      <div class="field"><label>Bilder</label>
        <div class="dropzone" id="drop">Bild hierher ziehen oder <u>klicken</u> zum Hochladen (wird auf max. 1600px skaliert)</div>
        <input type="file" id="fFile" accept="image/*" multiple hidden>
        <div class="thumbs" id="thumbs"></div>
      </div>

      <div class="field"><label>Inhalt (Markdown)</label>
        <div class="editor-grid">
          <div class="pane"><h3>Editor</h3><textarea id="fBody" style="min-height:300px">${escapeHtml(card.body)}</textarea></div>
          <div class="pane"><h3>Vorschau</h3><div class="preview-box md" id="preview"></div></div>
        </div>
      </div>

      <div class="row"><button class="btn" id="saveCard">${slug ? 'Speichern' : 'Card erstellen'}</button>
        <span class="muted" id="saveMsg"></span></div>
    </div>`;

  let images = Array.isArray(card.images) ? card.images.slice() : [];
  const body = $('#fBody'), preview = $('#preview'), visSel = $('#fVis');
  const renderPreview = () => { preview.innerHTML = renderMd(body.value); };
  body.oninput = renderPreview; renderPreview();

  const syncVis = () => {
    const v = visSel.value;
    $('#spaceWrap').hidden = v !== 'space';
    $('#visHint').textContent = v === 'private'
      ? 'Hinweis: Hochgeladene Bilder bleiben technisch über ihre Drive-Link-URL erreichbar.'
      : (v === 'public' ? 'Jeder mit dem Link kann diese Card sehen.' : '');
  };
  visSel.onchange = syncVis; syncVis();

  function renderThumbs() {
    $('#thumbs').innerHTML = images.map((u, i) => `<div class="thumb">
      <img src="${escapeHtml(u)}" alt="">
      <button data-rm="${i}" title="Entfernen">✕</button>
      <button class="ins" data-ins="${i}" title="In Text einfügen">einfügen</button></div>`).join('');
    $$('#thumbs [data-rm]').forEach(b => b.onclick = () => { images.splice(+b.dataset.rm, 1); renderThumbs(); });
    $$('#thumbs [data-ins]').forEach(b => b.onclick = () => {
      const u = images[+b.dataset.ins];
      body.value += `\n\n![](${u})\n`; renderPreview();
    });
  }
  renderThumbs();

  async function handleFiles(files) {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      $('#drop').textContent = 'Lädt hoch…';
      try { const url = await uploadImageFile(f); images.push(url); renderThumbs(); }
      catch (e) { alert('Upload fehlgeschlagen: ' + e.message); }
    }
    $('#drop').innerHTML = 'Bild hierher ziehen oder <u>klicken</u> zum Hochladen (wird auf max. 1600px skaliert)';
  }
  const drop = $('#drop'), fileInput = $('#fFile');
  drop.onclick = () => fileInput.click();
  fileInput.onchange = () => handleFiles(fileInput.files);
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', e => handleFiles(e.dataTransfer.files));

  $('#saveCard').onclick = async () => {
    const btn = $('#saveCard'); btn.disabled = true; $('#saveMsg').textContent = 'Speichert…';
    const payload = {
      title: $('#fTitle').value.trim() || 'Untitled',
      body: body.value, images,
      visibility: visSel.value,
      spaceId: visSel.value === 'space' ? ($('#fSpace') && $('#fSpace').value) || '' : '',
    };
    try {
      if (visSel.value === 'space' && !payload.spaceId) throw new Error('Bitte einen Space wählen (oder erst anlegen).');
      if (card.id) { await api('updateCard', { id: card.id, ...payload }); toast('Gespeichert'); go('/c/' + slug); }
      else { const r = await api('createCard', payload); toast('Card erstellt'); go('/c/' + r.slug); }
    } catch (e) { $('#saveMsg').textContent = ''; alert(e.message); btn.disabled = false; }
  };
}

/* ---------- onboarding (§3) ---------- */
function viewOnboard() {
  const id = getIdentity();
  const current = id ? `<div class="card">
      <div class="row">
        ${avatarHtml(id.displayName || id.firstName, id.namespace, 'lg')}
        <div class="grow"><strong>${escapeHtml(id.displayName || (id.firstName + ' ' + id.lastName))}</strong><div class="muted">@${escapeHtml(id.namespace)}</div></div>
        <button class="btn secondary sm" id="logout">Abmelden (lokal)</button>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn sm" id="copyMagic">🔗 Magic Link kopieren</button>
        <button class="btn ghost sm" id="copyTok">Token kopieren</button>
      </div>
      <div class="hint" style="margin-top:8px">Neues Gerät: <strong>Magic Link</strong> dort öffnen — die Identität wird automatisch übernommen. Der Link enthält dein Geheimnis (Token), teile ihn nur mit dir selbst.</div>
    </div>` : '';

  main().innerHTML = `<div class="main-col">
    <div class="page-head"><h1>Identität</h1><a class="btn ghost sm" href="#/">← Feed</a></div>
    ${current}
    <div class="ob-grid">
      <div class="ob-card">
        <h2>Neu anlegen</h2>
        <p class="muted" style="margin-top:0">Kein Login. Namespace ist global eindeutig, der Token bleibt nur lokal.</p>
        <div class="field"><label>Vorname</label><input type="text" id="rFirst"></div>
        <div class="field"><label>Nachname</label><input type="text" id="rLast"></div>
        <div class="field"><label>Namespace</label><input type="text" id="rNs" placeholder="z.B. dapu" autocapitalize="off">
          <div class="hint">3–20 Zeichen, a–z 0–9 _ -</div></div>
        <div class="field"><label>Anzeigename (optional)</label><input type="text" id="rDisp"></div>
        <button class="btn" id="doRegister">Identität anlegen</button>
        <div class="hint" id="rMsg" style="margin-top:8px"></div>
      </div>
      <div class="ob-card">
        <h2>Übernehmen</h2>
        <p class="muted" style="margin-top:0">Bestehende Identität auf diesem Gerät einrichten.</p>
        <div class="field"><label>Namespace</label><input type="text" id="cNs" autocapitalize="off"></div>
        <div class="field"><label>Token</label><input type="password" id="cTok"></div>
        <button class="btn secondary" id="doClaim">Identität übernehmen</button>
        <div class="hint" id="cMsg" style="margin-top:8px"></div>
      </div>
    </div>
  </div>`;

  if (id) {
    $('#logout').onclick = () => { if (confirm('Identität lokal entfernen? Mit Magic Link bzw. Namespace + Token wieder übernehmbar.')) { clearIdentity(); go('/'); router(); } };
    $('#copyTok').onclick = async () => { try { await navigator.clipboard.writeText(id.token); toast('Token kopiert'); } catch { prompt('Token:', id.token); } };
    $('#copyMagic').onclick = async () => {
      const link = magicLink(id);
      try { await navigator.clipboard.writeText(link); toast('Magic Link kopiert'); }
      catch { prompt('Magic Link:', link); }
    };
  }

  $('#doRegister').onclick = async () => {
    const f = $('#rFirst').value.trim(), l = $('#rLast').value.trim();
    const ns = $('#rNs').value.trim().toLowerCase(), disp = $('#rDisp').value.trim();
    const msg = $('#rMsg');
    if (!ns) { msg.textContent = 'Namespace fehlt.'; return; }
    msg.textContent = 'Wird angelegt…';
    try { await registerIdentity(f, l, ns, disp); toast('Willkommen, @' + ns); go('/'); router(); }
    catch (e) {
      msg.textContent = e.message === 'NAMESPACE_TAKEN'
        ? `„${ns}" ist vergeben. Versuche z.B. „${ns}${Math.floor(Math.random() * 90 + 10)}".`
        : (e.message === 'INVALID_NAMESPACE' ? 'Ungültiger Namespace (3–20, a–z 0–9 _ -).' : e.message);
    }
  };
  $('#doClaim').onclick = async () => {
    const ns = $('#cNs').value.trim().toLowerCase(), tok = $('#cTok').value.trim();
    const msg = $('#cMsg');
    if (!ns || !tok) { msg.textContent = 'Namespace und Token nötig.'; return; }
    msg.textContent = 'Wird übernommen…';
    try { await claimIdentity(ns, tok); toast('Übernommen: @' + ns); go('/'); router(); }
    catch (e) { msg.textContent = e.message === 'BAD_TOKEN' ? 'Token stimmt nicht.' : (e.message === 'UNKNOWN_USER' ? 'Namespace unbekannt.' : e.message); }
  };
}

/* ---------- magic-link claim (auto-adopt identity on a new device) ---------- */
async function viewClaim(ns, token) {
  // Drop the token from the visible URL / history once handled.
  const cleanUrl = () => { try { history.replaceState(null, '', location.pathname + location.search + '#/'); } catch (e) {} };
  const finish = async (msg) => { cleanUrl(); toast(msg); renderSidebar({ name: 'feed' }); await viewFeed(); };
  const doClaim = async () => {
    main().innerHTML = `<div class="main-col"><div class="empty">Identität wird übernommen…</div></div>`;
    try { await claimIdentity(ns, token); await finish('Übernommen: @' + ns); }
    catch (e) {
      const m = e.message === 'BAD_TOKEN' ? 'Token im Link stimmt nicht.'
        : e.message === 'UNKNOWN_USER' ? 'Namespace unbekannt.' : e.message;
      main().innerHTML = `<div class="main-col"><div class="empty">Magic Link ungültig: ${escapeHtml(m)}
        <div style="margin-top:12px"><a class="btn secondary sm" href="#/onboard">Zum Onboarding</a></div></div></div>`;
    }
  };

  if (!ns || !token) { main().innerHTML = `<div class="main-col"><div class="empty">Ungültiger Magic Link.</div></div>`; return; }
  const existing = getIdentity();
  if (existing && existing.namespace === ns && existing.token === token) { await finish('Bereits als @' + ns + ' angemeldet'); return; }
  if (existing && existing.namespace !== ns) {
    // Device already has a different identity — confirm before overwriting.
    main().innerHTML = `<div class="main-col">
      <div class="page-head"><h1>Identität übernehmen</h1></div>
      <div class="card">Dieses Gerät ist als <strong>@${escapeHtml(existing.namespace)}</strong> angemeldet.
        Mit dem Magic Link stattdessen als <strong>@${escapeHtml(ns)}</strong> anmelden?
        <div class="row" style="margin-top:12px">
          <button class="btn" id="mcConfirm">Als @${escapeHtml(ns)} übernehmen</button>
          <a class="btn secondary" href="#/">Abbrechen</a>
        </div>
      </div></div>`;
    $('#mcConfirm').onclick = doClaim;
    return;
  }
  await doClaim();
}

/* ---------- spaces (§3.4 / §4) ---------- */
async function viewSpaces() {
  const id = getIdentity();
  if (!id) { main().innerHTML = `<div class="main-col"><div class="empty">Erst <a href="#/onboard">Identität anlegen</a>.</div></div>`; return; }
  main().innerHTML = `<div class="main-col"><div class="empty">Lädt…</div></div>`;
  const spaces = await api('listSpaces', {});

  const list = spaces.length ? spaces.map(s => {
    const owner = s.ownerNamespace === id.namespace;
    return `<div class="card"><div class="space-item">
      <span class="ic">#</span>
      <div class="grow"><a href="#/s/${escapeHtml(s.slug)}"><strong>${escapeHtml(s.name)}</strong></a>
        <div class="muted">${s.members.length} Mitglied${s.members.length === 1 ? '' : 'er'}${owner ? ' · du bist Owner' : ''}</div></div>
      <a class="btn secondary sm" href="#/s/${escapeHtml(s.slug)}">Feed</a>
    </div>
    ${owner ? `<div class="row" style="margin-top:10px">
        <input type="text" placeholder="Namespace hinzufügen" data-addns="${escapeHtml(s.id)}" style="max-width:240px" autocapitalize="off">
        <button class="btn sm" data-addbtn="${escapeHtml(s.id)}">Mitglied hinzufügen</button>
        <span class="muted">${s.members.map(m => '@' + escapeHtml(m)).join(', ')}</span></div>` : ''}
    </div>`;
  }).join('') : `<div class="empty">Noch keine Spaces.</div>`;

  main().innerHTML = `<div class="main-col">
    <div class="page-head"><h1>Spaces</h1><a class="btn ghost sm" href="#/">← Feed</a></div>
    <div class="card"><div class="row">
      <input type="text" id="newSpaceName" placeholder="Name des neuen Space" style="flex:1;min-width:180px">
      <button class="btn" id="createSpace">Space anlegen</button>
    </div></div>
    ${list}
  </div>`;

  $('#createSpace').onclick = async () => {
    const name = $('#newSpaceName').value.trim(); if (!name) return;
    await api('createSpace', { name }); toast('Space angelegt'); viewSpaces(); renderSidebar(parseHash());
  };
  $$('[data-addbtn]').forEach(btn => btn.onclick = async () => {
    const sid = btn.dataset.addbtn;
    const inp = $(`[data-addns="${sid}"]`); const ns = inp.value.trim().toLowerCase();
    if (!ns) return;
    try { await api('addSpaceMember', { spaceId: sid, namespace: ns }); toast('@' + ns + ' hinzugefügt'); viewSpaces(); }
    catch (e) { alert(e.message === 'UNKNOWN_USER' ? 'Unbekannter Namespace.' : e.message); }
  });
}

/* ---------- drawer (mobile) ---------- */
function openDrawer() { document.body.classList.add('drawer-open'); document.getElementById('scrim').hidden = false; }
function closeDrawer() { document.body.classList.remove('drawer-open'); document.getElementById('scrim').hidden = true; }

/* ---------- init ---------- */
window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('menuToggle').onclick = openDrawer;
  document.getElementById('scrim').onclick = closeDrawer;
  router();
});
