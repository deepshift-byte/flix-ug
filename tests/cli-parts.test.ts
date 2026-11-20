import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../src/http/app';
import { openDb } from '../src/db';
import { createToken } from '../src/tokens/token-service';
import { topUp, getBalance } from '../src/tokens/ledger';
import { catalogFromEntries } from '../src/catalog/title-catalog';
import { describeMovieFile } from '../src/catalog/describe-file';
import { httpServerClient } from '../src/kiosk/http-client';
import { downloadToUsb } from '../src/kiosk/usb-download';
import { CHUNK_SIZE } from '../src/download/chunks';

const MB = 1024 * 1024;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const dirs: string[] = [];
const tempDir = () => {
  mkdirSync(join(process.cwd(), '.superpowers'), { recursive: true });
  const d = mkdtempSync(join(process.cwd(), '.superpowers', 'cli-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function movieFile(dir: string, size: number) {
  const content = Buffer.alloc(size);
  for (let i = 0; i < size; i++) content[i] = (i * 31 + 7) & 0xff;
  const path = join(dir, 'movie.mp4');
  writeFileSync(path, content);
  return { path, content };
}

describe('describeMovieFile', () => {
  it('computes the size, per-chunk hashes and whole-file checksum the server needs', async () => {
    const dir = tempDir();
    const { path, content } = movieFile(dir, 2 * CHUNK_SIZE + 123);
    const entry = await describeMovieFile(path, { titleId: 'm1', kind: 'movie', episodes: 1 });
    expect(entry.fileSize).toBe(content.length);
    expect(entry.chunkHashes).toEqual([
      sha(content.subarray(0, CHUNK_SIZE)),
      sha(content.subarray(CHUNK_SIZE, 2 * CHUNK_SIZE)),
      sha(content.subarray(2 * CHUNK_SIZE)),
    ]);
    expect(entry.fileChecksum).toBe(sha(content));
    expect(entry).toMatchObject({ titleId: 'm1', kind: 'movie', episodes: 1, filePath: path });
  });
});

describe('kiosk over real HTTP', () => {
  it('copies a movie to a folder through a listening server, and charges once', async () => {
    const dir = tempDir();
    const { path, content } = movieFile(dir, 9 * MB + 5);
    const entry = await describeMovieFile(path, { titleId: 'movie-1', kind: 'movie', episodes: 1 });
    const db = openDb(':memory:');
    const { tokenNumber } = createToken(db, '4821');
    topUp(db, tokenNumber, 5000, 'pay-1');
    const app = buildApp({ db, signingSecret: Buffer.from('cli-test-secret-0123456789abcdef'), catalog: catalogFromEntries([entry]) });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const usb = join(dir, 'usb');
      mkdirSync(usb);
      const result = await downloadToUsb({
        client: httpServerClient(address), usbDir: usb, tokenNumber, pin: '4821', titleId: 'movie-1', fileName: 'movie-1.mp4',
      });
      expect(result).toEqual({ ok: true, path: join(usb, 'movie-1.mp4') });
      expect(readFileSync(join(usb, 'movie-1.mp4')).equals(content)).toBe(true);
      expect(getBalance(db, tokenNumber)).toBe(4000);
    } finally {
      await app.close();
    }
  });

  it('reports a wrong PIN from the server as a refusal, without writing anything', async () => {
    const dir = tempDir();
    const { path } = movieFile(dir, MB);
    const entry = await describeMovieFile(path, { titleId: 'movie-1', kind: 'movie', episodes: 1 });
    const db = openDb(':memory:');
    const { tokenNumber } = createToken(db, '4821');
    topUp(db, tokenNumber, 5000, 'pay-1');
    const app = buildApp({ db, signingSecret: Buffer.from('cli-test-secret-0123456789abcdef'), catalog: catalogFromEntries([entry]) });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const usb = join(dir, 'usb');
      mkdirSync(usb);
      const result = await downloadToUsb({
        client: httpServerClient(address), usbDir: usb, tokenNumber, pin: '0000', titleId: 'movie-1', fileName: 'movie-1.mp4',
      });
      expect(result).toEqual({ ok: false, reason: 'bad_pin' });
    } finally {
      await app.close();
    }
  });
});
