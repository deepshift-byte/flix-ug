import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app';
import { openDb } from '../../src/db';
import { createToken } from '../../src/tokens/token-service';
import { topUp } from '../../src/tokens/ledger';
import { chunkRange } from '../../src/download/chunks';
import { catalogFromEntries } from '../../src/catalog/title-catalog';
import type { ServerClient, StartResult, CompleteResult, SignedLink } from '../../src/kiosk/usb-download';

export const MB = 1024 * 1024;
export const SECRET = Buffer.from('e2e-secret-32-bytes-long-xxxxxxx');

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function makeContent(size: number): Buffer {
  const content = Buffer.alloc(size);
  for (let i = 0; i < content.length; i++) content[i] = (i * 31 + 7) & 0xff;
  return content;
}

export type World = {
  app: FastifyInstance;
  db: ReturnType<typeof openDb>;
  tokenNumber: string;
  content: Buffer;
  usbDir: string;
  titleIds: string[];
  cleanup: () => void;
};

// A 9 MB file (three chunks) served as several titles, a token funded with `coupon` UGX.
export function makeWorld(coupon: number, titleCount = 1): World {
  mkdirSync(join(process.cwd(), '.superpowers'), { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.superpowers', 'e2e-'));
  const content = makeContent(9 * MB);
  const filePath = join(root, 'movie.mp4');
  writeFileSync(filePath, content);
  const chunkHashes = [0, 1, 2].map((i) => {
    const { start, end } = chunkRange(content.length, i);
    return sha256(content.subarray(start, end));
  });
  const fileChecksum = sha256(content);
  const titleIds = Array.from({ length: titleCount }, (_, i) => `movie-${i + 1}`);
  const catalog = catalogFromEntries(
    titleIds.map((titleId) => ({
      titleId, kind: 'movie' as const, episodes: 1, filePath,
      fileSize: content.length, chunkHashes, fileChecksum,
    })),
  );
  const db = openDb(':memory:');
  const { tokenNumber } = createToken(db, '4821');
  if (coupon > 0) topUp(db, tokenNumber, coupon, 'pay-1');
  const app = buildApp({ db, signingSecret: SECRET, catalog });
  const usbDir = join(root, 'usb');
  mkdirSync(usbDir);
  return { app, db, tokenNumber, content, usbDir, titleIds, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// Adapts the real HTTP app to the kiosk's ServerClient interface.
export function injectClient(app: FastifyInstance): ServerClient {
  return {
    async startSession(input): Promise<StartResult> {
      const res = await app.inject({ method: 'POST', url: '/sessions', payload: { ...input, destination: 'usb' } });
      if (res.statusCode !== 200) return { ok: false, reason: res.json().reason };
      return { ok: true, info: res.json() };
    },
    async fetchChunk(sessionId: string, index: number, link: SignedLink) {
      const res = await app.inject({
        method: 'GET', url: `/sessions/${sessionId}/chunks/${index}?exp=${link.exp}&sig=${link.sig}`,
      });
      if (res.statusCode !== 200) throw new Error(`chunk ${index} returned ${res.statusCode}`);
      return Buffer.from(res.rawPayload);
    },
    async confirm(sessionId: string, offset: number) {
      await app.inject({ method: 'POST', url: `/sessions/${sessionId}/confirm`, payload: { offset } });
    },
    async status(sessionId: string) {
      const res = await app.inject({ method: 'GET', url: `/sessions/${sessionId}` });
      return res.json();
    },
    async complete(sessionId: string, checksum: string): Promise<CompleteResult> {
      const res = await app.inject({ method: 'POST', url: `/sessions/${sessionId}/complete`, payload: { checksum } });
      if (res.statusCode !== 200) return { ok: false, reason: res.json().reason };
      return { ok: true, chargedUgx: res.json().chargedUgx };
    },
    async abandon(sessionId: string) {
      await app.inject({ method: 'POST', url: `/sessions/${sessionId}/abandon` });
    },
  };
}
