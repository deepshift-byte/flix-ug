import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLanAddress } from '../src/http/lan-only';
import { buildApp } from '../src/http/app';
import { openDb } from '../src/db';
import { createToken } from '../src/tokens/token-service';
import { topUp, getBalance } from '../src/tokens/ledger';
import { CHUNK_SIZE, chunkRange } from '../src/download/chunks';
import { catalogFromEntries } from '../src/catalog/title-catalog';

const MB = 1024 * 1024;
const SECRET = Buffer.from('test-secret-32-bytes-long-xxxxxx');
const NOW = new Date('2026-10-29T10:00:00Z');

describe('isLanAddress', () => {
  it('accepts 10.x, 172.16-31.x, 192.168.x, and loopback', () => {
    for (const ip of ['10.0.0.5', '172.16.1.1', '172.31.9.9', '192.168.1.20', '127.0.0.1']) expect(isLanAddress(ip)).toBe(true);
  });
  it('rejects public addresses and 172.32.x', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '41.210.1.1']) expect(isLanAddress(ip)).toBe(false);
  });
});

let dir: string;
beforeEach(() => {
  mkdirSync(join(process.cwd(), '.superpowers'), { recursive: true });
  dir = mkdtempSync(join(process.cwd(), '.superpowers', 'http-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function setup() {
  const content = Buffer.alloc(9 * MB);
  for (let i = 0; i < content.length; i++) content[i] = (i * 31 + 7) & 0xff;
  const filePath = join(dir, 'movie.mp4');
  writeFileSync(filePath, content);
  const chunkHashes = [0, 1, 2].map((i) => {
    const { start, end } = chunkRange(content.length, i);
    return sha256(content.subarray(start, end));
  });
  const fileChecksum = sha256(content);
  const catalog = catalogFromEntries([
    { titleId: 'movie-1', kind: 'movie', episodes: 1, filePath, fileSize: content.length, chunkHashes, fileChecksum },
  ]);
  const db = openDb(':memory:');
  const { tokenNumber } = createToken(db, '4821');
  topUp(db, tokenNumber, 5000, 'pay-1');
  const app = buildApp({ db, signingSecret: SECRET, catalog, clock: () => NOW });
  return { app, db, tokenNumber, content, fileChecksum };
}

describe('HTTP routes', () => {
  it('rejects a chunk request without a valid signature', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/sessions/abc/chunks/0?exp=1&sig=00' });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a start from a public address', async () => {
    const { app, tokenNumber } = setup();
    const res = await app.inject({
      method: 'POST', url: '/sessions', remoteAddress: '8.8.8.8',
      payload: { tokenNumber, pin: '4821', titleId: 'movie-1', destination: 'usb' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('runs start, chunk fetch, confirm and complete, and charges once', async () => {
    const { app, db, tokenNumber, content, fileChecksum } = setup();

    const start = await app.inject({
      method: 'POST', url: '/sessions',
      payload: { tokenNumber, pin: '4821', titleId: 'movie-1', destination: 'usb' },
    });
    expect(start.statusCode).toBe(200);
    const info = start.json();
    expect(info.links).toHaveLength(3);

    const chunk0 = await app.inject({
      method: 'GET',
      url: `/sessions/${info.sessionId}/chunks/0?exp=${info.links[0].exp}&sig=${info.links[0].sig}`,
    });
    expect(chunk0.statusCode).toBe(200);
    expect(Buffer.from(chunk0.rawPayload).equals(content.subarray(0, CHUNK_SIZE))).toBe(true);

    for (const offset of [CHUNK_SIZE, 2 * CHUNK_SIZE, content.length]) {
      const confirm = await app.inject({ method: 'POST', url: `/sessions/${info.sessionId}/confirm`, payload: { offset } });
      expect(confirm.statusCode).toBe(200);
    }

    const complete = await app.inject({
      method: 'POST', url: `/sessions/${info.sessionId}/complete`, payload: { checksum: fileChecksum },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toEqual({ chargedUgx: 1000 });
    expect(getBalance(db, tokenNumber)).toBe(4000);
  });
});

describe('request validation and the phone page', () => {
  it('returns 400 for a start with no body', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/sessions' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a confirm with a non-numeric offset', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/sessions/abc/confirm', payload: { offset: 'lots' } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a complete with no checksum', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/sessions/abc/complete', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('serves the phone download page from /phone', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/phone' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('FLIX-UG');
  });

  it('serves the phone assembly module', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/phone/assemble.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
  });
});
