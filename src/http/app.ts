import Fastify, { type FastifyInstance } from 'fastify';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { isLanAddress } from './lan-only.js';
import type { TitleCatalog } from '../catalog/title-catalog.js';
import { CHUNK_SIZE, chunkCount } from '../download/chunks.js';
import { signLink, verifyLink } from '../download/signed-link.js';
import {
  abandonSession, completeSession, confirmOffset, getSession, payForLastChunk, startSession,
} from '../sessions/session-service.js';

const LINK_TTL_MS = 24 * 60 * 60 * 1000;

const START_STATUS: Record<string, number> = {
  bad_pin: 401,
  unknown_token: 401,
  locked: 423,
  disabled: 403,
  insufficient_balance: 402,
  active_session_exists: 409,
};

const COMPLETE_STATUS: Record<string, number> = {
  not_active: 409,
  incomplete: 409,
  checksum_mismatch: 422,
  insufficient_balance: 402,
};

export type AppOptions = {
  db: Database.Database;
  signingSecret: Buffer;
  catalog: TitleCatalog;
  clock?: () => Date;
};

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify();
  const { db, signingSecret: secret, catalog } = opts;
  const now = opts.clock ?? (() => new Date());

  app.addHook('onRequest', async (request, reply) => {
    if (!isLanAddress(request.ip)) return reply.code(403).send({ reason: 'lan_only' });
  });

  function sessionInfo(sessionId: string) {
    const row = getSession(db, sessionId);
    if (!row) return undefined;
    const hashes = JSON.parse(row.chunk_hashes) as string[];
    const expiresAt = new Date(now().getTime() + LINK_TTL_MS);
    const links = hashes.map((_, index) => {
      const query = new URLSearchParams(signLink({ sessionId, chunkIndex: index, expiresAt }, secret));
      return { exp: query.get('exp'), sig: query.get('sig') };
    });
    return {
      sessionId,
      status: row.status,
      bytesConfirmed: row.bytes_confirmed,
      fileSize: row.expected_size,
      chunkHashes: hashes,
      fileChecksum: row.file_checksum,
      links,
    };
  }

  app.post<{
    Body: { tokenNumber: string; pin: string; titleId: string; destination: 'usb' | 'phone' };
  }>('/sessions', async (request, reply) => {
    const body = (request.body ?? {}) as Partial<{ tokenNumber: string; pin: string; titleId: string; destination: 'usb' | 'phone' }>;
    const { tokenNumber, pin, titleId, destination } = body;
    if (typeof tokenNumber !== 'string' || typeof pin !== 'string' || typeof titleId !== 'string') {
      return reply.code(400).send({ reason: 'bad_request' });
    }
    if (destination !== 'usb' && destination !== 'phone') return reply.code(400).send({ reason: 'bad_destination' });
    const title = catalog.get(titleId);
    if (!title) return reply.code(404).send({ reason: 'unknown_title' });

    const result = startSession(db, {
      tokenNumber, pin, titleId, kind: title.kind, episodes: title.episodes, destination,
      fileSize: title.fileSize, chunkHashes: title.chunkHashes, fileChecksum: title.fileChecksum, now: now(),
    });
    if (!result.ok) return reply.code(START_STATUS[result.reason] ?? 400).send({ reason: result.reason });
    return sessionInfo(result.sessionId);
  });

  app.get<{ Params: { id: string } }>('/sessions/:id', async (request, reply) => {
    const info = sessionInfo(request.params.id);
    if (!info) return reply.code(404).send({ reason: 'unknown_session' });
    return info;
  });

  app.get<{
    Params: { id: string; index: string };
    Querystring: { exp?: string; sig?: string };
  }>('/sessions/:id/chunks/:index', async (request, reply) => {
    const { id } = request.params;
    const index = Number(request.params.index);
    const query = { exp: request.query.exp ?? '', sig: request.query.sig ?? '' };
    if (!verifyLink({ sessionId: id, chunkIndex: index }, query, secret, now())) {
      return reply.code(403).send({ reason: 'bad_link' });
    }

    const row = getSession(db, id);
    if (!row || row.status !== 'active') return reply.code(409).send({ reason: 'not_active' });
    if (!Number.isInteger(index) || index < 0 || index >= chunkCount(row.expected_size)) {
      return reply.code(404).send({ reason: 'no_such_chunk' });
    }
    const title = catalog.get(row.title_id);
    if (!title) return reply.code(404).send({ reason: 'unknown_title' });

    // Serving the last chunk is the payment point: a fully fetched movie is charged even if the copy never completes.
    if (index === chunkCount(row.expected_size) - 1) {
      const paid = payForLastChunk(db, id, now());
      if (!paid.ok) return reply.code(402).send({ reason: paid.reason });
    }

    const start = index * CHUNK_SIZE;
    const length = Math.min(CHUNK_SIZE, row.expected_size - start);
    const bytes = Buffer.alloc(length);
    const fd = openSync(title.filePath, 'r');
    try {
      readSync(fd, bytes, 0, length, start);
    } finally {
      closeSync(fd);
    }
    return reply.type('application/octet-stream').send(bytes);
  });

  app.post<{ Params: { id: string }; Body: { offset: number } }>('/sessions/:id/confirm', async (request, reply) => {
    try {
      const result = confirmOffset(db, request.params.id, request.body.offset, now());
      if (!result.ok) return reply.code(409).send({ reason: result.reason });
      return { bytesConfirmed: result.bytesConfirmed };
    } catch (err) {
      if (err instanceof RangeError) return reply.code(400).send({ reason: 'bad_offset' });
      throw err;
    }
  });

  app.post<{ Params: { id: string }; Body: { checksum: string } }>('/sessions/:id/complete', async (request, reply) => {
    const checksum = (request.body as { checksum?: unknown } | undefined)?.checksum;
    if (typeof checksum !== 'string') return reply.code(400).send({ reason: 'bad_request' });
    const result = completeSession(db, request.params.id, checksum, now());
    if (!result.ok) return reply.code(COMPLETE_STATUS[result.reason] ?? 400).send({ reason: result.reason });
    return { chargedUgx: result.chargedUgx };
  });

  app.post<{ Params: { id: string } }>('/sessions/:id/abandon', async (request, reply) => {
    const result = abandonSession(db, request.params.id, now());
    if (!result.ok) return reply.code(409).send({ reason: result.reason });
    return { status: 'abandoned' };
  });

  const phoneDir = fileURLToPath(new URL('../../public/phone/', import.meta.url));
  const phonePages: [string[], string, string][] = [
    [['/phone', '/phone/'], 'index.html', 'text/html; charset=utf-8'],
    [['/phone/assemble.js'], 'assemble.js', 'application/javascript; charset=utf-8'],
  ];
  for (const [urls, file, type] of phonePages) {
    for (const url of urls) {
      app.get(url, async (_request, reply) => reply.type(type).send(readFileSync(join(phoneDir, file))));
    }
  }

  return app;
}
