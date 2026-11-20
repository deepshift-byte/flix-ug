import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { readAsset } from '../assets.js';
import type { Db } from '../db.js';
import type { TitleCatalog, TitleEntry } from '../catalog/title-catalog.js';
import { priceFor } from '../pricing.js';
import { getBalance } from '../tokens/ledger.js';
import { verifyPin } from '../tokens/token-service.js';
import { generatedPoster, sendFile } from './media.js';

const PIN_STATUS: Record<string, number> = { bad_pin: 401, unknown_token: 401, locked: 423, disabled: 403 };

export const displayName = (t: TitleEntry) => t.name ?? t.titleId;

// What the storefront may see about a title: no server file paths.
export function publicTitle(t: TitleEntry) {
  return {
    titleId: t.titleId,
    name: displayName(t),
    year: t.year ?? null,
    genre: t.genre ?? (t.kind === 'series' ? 'Series' : 'Movies'),
    description: t.description ?? '',
    kind: t.kind,
    episodes: t.episodes,
    priceUgx: priceFor(t.kind, t.episodes),
    sizeBytes: t.fileSize,
    extension: extname(t.filePath).toLowerCase() || '.mp4',
    hasTrailer: Boolean(t.trailerPath && existsSync(t.trailerPath)),
    addedAt: t.addedAt ?? null,
  };
}

export function registerShopRoutes(app: FastifyInstance, opts: { db: Db; catalog: TitleCatalog; now: () => Date }) {
  const { db, catalog, now } = opts;

  const pages: [string, string, string][] = [
    ['/', 'shop/index.html', 'text/html; charset=utf-8'],
    ['/shop/shop.css', 'shop/shop.css', 'text/css; charset=utf-8'],
    ['/shop/shop.js', 'shop/shop.js', 'application/javascript; charset=utf-8'],
  ];
  for (const [url, file, type] of pages) app.get(url, async (_request, reply) => reply.type(type).send(readAsset(file)));

  app.get('/api/titles', async () =>
    catalog.list().map(publicTitle).sort((a, b) => String(b.addedAt ?? '').localeCompare(String(a.addedAt ?? ''))));

  app.get<{ Params: { id: string } }>('/media/poster/:id', async (request, reply) => {
    const title = catalog.get(request.params.id);
    if (!title) return reply.code(404).send({ reason: 'unknown_title' });
    if (title.posterPath && existsSync(title.posterPath)) return sendFile(request, reply, title.posterPath);
    const subtitle = [title.year, title.genre].filter(Boolean).join(' · ');
    return reply.type('image/svg+xml').send(generatedPoster(title.titleId, displayName(title), subtitle));
  });

  app.get<{ Params: { id: string } }>('/media/trailer/:id', async (request, reply) => {
    const title = catalog.get(request.params.id);
    if (!title?.trailerPath || !existsSync(title.trailerPath)) return reply.code(404).send({ reason: 'no_trailer' });
    return sendFile(request, reply, title.trailerPath);
  });

  app.post<{ Body: { tokenNumber?: unknown; pin?: unknown } }>('/api/token/check', async (request, reply) => {
    const { tokenNumber, pin } = request.body ?? {};
    if (typeof tokenNumber !== 'string' || typeof pin !== 'string') return reply.code(400).send({ reason: 'bad_request' });
    const result = verifyPin(db, tokenNumber.trim(), pin.trim(), now());
    if (!result.ok) return reply.code(PIN_STATUS[result.reason] ?? 401).send({ reason: result.reason });
    return { balanceUgx: getBalance(db, tokenNumber.trim()) };
  });
}
