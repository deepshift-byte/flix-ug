import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { downloadToUsb, type ServerClient, type StartInfo } from '../src/kiosk/usb-download';
import { CHUNK_SIZE, chunkRange } from '../src/download/chunks';
import { JOURNAL_FILE } from '../src/kiosk/journal';

const MB = 1024 * 1024;
const FILE = 'movie.mp4';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// A 9 MB file: three chunks (4 MB, 4 MB, 1 MB).
const content = Buffer.alloc(9 * MB);
for (let i = 0; i < content.length; i++) content[i] = (i * 31 + 7) & 0xff;
const chunkHashes = Array.from({ length: 3 }, (_, i) => {
  const { start, end } = chunkRange(content.length, i);
  return sha256(content.subarray(start, end));
});
const fileChecksum = sha256(content);

class FakeServer implements ServerClient {
  startCalls = 0;
  fetched: number[] = [];
  confirmed = 0;
  state: 'active' | 'complete' | 'abandoned' = 'active';
  abandoned = false;
  corrupt = new Map<number, number>();
  throwOnNextFetch = false;
  onFetch: ((index: number) => void) | undefined;

  constructor(private sessionId = 'sess-new') {}

  private info(sessionId: string): StartInfo {
    return {
      sessionId,
      fileSize: content.length,
      chunkHashes,
      fileChecksum,
      links: chunkHashes.map((_, i) => ({ exp: '9999999999999', sig: String(i) })),
    };
  }

  async startSession() {
    this.startCalls++;
    return { ok: true as const, info: this.info(this.sessionId) };
  }

  async fetchChunk(_sid: string, index: number) {
    this.fetched.push(index);
    this.onFetch?.(index);
    if (this.throwOnNextFetch) {
      this.throwOnNextFetch = false;
      throw new Error('connection reset');
    }
    const { start, end } = chunkRange(content.length, index);
    const bytes = Buffer.from(content.subarray(start, end));
    const remaining = this.corrupt.get(index) ?? 0;
    if (remaining > 0) {
      this.corrupt.set(index, remaining - 1);
      bytes[0] ^= 0xff;
    }
    return bytes;
  }

  async confirm(_sid: string, offset: number) {
    this.confirmed = offset;
  }

  async status(sid: string) {
    return { ...this.info(sid), status: this.state, bytesConfirmed: this.confirmed };
  }

  async complete(_sid: string, checksum: string) {
    if (checksum !== fileChecksum) return { ok: false as const, reason: 'checksum_mismatch' };
    this.state = 'complete';
    return { ok: true as const, chargedUgx: 1000 };
  }

  async abandon() {
    this.abandoned = true;
    this.state = 'abandoned';
  }
}

let usbDir: string;
beforeEach(() => {
  mkdirSync(join(process.cwd(), '.superpowers'), { recursive: true });
  usbDir = mkdtempSync(join(process.cwd(), '.superpowers', 'kiosk-test-'));
});
afterEach(() => {
  rmSync(usbDir, { recursive: true, force: true });
});

const partPath = () => join(usbDir, `${FILE}.part`);
const finalPath = () => join(usbDir, FILE);
const journalPath = () => join(usbDir, JOURNAL_FILE);

describe('downloadToUsb', () => {
  it('ignores_journal_for_different_session', async () => {
    writeFileSync(journalPath(), JSON.stringify({ sessionId: 'A', titleId: 't1' }));
    writeFileSync(partPath(), Buffer.alloc(4 * MB, 0xee));
    const server = new FakeServer('B');
    const result = await downloadToUsb({
      client: server, usbDir, tokenNumber: 'TOKEN', pin: '4821', titleId: 't1', fileName: FILE, resumeSessionId: 'B',
    });
    expect(result.ok).toBe(true);
    expect(server.startCalls).toBe(1);
    expect(server.fetched[0]).toBe(0);
    expect(readFileSync(finalPath()).equals(content)).toBe(true);
  });

  it('resumes from the confirmed offset after a simulated power loss', async () => {
    writeFileSync(journalPath(), JSON.stringify({ sessionId: 'S', titleId: 't1' }));
    writeFileSync(partPath(), content.subarray(0, 4 * MB));
    const server = new FakeServer('S');
    server.confirmed = 8 * MB;
    const result = await downloadToUsb({
      client: server, usbDir, tokenNumber: 'TOKEN', pin: '4821', titleId: 't1', fileName: FILE, resumeSessionId: 'S',
    });
    expect(result.ok).toBe(true);
    expect(server.startCalls).toBe(0);
    expect(server.fetched).toEqual([1, 2]);
    expect(readFileSync(finalPath()).equals(content)).toBe(true);
  });

  it('writes to .part and renames only after final checksum passes', async () => {
    const server = new FakeServer('S');
    const seen: { finalExisted: boolean; partExisted: boolean }[] = [];
    server.onFetch = (index) => {
      if (index === 2) seen.push({ finalExisted: existsSync(finalPath()), partExisted: existsSync(partPath()) });
    };
    const result = await downloadToUsb({
      client: server, usbDir, tokenNumber: 'TOKEN', pin: '4821', titleId: 't1', fileName: FILE,
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ finalExisted: false, partExisted: true }]);
    expect(existsSync(finalPath())).toBe(true);
    expect(existsSync(partPath())).toBe(false);
    expect(existsSync(journalPath())).toBe(false);
  });

  it('retries a bad chunk up to 3 times then abandons', async () => {
    const server = new FakeServer('S');
    server.corrupt.set(1, 3);
    const result = await downloadToUsb({
      client: server, usbDir, tokenNumber: 'TOKEN', pin: '4821', titleId: 't1', fileName: FILE,
    });
    expect(result).toEqual({ ok: false, reason: 'chunk_failed' });
    expect(server.fetched.filter((i) => i === 1).length).toBe(3);
    expect(server.abandoned).toBe(true);
    expect(existsSync(finalPath())).toBe(false);
  });

  it('a bad chunk that recovers on retry still completes', async () => {
    const server = new FakeServer('S');
    server.corrupt.set(1, 2);
    const result = await downloadToUsb({
      client: server, usbDir, tokenNumber: 'TOKEN', pin: '4821', titleId: 't1', fileName: FILE,
    });
    expect(result.ok).toBe(true);
    expect(server.abandoned).toBe(false);
  });

  it('a dropped connection is not a bad chunk: it returns network_error and does not abandon', async () => {
    const server = new FakeServer('S');
    server.throwOnNextFetch = true;
    const result = await downloadToUsb({
      client: server, usbDir, tokenNumber: 'TOKEN', pin: '4821', titleId: 't1', fileName: FILE,
    });
    expect(result).toEqual({ ok: false, reason: 'network_error' });
    expect(server.abandoned).toBe(false);
  });

  it('finishes a download whose session completed before the power cut, without charging again', async () => {
    writeFileSync(journalPath(), JSON.stringify({ sessionId: 'S', titleId: 't1' }));
    writeFileSync(partPath(), content);
    const server = new FakeServer('S');
    server.state = 'complete';
    server.confirmed = content.length;
    const result = await downloadToUsb({
      client: server, usbDir, tokenNumber: 'TOKEN', pin: '4821', titleId: 't1', fileName: FILE, resumeSessionId: 'S',
    });
    expect(result.ok).toBe(true);
    expect(server.fetched).toEqual([]);
    expect(readFileSync(finalPath()).equals(content)).toBe(true);
    expect(existsSync(journalPath())).toBe(false);
  });
});
