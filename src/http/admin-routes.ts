import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { readAsset } from '../assets.js';
import type { Db } from '../db.js';
import type { TitleCatalog } from '../catalog/title-catalog.js';
import { describeMovieFile } from '../catalog/describe-file.js';
import { priceFor } from '../pricing.js';
import { getBalance, topUp } from '../tokens/ledger.js';
import { createToken } from '../tokens/token-service.js';
import { displayName } from './shop-routes.js';

const COOKIE = 'flix_admin';
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `title-${Date.now()}`;

export function registerAdminRoutes(
  app: FastifyInstance,
  opts: { db: Db; catalog: TitleCatalog; mediaDir: string; adminPassword: string; secret: Buffer },
) {
  const { db, catalog, mediaDir, adminPassword, secret } = opts;
  const sessionToken = createHmac('sha256', secret).update(`flix-admin:${adminPassword}`).digest('hex');

  const cookieValue = (header: string | undefined) =>
    (header ?? '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === COOKIE)?.[1] ?? '';
  const sameText = (a: string, b: string) =>
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0];
    if (!url.startsWith('/admin/api/') || url === '/admin/api/login' || url === '/admin/api/session') return;
    if (!sameText(cookieValue(request.headers.cookie), sessionToken)) return reply.code(401).send({ reason: 'login_required' });
  });

  // Uploads arrive as a raw byte stream, so large movie files are written to disk without buffering.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));

  app.get('/admin', async (_request, reply) => reply.type('text/html; charset=utf-8').send(readAsset('admin/index.html')));
  app.get('/admin/admin.js', async (_request, reply) =>
    reply.type('application/javascript; charset=utf-8').send(readAsset('admin/admin.js')));

  app.post<{ Body: { password?: unknown } }>('/admin/api/login', async (request, reply) => {
    const password = request.body?.password;
    if (typeof password !== 'string' || !sameText(password, adminPassword)) {
      return reply.code(401).send({ reason: 'wrong_password' });
    }
    reply.header('set-cookie', `${COOKIE}=${sessionToken}; HttpOnly; Path=/; SameSite=Strict`);
    return { ok: true };
  });

  // Lets the page ask whether it is logged in without provoking an error.
  app.get('/admin/api/session', async (request) => ({
    loggedIn: sameText(cookieValue(request.headers.cookie), sessionToken),
  }));

  app.put<{ Querystring: { name?: string } }>('/admin/api/upload', async (request, reply) => {
    mkdirSync(mediaDir, { recursive: true });
    // Keep only the file's own name, so an upload can never be written outside the media folder.
    const safe = basename(String(request.query.name ?? 'upload')).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
    const fileId = `${Date.now()}-${randomBytes(3).toString('hex')}-${safe}`;
    await pipeline(request.body as Readable, createWriteStream(join(mediaDir, fileId)));
    return reply.send({ fileId });
  });

  const mediaPath = (fileId: unknown) => {
    if (typeof fileId !== 'string' || fileId === '') return undefined;
    const path = join(mediaDir, basename(fileId));
    return existsSync(path) ? path : undefined;
  };

  app.post<{
    Body: {
      titleId?: string; name?: string; year?: number | string; genre?: string; description?: string;
      kind?: string; episodes?: number | string; movieFile?: string; posterFile?: string; trailerFile?: string;
    };
  }>('/admin/api/titles', async (request, reply) => {
    const b = request.body ?? {};
    const name = String(b.name ?? '').trim();
    const movie = mediaPath(b.movieFile);
    if (!name || !movie) return reply.code(400).send({ reason: 'name_and_movie_required' });
    const kind = b.kind === 'series' ? 'series' : 'movie';
    const episodes = kind === 'series' ? Math.max(1, Number(b.episodes) || 1) : 1;
    const titleId = b.titleId ? slug(b.titleId) : slug(name);
    const described = await describeMovieFile(movie, { titleId, kind, episodes });
    catalog.upsert({
      ...described,
      name,
      year: Number(b.year) || undefined,
      genre: String(b.genre ?? '').trim() || undefined,
      description: String(b.description ?? '').trim() || undefined,
      posterPath: mediaPath(b.posterFile),
      trailerPath: mediaPath(b.trailerFile),
      addedAt: new Date().toISOString(),
    });
    return { titleId, priceUgx: priceFor(kind, episodes) };
  });

  app.delete<{ Params: { id: string } }>('/admin/api/titles/:id', async (request) => {
    catalog.remove(request.params.id);
    return { ok: true };
  });

  app.post<{ Body: { amountUgx?: unknown; pin?: unknown } }>('/admin/api/tokens', async (request, reply) => {
    const amount = Number(request.body?.amountUgx);
    if (!Number.isInteger(amount) || amount <= 0) return reply.code(400).send({ reason: 'bad_amount' });
    const pin = typeof request.body?.pin === 'string' && /^\d{4,6}$/.test(request.body.pin)
      ? request.body.pin
      : String(randomInt(0, 10_000)).padStart(4, '0');
    const { tokenNumber } = createToken(db, pin);
    topUp(db, tokenNumber, amount, `counter-${randomUUID()}`);
    return { tokenNumber, pin, balanceUgx: getBalance(db, tokenNumber) };
  });

  app.post<{ Params: { token: string }; Body: { amountUgx?: unknown } }>('/admin/api/tokens/:token/topup', async (request, reply) => {
    const amount = Number(request.body?.amountUgx);
    if (!Number.isInteger(amount) || amount <= 0) return reply.code(400).send({ reason: 'bad_amount' });
    const exists = db.prepare('select 1 from tokens where token_number = ?').get(request.params.token);
    if (!exists) return reply.code(404).send({ reason: 'unknown_token' });
    topUp(db, request.params.token, amount, `counter-${randomUUID()}`);
    return { tokenNumber: request.params.token, balanceUgx: getBalance(db, request.params.token) };
  });

  app.get('/admin/api/overview', async () => {
    const downloadsByTitle = new Map(
      (db.prepare('select title_id, count(*) as n from sessions where paid = 1 group by title_id').all() as
        { title_id: string; n: number }[]).map((r) => [r.title_id, Number(r.n)]),
    );
    const titles = catalog.list().map((t) => ({
      titleId: t.titleId, name: displayName(t), genre: t.genre ?? '', year: t.year ?? null,
      priceUgx: priceFor(t.kind, t.episodes), sizeBytes: t.fileSize,
      hasPoster: Boolean(t.posterPath), hasTrailer: Boolean(t.trailerPath),
      downloads: downloadsByTitle.get(t.titleId) ?? 0,
    }));
    const tokens = (db.prepare(
      `select t.token_number, t.balance_ugx, t.created_at,
              (select count(*) from sessions s where s.token_id = t.id and s.paid = 1) as downloads
         from tokens t order by t.id desc limit 200`,
    ).all() as { token_number: string; balance_ugx: number; created_at: string; downloads: number }[]).map((r) => ({
      tokenNumber: r.token_number, balanceUgx: Number(r.balance_ugx), createdAt: r.created_at, downloads: Number(r.downloads),
    }));
    const totals = db.prepare(
      `select (select count(*) from sessions where paid = 1) as downloads,
              (select coalesce(sum(amount_ugx), 0) from ledger where type = 'debit') as revenue`,
    ).get() as { downloads: number; revenue: number };
    return { titles, tokens, totals: { downloads: Number(totals.downloads), revenueUgx: Number(totals.revenue) } };
  });
}
