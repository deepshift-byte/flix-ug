import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  Sha256, memoryStore, storeChunk, partCount, partChunkRange, CHUNKS_PER_PART,
  downloadNextChunk, readProgress, partBlob, clearPart, finalChecksumMatches,
} from '../public/phone/assemble.js';

const CHUNK = 16;
const COUNT = CHUNKS_PER_PART + 2; // two parts: 64 chunks, then 2
const content = new Uint8Array(COUNT * CHUNK - 5).map((_, i) => (i * 13 + 1) & 0xff);
const bytesOf = (i: number) => content.slice(i * CHUNK, Math.min((i + 1) * CHUNK, content.length));
const hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const hashes = Array.from({ length: COUNT }, (_, i) => hex(bytesOf(i)));
const fileChecksum = hex(content);
const links = hashes.map((_, i) => ({ exp: '9999999999999', sig: String(i) }));
const chunkKeys = async (store: ReturnType<typeof memoryStore>, sid: string) =>
  (await store.keys(`${sid}:`)).filter((k: string) => /^.*:\d{6}$/.test(k));

function server(fetched: number[] = []) {
  return {
    fetchChunk: async (index: number) => {
      fetched.push(index);
      return bytesOf(index).buffer;
    },
    confirm: async () => {},
  };
}
const opts = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  sessionId, chunkCount: COUNT, fileSize: content.length, chunkSize: CHUNK,
  chunkHashes: hashes, links, ...server(), ...extra,
});

describe('part planning', () => {
  it('splits 66 chunks into a 64-chunk part and a 2-chunk part', () => {
    expect(partCount(COUNT)).toBe(2);
    expect(partChunkRange(COUNT, 0)).toEqual({ start: 0, end: 64 });
    expect(partChunkRange(COUNT, 1)).toEqual({ start: 64, end: 66 });
  });
});

describe('streaming SHA-256 can be saved and restored', () => {
  it('continues a hash from a saved snapshot to the same digest', () => {
    const data = new Uint8Array(1000).map((_, i) => i & 0xff);
    const first = new Sha256().update(data.subarray(0, 333));
    const restored = Sha256.restore(JSON.parse(JSON.stringify(first.snapshot())));
    expect(restored.update(data.subarray(333)).hex()).toBe(hex(data));
  });
});

describe('downloading chunk by chunk', () => {
  it('downloads in order, saving progress after each chunk', async () => {
    const store = memoryStore();
    const fetched: number[] = [];
    const r1 = await downloadNextChunk(store, opts('s1', server(fetched)));
    const r2 = await downloadNextChunk(store, opts('s1', server(fetched)));
    expect(r1).toMatchObject({ ok: true, index: 0, partComplete: false });
    expect(r2).toMatchObject({ ok: true, index: 1 });
    expect(fetched).toEqual([0, 1]);
    expect((await readProgress(store, 's1')).next).toBe(2);
  });

  it('resumes from the saved progress after a restart', async () => {
    const store = memoryStore();
    await downloadNextChunk(store, opts('s1'));
    await downloadNextChunk(store, opts('s1'));
    const fetched: number[] = [];
    await downloadNextChunk(store, opts('s1', server(fetched)));
    expect(fetched).toEqual([2]);
  });

  it('flags the last chunk of each part', async () => {
    const store = memoryStore();
    for (let i = 0; i < CHUNKS_PER_PART - 1; i++) await downloadNextChunk(store, opts('s1'));
    expect(await downloadNextChunk(store, opts('s1'))).toMatchObject({ index: 63, partComplete: true });
  });

  it('refuses a chunk whose hash does not match, stores nothing and does not advance', async () => {
    const store = memoryStore();
    const badHashes = [...hashes];
    badHashes[0] = 'wrong';
    const result = await downloadNextChunk(store, opts('s1', { chunkHashes: badHashes }));
    expect(result).toEqual({ ok: false, reason: 'hash_failed' });
    expect(await chunkKeys(store, 's1')).toEqual([]);
    expect((await readProgress(store, 's1')).next).toBe(0);
  });

  it('reports storage_full and does not advance when the device refuses the write', async () => {
    const store = memoryStore();
    store.put = async () => { throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); };
    expect(await downloadNextChunk(store, opts('s1'))).toEqual({ ok: false, reason: 'storage_full' });
    expect((await readProgress(store, 's1')).next).toBe(0);
  });

  it('a chunk stored before a crash is simply overwritten on retry', async () => {
    const store = memoryStore();
    await downloadNextChunk(store, opts('s1'));
    await storeChunk(store, 's1', 1, bytesOf(1).buffer, hashes[1]); // stored, but progress never saved
    expect(await downloadNextChunk(store, opts('s1'))).toMatchObject({ ok: true, index: 1 });
  });
});

describe('parts and completion', () => {
  async function downloadAll(store: ReturnType<typeof memoryStore>, sid: string) {
    for (;;) {
      const r = await downloadNextChunk(store, opts(sid));
      if (r.awaitingSave) {
        await clearPart(store, sid, r.part, COUNT);
        continue;
      }
      if (!r.ok || r.done) return r;
    }
  }

  it('assembles a finished part, and clearing it removes only that part', async () => {
    const store = memoryStore();
    for (let i = 0; i < CHUNKS_PER_PART; i++) await downloadNextChunk(store, opts('s1'));
    const blob = await partBlob(store, 's1', 0, COUNT);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(content.subarray(0, 64 * CHUNK));
    await clearPart(store, 's1', 0, COUNT);
    expect(await chunkKeys(store, 's1')).toEqual([]);
    expect((await readProgress(store, 's1')).next).toBe(64);
  });

  it('after the last chunk, the running hash matches the file checksum', async () => {
    const store = memoryStore();
    expect(await downloadAll(store, 's1')).toMatchObject({ ok: true, done: true });
    expect(await finalChecksumMatches(store, 's1', fileChecksum, COUNT)).toBe(true);
    expect(await finalChecksumMatches(store, 's1', 'not-it', COUNT)).toBe(false);
  });

  it('the checksum does not match before the last chunk', async () => {
    const store = memoryStore();
    await downloadNextChunk(store, opts('s1'));
    expect(await finalChecksumMatches(store, 's1', fileChecksum, COUNT)).toBe(false);
  });
});

describe('holding at a finished part until it is saved', () => {
  it('stops at the part boundary and fetches nothing until the part is marked saved', async () => {
    const store = memoryStore();
    for (let i = 0; i < CHUNKS_PER_PART; i++) await downloadNextChunk(store, opts('s1'));
    const fetched: number[] = [];
    const held = await downloadNextChunk(store, opts('s1', server(fetched)));
    expect(held).toMatchObject({ ok: true, awaitingSave: true, part: 0, partComplete: true });
    expect(fetched).toEqual([]);
    await clearPart(store, 's1', 0, COUNT);
    expect(await downloadNextChunk(store, opts('s1', server(fetched)))).toMatchObject({ ok: true, index: 64 });
    expect(fetched).toEqual([64]);
  });

  it('after a reload, the finished but unsaved part is offered again rather than skipped', async () => {
    const store = memoryStore();
    for (let i = 0; i < CHUNKS_PER_PART; i++) await downloadNextChunk(store, opts('s1'));
    // The page reloads here: a new call must still hold at part 0.
    expect(await downloadNextChunk(store, opts('s1'))).toMatchObject({ awaitingSave: true, part: 0 });
    expect((await partBlob(store, 's1', 0, COUNT)).size).toBe(64 * CHUNK);
  });
});

describe('hashing without WebCrypto (phone on plain http)', () => {
  it('still verifies and stores chunks when crypto.subtle is unavailable', async () => {
    const subtle = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
    try {
      const store = memoryStore();
      expect(await downloadNextChunk(store, opts('s1'))).toMatchObject({ ok: true, index: 0 });
      const bad = [...hashes]; bad[1] = 'wrong';
      expect(await downloadNextChunk(store, opts('s1', { chunkHashes: bad }))).toEqual({ ok: false, reason: 'hash_failed' });
    } finally {
      if (subtle) Object.defineProperty(globalThis.crypto, 'subtle', subtle);
    }
  });
});
