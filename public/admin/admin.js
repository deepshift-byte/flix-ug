// FLIX-UG attendant screen: add titles, sell and top up tokens, see downloads.
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ugx = (n) => `${Number(n).toLocaleString('en-UG')} UGX`;
const mb = (bytes) => (bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : `${Math.round(bytes / 1048576)} MB`);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/admin/api/login') showLogin();
  return { ok: res.ok, status: res.status, data };
}

// Uploads one file as a raw byte stream, reporting progress (fetch cannot report upload progress).
function upload(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/admin/api/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status === 200 ? resolve(JSON.parse(xhr.responseText).fileId) : reject(new Error(`upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.send(file);
  });
}

function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
  $('password').focus();
}

async function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  await refresh();
}

async function refresh() {
  const { ok, data } = await api('/admin/api/overview');
  if (!ok) return;
  $('titles-body').innerHTML = data.titles.length ? data.titles.map((t) => `
    <tr>
      <td><img src="/media/poster/${encodeURIComponent(t.titleId)}" alt=""></td>
      <td><b>${escapeHtml(t.name)}</b>${t.year ? ` <span class="note">${t.year}</span>` : ''}</td>
      <td>${escapeHtml(t.genre)}</td>
      <td>${ugx(t.priceUgx)}</td>
      <td>${mb(t.sizeBytes)}</td>
      <td>${t.hasTrailer ? '<span class="ok">Yes</span>' : '<span class="note">No</span>'}</td>
      <td>${t.downloads}</td>
      <td><button class="btn btn-danger" data-remove="${escapeHtml(t.titleId)}">Remove</button></td>
    </tr>`).join('') : '<tr><td colspan="8" class="note">No titles yet. Add one above.</td></tr>';
  document.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Remove this title from the shop? Customers will no longer see it. The file stays on this PC.')) return;
    await api(`/admin/api/titles/${encodeURIComponent(btn.dataset.remove)}`, { method: 'DELETE' });
    refresh();
  }));

  $('tokens-body').innerHTML = data.tokens.length ? data.tokens.map((t) => `
    <tr><td><code>${escapeHtml(t.tokenNumber)}</code></td><td>${ugx(t.balanceUgx)}</td><td>${t.downloads}</td>
      <td class="note">${new Date(t.createdAt).toLocaleString()}</td></tr>`).join('')
    : '<tr><td colspan="4" class="note">No tokens sold yet.</td></tr>';

  $('stat-downloads').textContent = String(data.totals.downloads);
  $('stat-revenue').textContent = ugx(data.totals.revenueUgx);
  $('stat-titles').textContent = String(data.titles.length);
  $('downloads-body').innerHTML = [...data.titles].sort((a, b) => b.downloads - a.downloads).map((t) => `
    <tr><td>${escapeHtml(t.name)}</td><td>${escapeHtml(t.genre)}</td><td>${ugx(t.priceUgx)}</td><td><b>${t.downloads}</b></td></tr>`).join('');
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { ok } = await api('/admin/api/login', { method: 'POST', body: { password: $('password').value } });
  $('login-error').hidden = ok;
  if (ok) showApp();
});

document.querySelectorAll('nav button').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== btn.dataset.tab; });
  refresh();
}));

$('kind').addEventListener('change', () => { $('episodes-field').hidden = $('kind').value !== 'series'; });

$('title-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const files = { movie: form.movie.files[0], poster: form.poster.files[0], trailer: form.trailer.files[0] };
  const totalBytes = Object.values(files).reduce((sum, f) => sum + (f ? f.size : 0), 0);
  let doneBytes = 0;
  const bar = $('title-progress');
  const setProgress = (fraction) => { bar.querySelector('i').style.width = `${Math.round(fraction * 100)}%`; };
  $('title-submit').disabled = true;
  bar.hidden = false;
  setProgress(0);
  try {
    const ids = {};
    for (const [key, file] of Object.entries(files)) {
      if (!file) continue;
      $('title-status').textContent = `Uploading ${key}…`;
      ids[key] = await upload(file, (f) => setProgress((doneBytes + f * file.size) / totalBytes));
      doneBytes += file.size;
    }
    $('title-status').textContent = 'Checking the movie file (large files take a minute)…';
    const { ok, data } = await api('/admin/api/titles', {
      method: 'POST',
      body: {
        name: form.name.value, genre: form.genre.value, kind: form.kind.value, episodes: form.episodes.value,
        year: form.year.value, description: form.description.value,
        movieFile: ids.movie, posterFile: ids.poster, trailerFile: ids.trailer,
      },
    });
    if (!ok) throw new Error(data.reason ?? 'could not add the title');
    $('title-status').innerHTML = `<span class="ok">Added “${escapeHtml(form.name.value)}” at ${ugx(data.priceUgx)}. It is on the shop screen now.</span>`;
    form.reset();
    $('episodes-field').hidden = true;
    refresh();
  } catch (err) {
    $('title-status').innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  } finally {
    $('title-submit').disabled = false;
    bar.hidden = true;
  }
});

document.querySelectorAll('[data-amount]').forEach((btn) => btn.addEventListener('click', () => {
  $('sell-amount').value = btn.dataset.amount;
}));

$('sell-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('sell-pin').value.trim();
  const { ok, data } = await api('/admin/api/tokens', {
    method: 'POST', body: { amountUgx: Number($('sell-amount').value), ...(pin ? { pin } : {}) },
  });
  $('ticket').innerHTML = ok ? `
    <div class="ticket">
      <div><span>Token number</span><b>${escapeHtml(data.tokenNumber)}</b></div>
      <div><span>PIN</span><b>${escapeHtml(data.pin)}</b></div>
      <div><span>Balance</span><b>${ugx(data.balanceUgx)}</b></div>
    </div>` : `<p class="error">${escapeHtml(data.reason ?? 'Could not sell the token')}</p>`;
  $('sell-pin').value = '';
  refresh();
});

$('topup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('topup-token').value.trim();
  const { ok, data } = await api(`/admin/api/tokens/${encodeURIComponent(token)}/topup`, {
    method: 'POST', body: { amountUgx: Number($('topup-amount').value) },
  });
  $('topup-status').innerHTML = ok
    ? `<span class="ok">New balance: ${ugx(data.balanceUgx)}</span>`
    : `<span class="error">${data.reason === 'unknown_token' ? 'No such token.' : escapeHtml(data.reason ?? 'Failed')}</span>`;
  refresh();
});

// Logged in already (the cookie is still valid)? Go straight to the app.
api('/admin/api/session').then(({ data }) => (data.loggedIn ? showApp() : showLogin()));
