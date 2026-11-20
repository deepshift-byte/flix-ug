import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../src/http/app';
import { openDb } from '../src/db';
import { createToken } from '../src/tokens/token-service';
import { topUp, getBalance } from '../src/tokens/ledger';
import { catalogFromEntries, jsonCatalog, type TitleEntry } from '../src/catalog/title-catalog';
import { describeMovieFile } from '../src/catalog/describe-file';

const SECRET = Buffer.from('shop-test-secret-0123456789abcdef');
const dirs: string[] = [];
const tempDir = () => {
  mkdirSync(join(process.cwd(), '.superpowers'), { recursive: true });
  const d = mkdtempSync(join(process.cwd(), '.superpowers', 'shop-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

async function world(extra: Partial<TitleEntry> = {}) {
  const dir = tempDir();
  const moviePath = join(dir, 'movie.mp4');
  writeFileSync(moviePath, Buffer.alloc(5 * 1024 * 1024, 7));
  const trailerPath = join(dir, 'trailer.webm');
  writeFileSync(trailerPath, Buffer.from(Array.from({ length: 1000 }, (_, i) => i & 0xff)));
  const entry = {
    ...(await describeMovieFile(moviePath, { titleId: 'kampala-nights', kind: 'movie', episodes: 1 })),
    name: 'Kampala Nights', year: 2025, genre: 'Drama', description: 'A night in the city.', trailerPath,
    ...extra,
  };
  const db = openDb(':memory:');
  const { tokenNumber } = createToken(db, '4821');
  topUp(db, tokenNumber, 5000, 'pay-1');
  const mediaDir = join(dir, 'media');
  const app = buildApp({
    db, signingSecret: SECRET, catalog: catalogFromEntries([entry]), mediaDir, adminPassword: 'shop-owner',
  });
  return { app, db, tokenNumber, dir, mediaDir };
}

async function login(app: Awaited<ReturnType<typeof world>>['app']) {
  const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'shop-owner' } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0];
}

describe('storefront API', () => {
  it('lists titles with display details and price, without server file paths', async () => {
    const { app } = await world();
    const res = await app.inject({ method: 'GET', url: '/api/titles' });
    expect(res.statusCode).toBe(200);
    const [t] = res.json();
    expect(t).toMatchObject({
      titleId: 'kampala-nights', name: 'Kampala Nights', year: 2025, genre: 'Drama', priceUgx: 1000, hasTrailer: true,
    });
    expect(JSON.stringify(t)).not.toContain('movie.mp4');
  });

  it('serves a generated poster when none was uploaded', async () => {
    const { app } = await world();
    const res = await app.inject({ method: 'GET', url: '/media/poster/kampala-nights' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/svg/);
    expect(res.body).toContain('Kampala Nights');
  });

  it('streams a trailer with byte ranges so the player can seek', async () => {
    const { app } = await world();
    const full = await app.inject({ method: 'GET', url: '/media/trailer/kampala-nights' });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.length).toBe(1000);
    const part = await app.inject({ method: 'GET', url: '/media/trailer/kampala-nights', headers: { range: 'bytes=100-199' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 100-199/1000');
    expect([...part.rawPayload]).toEqual(Array.from({ length: 100 }, (_, i) => (i + 100) & 0xff));
  });

  it('returns 404 for a title without a trailer', async () => {
    const { app } = await world({ trailerPath: undefined });
    expect((await app.inject({ method: 'GET', url: '/media/trailer/kampala-nights' })).statusCode).toBe(404);
  });

  it('checks a token and PIN at checkout and returns the balance', async () => {
    const { app, tokenNumber } = await world();
    const ok = await app.inject({ method: 'POST', url: '/api/token/check', payload: { tokenNumber, pin: '4821' } });
    expect(ok.json()).toEqual({ balanceUgx: 5000 });
    const bad = await app.inject({ method: 'POST', url: '/api/token/check', payload: { tokenNumber, pin: '0000' } });
    expect(bad.statusCode).toBe(401);
  });

  it('serves the storefront page at /', async () => {
    const { app } = await world();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });
});

describe('attendant API', () => {
  it('refuses attendant requests without logging in, and refuses a wrong password', async () => {
    const { app } = await world();
    expect((await app.inject({ method: 'GET', url: '/admin/api/session' })).json()).toEqual({ loggedIn: false });
    expect((await app.inject({ method: 'GET', url: '/admin/api/overview' })).statusCode).toBe(401);
    const bad = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'guess' } });
    expect(bad.statusCode).toBe(401);
  });

  it('sells a token with a PIN and tops it up', async () => {
    const { app, db } = await world();
    const cookie = await login(app);
    expect((await app.inject({ method: 'GET', url: '/admin/api/session', headers: { cookie } })).json()).toEqual({ loggedIn: true });
    const sold = await app.inject({ method: 'POST', url: '/admin/api/tokens', headers: { cookie }, payload: { amountUgx: 3000 } });
    const { tokenNumber, pin, balanceUgx } = sold.json();
    expect(balanceUgx).toBe(3000);
    expect(pin).toMatch(/^\d{4}$/);
    const topped = await app.inject({ method: 'POST', url: `/admin/api/tokens/${tokenNumber}/topup`, headers: { cookie }, payload: { amountUgx: 2000 } });
    expect(topped.json()).toEqual({ tokenNumber, balanceUgx: 5000 });
    expect(getBalance(db, tokenNumber)).toBe(5000);
  });

  it('uploads a movie, poster and trailer and adds the title to the catalog', async () => {
    const { app, mediaDir } = await world();
    const cookie = await login(app);
    const upload = async (name: string, bytes: Buffer) => {
      const res = await app.inject({
        method: 'PUT', url: `/admin/api/upload?name=${encodeURIComponent(name)}`,
        headers: { cookie, 'content-type': 'application/octet-stream' }, payload: bytes,
      });
      expect(res.statusCode).toBe(200);
      return res.json().fileId as string;
    };
    const movie = await upload('Nile Runners.mp4', Buffer.alloc(6 * 1024 * 1024, 3));
    const poster = await upload('poster.jpg', Buffer.from('fake-jpeg'));
    const trailer = await upload('trailer.mp4', Buffer.from('fake-trailer'));
    expect(existsSync(join(mediaDir, movie))).toBe(true);

    const created = await app.inject({
      method: 'POST', url: '/admin/api/titles', headers: { cookie },
      payload: { name: 'Nile Runners', year: 2024, genre: 'Action', description: 'Fast.', kind: 'series', episodes: 12, movieFile: movie, posterFile: poster, trailerFile: trailer },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ titleId: 'nile-runners', priceUgx: 2000 });
    const titles = (await app.inject({ method: 'GET', url: '/api/titles' })).json();
    expect(titles.map((t: { titleId: string }) => t.titleId)).toContain('nile-runners');
    const posterRes = await app.inject({ method: 'GET', url: '/media/poster/nile-runners' });
    expect(posterRes.body).toBe('fake-jpeg');
  });

  it('refuses an upload name that tries to leave the media folder', async () => {
    const { app, dir } = await world();
    const cookie = await login(app);
    const res = await app.inject({
      method: 'PUT', url: `/admin/api/upload?name=${encodeURIComponent('../../evil.txt')}`,
      headers: { cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from('x'),
    });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(dir, 'evil.txt'))).toBe(false);
  });

  it('reports downloads per title and per token', async () => {
    const { app, tokenNumber } = await world();
    const cookie = await login(app);
    const start = await app.inject({
      method: 'POST', url: '/sessions', payload: { tokenNumber, pin: '4821', titleId: 'kampala-nights', destination: 'usb' },
    });
    const info = start.json();
    const last = info.links[info.links.length - 1];
    await app.inject({ method: 'GET', url: `/sessions/${info.sessionId}/chunks/${info.links.length - 1}?exp=${last.exp}&sig=${last.sig}` });
    const overview = (await app.inject({ method: 'GET', url: '/admin/api/overview', headers: { cookie } })).json();
    expect(overview.titles.find((t: { titleId: string }) => t.titleId === 'kampala-nights').downloads).toBe(1);
    expect(overview.tokens.find((t: { tokenNumber: string }) => t.tokenNumber === tokenNumber)).toMatchObject({ balanceUgx: 4000, downloads: 1 });
    expect(overview.totals).toMatchObject({ downloads: 1, revenueUgx: 1000 });
  });
});

describe('json catalog file', () => {
  it('saves added titles so they survive a restart', async () => {
    const dir = tempDir();
    const path = join(dir, 'catalog.json');
    const moviePath = join(dir, 'm.mp4');
    writeFileSync(moviePath, Buffer.alloc(1000, 1));
    const entry = await describeMovieFile(moviePath, { titleId: 'm', kind: 'movie', episodes: 1 });
    jsonCatalog(path).upsert({ ...entry, name: 'M' });
    expect(jsonCatalog(path).get('m')?.name).toBe('M');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(1);
  });
});
