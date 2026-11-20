// FLIX-UG storefront: browse, watch trailers, fill a cart, then pay with a token and copy to a flash disk.
import { Sha256 } from '/phone/assemble.js';

const CHUNK_SIZE = 4 * 1024 * 1024; // must match the server
const MAX_CHUNK_ATTEMPTS = 3;
const CART_KEY = 'flix-cart';

const $ = (id) => document.getElementById(id);
const state = { titles: [], byId: new Map(), cart: loadCart(), filter: 'all', query: '', checkout: null };

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ugx = (n) => `${Number(n).toLocaleString('en-UG')} UGX`;
const mb = (bytes) => (bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : `${Math.round(bytes / 1048576)} MB`);
const kindLabel = (t) => (t.kind === 'series' ? `Series · ${t.episodes} episodes` : 'Movie');

// ---------- data ----------

function loadCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch { return []; }
}
function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch { /* private mode: cart lasts for this page only */ }
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function load() {
  const { data } = await api('/api/titles');
  state.titles = Array.isArray(data) ? data : [];
  state.byId = new Map(state.titles.map((t) => [t.titleId, t]));
  state.cart = state.cart.filter((id) => state.byId.has(id));
  saveCart();
  render();
  renderCart();
}

// ---------- browse ----------

function card(t) {
  const el = document.createElement('button');
  el.className = 'card' + (state.cart.includes(t.titleId) ? ' in-cart' : '');
  el.dataset.id = t.titleId;
  el.setAttribute('aria-label', `${t.name}, ${ugx(t.priceUgx)}`);
  el.innerHTML = `
    <img src="/media/poster/${encodeURIComponent(t.titleId)}" alt="" loading="lazy">
    ${t.kind === 'series' ? '<span class="card-badge">SERIES</span>' : ''}
    <span class="card-info">
      <span class="card-name">${escapeHtml(t.name)}</span>
      <span class="card-meta">${[t.year, ugx(t.priceUgx)].filter(Boolean).join(' · ')}</span>
    </span>`;
  el.addEventListener('click', () => openDetails(t.titleId));
  return el;
}

function row(title, titles) {
  const section = document.createElement('section');
  section.className = 'row';
  section.innerHTML = `<h2 class="row-title">${escapeHtml(title)}</h2>
    <div class="row-wrap">
      <button class="row-arrow left" aria-label="Scroll left">&#8249;</button>
      <div class="row-track"></div>
      <button class="row-arrow right" aria-label="Scroll right">&#8250;</button>
    </div>`;
  const track = section.querySelector('.row-track');
  titles.forEach((t) => track.append(card(t)));
  const scroll = (dir) => track.scrollBy({ left: dir * track.clientWidth * 0.85 });
  section.querySelector('.left').addEventListener('click', () => scroll(-1));
  section.querySelector('.right').addEventListener('click', () => scroll(1));
  return section;
}

function visibleTitles() {
  return state.titles.filter((t) => state.filter === 'all' || t.kind === state.filter);
}

function renderHero(titles) {
  const hero = $('hero');
  const featured = titles.find((t) => t.hasTrailer) ?? titles[0];
  if (!featured) { hero.innerHTML = ''; hero.hidden = true; return; }
  hero.hidden = false;
  const poster = `/media/poster/${encodeURIComponent(featured.titleId)}`;
  hero.innerHTML = `
    <div class="hero-bg">
      <img src="${poster}" alt="">
      ${featured.hasTrailer ? `<video src="/media/trailer/${encodeURIComponent(featured.titleId)}" muted autoplay loop playsinline style="position:absolute;inset:0"></video>` : ''}
    </div>
    <div class="hero-content">
      <h1>${escapeHtml(featured.name)}</h1>
      <div class="hero-meta">
        ${featured.year ? `<span>${featured.year}</span>` : ''}
        <span class="pill">${escapeHtml(kindLabel(featured))}</span>
        <span>${escapeHtml(featured.genre)}</span>
        <span class="price-tag">${ugx(featured.priceUgx)}</span>
      </div>
      ${featured.description ? `<p>${escapeHtml(featured.description)}</p>` : ''}
      <div class="btn-row">
        <button class="btn btn-light" data-act="details">
          <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>${featured.hasTrailer ? 'Watch trailer' : 'More info'}
        </button>
        <button class="btn btn-ghost" data-act="cart">${state.cart.includes(featured.titleId) ? '✓ In cart' : '+ Add to cart'}</button>
      </div>
    </div>`;
  const video = hero.querySelector('video');
  if (video) video.addEventListener('error', () => video.remove());
  hero.querySelector('[data-act="details"]').addEventListener('click', () => openDetails(featured.titleId));
  hero.querySelector('[data-act="cart"]').addEventListener('click', () => toggleCart(featured.titleId));
}

function render() {
  const titles = visibleTitles();
  const rows = $('rows');
  rows.innerHTML = '';
  $('empty').hidden = state.titles.length > 0;

  if (state.query) {
    const q = state.query.toLowerCase();
    const found = titles.filter((t) => [t.name, t.genre, t.description].some((s) => String(s).toLowerCase().includes(q)));
    $('hero').hidden = true;
    rows.hidden = true;
    $('results').hidden = false;
    $('results-title').textContent = found.length ? `Results for “${state.query}”` : `No titles match “${state.query}”`;
    const grid = $('results-grid');
    grid.innerHTML = '';
    found.forEach((t) => grid.append(card(t)));
    return;
  }

  $('results').hidden = true;
  rows.hidden = false;
  renderHero(titles);
  if (titles.length === 0) return;

  const newest = [...titles].sort((a, b) => String(b.addedAt ?? '').localeCompare(String(a.addedAt ?? '')));
  rows.append(row(state.filter === 'series' ? 'New series' : 'New on FLIX-UG', newest.slice(0, 20)));
  const genres = new Map();
  for (const t of titles) genres.set(t.genre, [...(genres.get(t.genre) ?? []), t]);
  [...genres.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([genre, list]) => rows.append(row(genre, list)));
  if (state.filter === 'all') {
    const series = titles.filter((t) => t.kind === 'series');
    if (series.length && !genres.has('Series')) rows.append(row('TV Series', series));
  }
}

// ---------- details ----------

function openDetails(titleId) {
  const t = state.byId.get(titleId);
  if (!t) return;
  const poster = `/media/poster/${encodeURIComponent(t.titleId)}`;
  $('details-media').innerHTML = t.hasTrailer
    ? `<video src="/media/trailer/${encodeURIComponent(t.titleId)}" controls autoplay playsinline poster="${poster}"></video>`
    : `<img src="${poster}" alt=""><div class="no-trailer">No trailer for this title yet</div>`;
  const inCart = state.cart.includes(t.titleId);
  $('details-body').innerHTML = `
    <div>
      <h2 id="details-title">${escapeHtml(t.name)}</h2>
      <div class="details-meta">
        ${t.year ? `<span>${t.year}</span>` : ''}
        <span class="pill">${escapeHtml(kindLabel(t))}</span>
        <span>${escapeHtml(t.genre)}</span>
        <span>${mb(t.sizeBytes)}</span>
        <span class="price-tag">${ugx(t.priceUgx)}</span>
      </div>
      ${t.description ? `<p>${escapeHtml(t.description)}</p>` : ''}
      <div class="btn-row">
        <button class="btn ${inCart ? 'btn-ghost' : 'btn-primary'}" id="details-cart">${inCart ? 'Remove from cart' : '+ Add to cart'}</button>
        ${state.cart.length ? '<button class="btn btn-ghost" id="details-open-cart">View cart</button>' : ''}
      </div>
    </div>
    <img class="details-poster" src="${poster}" alt="">`;
  $('details-cart').addEventListener('click', () => { toggleCart(t.titleId); openDetails(t.titleId); });
  $('details-open-cart')?.addEventListener('click', () => { closeDetails(); openCart(); });
  $('details').hidden = false;
}

function closeDetails() {
  const video = $('details-media').querySelector('video');
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
  $('details-media').innerHTML = '';
  $('details').hidden = true;
}

// ---------- cart ----------

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2200);
}

function toggleCart(titleId) {
  const t = state.byId.get(titleId);
  if (state.cart.includes(titleId)) {
    state.cart = state.cart.filter((id) => id !== titleId);
    toast(`Removed “${t.name}” from your cart`);
  } else {
    state.cart.push(titleId);
    toast(`Added “${t.name}” to your cart`);
    $('cart-button').classList.remove('bump');
    void $('cart-button').offsetWidth;
    $('cart-button').classList.add('bump');
  }
  saveCart();
  renderCart();
  render();
}

const cartTitles = () => state.cart.map((id) => state.byId.get(id)).filter(Boolean);
const cartTotal = () => cartTitles().reduce((sum, t) => sum + t.priceUgx, 0);

function renderCart() {
  const items = cartTitles();
  $('cart-count').textContent = String(items.length);
  $('cart-total').textContent = ugx(cartTotal());
  $('checkout-button').disabled = items.length === 0;
  const list = $('cart-items');
  list.innerHTML = items.length ? '' : '<li class="cart-empty">Your cart is empty. Add movies from the rows.</li>';
  for (const t of items) {
    const li = document.createElement('li');
    li.className = 'cart-item';
    li.innerHTML = `<img src="/media/poster/${encodeURIComponent(t.titleId)}" alt="">
      <div><div class="name">${escapeHtml(t.name)}</div><div class="sub">${escapeHtml(kindLabel(t))} · ${ugx(t.priceUgx)}</div></div>
      <button class="remove">Remove</button>`;
    li.querySelector('.remove').addEventListener('click', () => toggleCart(t.titleId));
    list.append(li);
  }
}

function openCart() { $('cart').hidden = false; }
function closeCart() { $('cart').hidden = true; }

// ---------- checkout ----------

const PIN_MESSAGES = {
  bad_pin: 'The token number or PIN is wrong.',
  unknown_token: 'The token number or PIN is wrong.',
  locked: 'Too many wrong PINs. This token is locked for 15 minutes.',
  disabled: 'This token has been disabled. Please see the attendant.',
};

function openCheckout() {
  closeCart();
  state.checkout = null;
  $('checkout').hidden = false;
  showTokenStep();
}

function closeCheckout() {
  if (state.checkout?.copying) return; // do not leave in the middle of a copy
  $('checkout').hidden = true;
}

function showTokenStep(message = '') {
  const items = cartTitles();
  $('checkout-step').innerHTML = `
    <p class="note">${items.length} title${items.length === 1 ? '' : 's'} · <strong>${ugx(cartTotal())}</strong>.
      Enter the token you bought at the counter.</p>
    <form id="token-form">
      <label class="field"><span>Token number</span><input id="co-token" autocomplete="off" required></label>
      <label class="field"><span>PIN</span><input id="co-pin" type="password" inputmode="numeric" autocomplete="off" required></label>
      ${message ? `<p class="error">${escapeHtml(message)}</p>` : ''}
      <button class="btn btn-primary btn-block" type="submit">Continue</button>
    </form>`;
  $('co-token').focus();
  $('token-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const tokenNumber = $('co-token').value.trim();
    const pin = $('co-pin').value.trim();
    const { ok, data } = await api('/api/token/check', { tokenNumber, pin });
    if (!ok) return showTokenStep(PIN_MESSAGES[data.reason] ?? `Could not check the token (${data.reason ?? 'error'}).`);
    state.checkout = { tokenNumber, pin, balanceUgx: data.balanceUgx };
    showDestinationStep();
  });
}

function showDestinationStep() {
  const { balanceUgx, tokenNumber } = state.checkout;
  const items = cartTitles();
  const total = cartTotal();
  const enough = balanceUgx >= total;
  const canSaveToFolder = 'showDirectoryPicker' in window;
  $('checkout-step').innerHTML = `
    <div class="balance-box">
      Token balance: <strong>${ugx(balanceUgx)}</strong><br>
      Cart total: <strong>${ugx(total)}</strong>
      ${enough ? `<br>After download: <strong>${ugx(balanceUgx - total)}</strong>`
        : `<br><span class="error">Not enough balance. Remove ${ugx(total - balanceUgx)} worth of titles, or top up at the counter.</span>`}
    </div>
    ${canSaveToFolder ? `
      <p class="note">Plug in your flash disk, then choose it in the window that opens. Each movie is charged once, only when it has been fully sent. If the copy stops, run checkout again to continue.</p>
      <button class="btn btn-primary btn-block" id="co-save" ${enough ? '' : 'disabled'}>Choose flash disk and download</button>`
    : `
      <p class="note">This browser cannot save to a flash disk. Use Google Chrome or Microsoft Edge on the shop computer, or download each title on this phone:</p>
      <div class="btn-row">${items.map((t) => `<a class="btn btn-ghost" href="/phone/?title=${encodeURIComponent(t.titleId)}&token=${encodeURIComponent(tokenNumber)}">${escapeHtml(t.name)}</a>`).join('')}</div>`}
  `;
  $('co-save')?.addEventListener('click', chooseFolderAndCopy);
}

async function chooseFolderAndCopy() {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'flix-usb', mode: 'readwrite', startIn: 'desktop' });
  } catch {
    return; // the customer closed the picker
  }
  const items = cartTitles();
  state.checkout.copying = true;
  $('checkout-step').innerHTML = `
    <p class="note">Saving to <strong>${escapeHtml(dir.name)}</strong>. Keep the flash disk plugged in.</p>
    <ul class="progress-list">${items.map((t) => `
      <li class="progress-item" data-id="${escapeHtml(t.titleId)}">
        <div class="progress-top"><span>${escapeHtml(t.name)}</span><span class="progress-state">Waiting</span></div>
        <div class="bar"><i></i></div>
      </li>`).join('')}</ul>
    <div id="co-summary"></div>`;

  let failures = 0;
  for (const t of items) {
    const li = $('checkout-step').querySelector(`[data-id="${CSS.escape(t.titleId)}"]`);
    const setState = (text, cls = '') => { const s = li.querySelector('.progress-state'); s.textContent = text; s.className = `progress-state ${cls}`; };
    const setBar = (fraction, done = false) => { li.querySelector('.bar > i').style.width = `${Math.round(fraction * 100)}%`; li.querySelector('.bar').classList.toggle('done', done); };
    setState('Starting…');
    try {
      const result = await copyTitle(dir, t, state.checkout, (f) => { setBar(f); setState(`${Math.floor(f * 100)}%`); });
      if (result.ok) {
        setBar(1, true);
        setState(result.already ? 'Already on the disk' : 'Done', 'done');
        state.cart = state.cart.filter((id) => id !== t.titleId);
        saveCart();
      } else {
        failures++;
        setState(COPY_MESSAGES[result.reason] ?? `Stopped (${result.reason})`, 'failed');
      }
    } catch (err) {
      failures++;
      setState('Could not write to the flash disk. Is it full or unplugged?', 'failed');
      console.error(err);
    }
  }
  state.checkout.copying = false;
  renderCart();
  render();
  const { data } = await api('/api/token/check', { tokenNumber: state.checkout.tokenNumber, pin: state.checkout.pin });
  $('co-summary').innerHTML = `
    <div class="balance-box">${failures === 0
      ? '<strong>All done.</strong> You can now safely remove your flash disk.'
      : `<strong>${failures} title${failures === 1 ? ' was' : 's were'} not copied.</strong> Check the flash disk and run checkout again to continue. A title is never charged twice.`}
      ${typeof data.balanceUgx === 'number' ? `<br>Token balance now: <strong>${ugx(data.balanceUgx)}</strong>` : ''}</div>
    <button class="btn btn-ghost btn-block" id="co-close">Close</button>`;
  $('co-close').addEventListener('click', closeCheckout);
}

const COPY_MESSAGES = {
  insufficient_balance: 'Not enough balance on the token',
  active_session_exists: 'This token is finishing another download. Try again shortly.',
  chunk_failed: 'The file was damaged in transfer. Please tell the attendant.',
  already_downloaded: 'Already downloaded on this token',
  network_error: 'Lost connection to the shop server. Run checkout again to continue.',
  bad_pin: 'Wrong PIN',
  locked: 'Token locked for 15 minutes',
};

// ---------- copying to the flash disk ----------

async function sha256Hex(bytes) {
  // WebCrypto exists only on secure pages (localhost or https); the fallback hashes in JavaScript.
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return new Sha256().update(bytes).hex();
}

const fileNameFor = (t) => {
  const base = t.name.replace(/[\\/:*?"<>|]+/g, '').trim() || t.titleId;
  return `${base}${t.kind === 'series' ? ` (${t.episodes} episodes)` : ''}${t.extension || '.mp4'}`;
};

async function readJournal(dir, name) {
  try {
    return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
  } catch {
    return null;
  }
}

async function writeJournal(dir, name, value) {
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(JSON.stringify(value));
  await writable.close();
}

async function fileSize(dir, name) {
  try { return (await (await dir.getFileHandle(name)).getFile()).size; } catch { return -1; }
}

async function fetchVerifiedChunk(info, index) {
  for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS; attempt++) {
    let bytes;
    try {
      const link = info.links[index];
      const res = await fetch(`/sessions/${info.sessionId}/chunks/${index}?exp=${link.exp}&sig=${link.sig}`);
      if (!res.ok) throw new Error(`chunk ${index}: ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      return { error: 'network_error' };
    }
    if ((await sha256Hex(bytes)) === info.chunkHashes[index]) return { bytes };
  }
  return { error: 'chunk_failed' };
}

// Copies one title. The file appears on the disk only when it is complete; an interrupted copy starts the
// file again, but the session (and its single charge) carries on, so a title is never charged twice.
async function copyTitle(dir, title, token, onProgress) {
  const fileName = fileNameFor(title);
  const journalName = `.flix-${title.titleId}.json`;
  let info = null;

  const journal = await readJournal(dir, journalName);
  if (journal?.sessionId) {
    const status = await api(`/sessions/${journal.sessionId}`);
    if (status.ok && status.data.status === 'active') info = status.data;
    else if (status.ok && status.data.status === 'complete') {
      await dir.removeEntry(journalName).catch(() => {});
      if ((await fileSize(dir, fileName)) === status.data.fileSize) return { ok: true, already: true };
      return { ok: false, reason: 'already_downloaded' };
    }
  }

  if (!info) {
    const started = await api('/sessions', {
      tokenNumber: token.tokenNumber, pin: token.pin, titleId: title.titleId, destination: 'usb',
    });
    if (!started.ok) return { ok: false, reason: started.data.reason ?? 'error' };
    info = started.data;
    await writeJournal(dir, journalName, { sessionId: info.sessionId, titleId: title.titleId });
  }

  const writable = await (await dir.getFileHandle(fileName, { create: true })).createWritable();
  let confirmed = info.bytesConfirmed ?? 0;
  try {
    const count = info.chunkHashes.length;
    for (let index = 0; index < count; index++) {
      const chunk = await fetchVerifiedChunk(info, index);
      if (chunk.error) {
        if (chunk.error === 'chunk_failed') await api(`/sessions/${info.sessionId}/abandon`, {});
        await writable.abort();
        return { ok: false, reason: chunk.error };
      }
      await writable.write(chunk.bytes);
      const end = Math.min((index + 1) * CHUNK_SIZE, info.fileSize);
      if (end > confirmed) {
        await api(`/sessions/${info.sessionId}/confirm`, { offset: end });
        confirmed = end;
      }
      onProgress(end / info.fileSize);
    }
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    throw err;
  }

  const done = await api(`/sessions/${info.sessionId}/complete`, { checksum: info.fileChecksum });
  if (!done.ok && done.data.reason !== 'not_active') return { ok: false, reason: done.data.reason ?? 'error' };
  await dir.removeEntry(journalName).catch(() => {});
  return { ok: true };
}

// ---------- wiring ----------

document.querySelectorAll('.nav-link').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('.nav-link').forEach((b) => b.classList.toggle('active', b === btn));
  state.filter = btn.dataset.filter;
  render();
}));
$('search').addEventListener('input', (e) => { state.query = e.target.value.trim(); render(); });
$('cart-button').addEventListener('click', openCart);
$('checkout-button').addEventListener('click', openCheckout);
document.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeDetails));
document.querySelectorAll('[data-close-cart]').forEach((el) => el.addEventListener('click', closeCart));
document.querySelectorAll('[data-close-checkout]').forEach((el) => el.addEventListener('click', closeCheckout));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('checkout').hidden) closeCheckout();
  else if (!$('details').hidden) closeDetails();
  else if (!$('cart').hidden) closeCart();
});
window.addEventListener('scroll', () => $('topbar').classList.toggle('solid', window.scrollY > 40), { passive: true });

load();
