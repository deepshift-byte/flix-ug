import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { storeChunk, assemble, memoryStore, missingChunks, downloadChunks } from '../public/phone/assemble.js';

const CHUNK = 16;
const content = new Uint8Array(CHUNK * 3 + 5).map((_, i) => (i * 13 + 1) & 0xff);
const chunkBytes = (i: number) => content.slice(i * CHUNK, Math.min((i + 1) * CHUNK, content.length));
const sha256Hex = async (buf: ArrayBuffer | Uint8Array) =>
  createHash('sha256').update(Buffer.from(buf as ArrayBuffer)).digest('hex');
const chunkCount = Math.ceil(content.length / CHUNK);
const hashes = await Promise.all(Array.from({ length: chunkCount }, (_, i) => sha256Hex(chunkBytes(i))));
const fileChecksum = await sha256Hex(content);
const links = hashes.map((_, i) => ({ exp: '9999999999999', sig: String(i) }));

describe('phone assembly', () => {
  it('storage_quota_error_does_not_report_complete', async () => {
    const quotaStore = memoryStore();
    quotaStore.put = async () => {
      throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    };
    const result = await downloadChunks(quotaStore, {
      sessionId: 's1',
      chunkCount,
      fileSize: content.length,
      chunkSize: CHUNK,
      chunkHashes: hashes,
      links,
      fetchChunk: async (i) => chunkBytes(i).buffer,
      confirm: async () => {},
    });
    expect(result).toEqual({ ok: false, reason: 'storage_full' });
    expect(await assemble(quotaStore, 's1', chunkCount, fileChecksum)).toMatchObject({ ok: false, reason: 'missing_chunks' });
  });

  it('rejects a chunk whose hash does not match and stores nothing', async () => {
    const store = memoryStore();
    const stored = await storeChunk(store, 's1', 0, chunkBytes(0).buffer, 'not-the-hash');
    expect(stored).toBe(false);
    expect(await store.keys('s1:')).toEqual([]);
  });

  it('resumes by skipping chunks already stored', async () => {
    const store = memoryStore();
    await storeChunk(store, 's1', 0, chunkBytes(0).buffer, hashes[0]);
    await storeChunk(store, 's1', 1, chunkBytes(1).buffer, hashes[1]);
    expect(await missingChunks(store, 's1', chunkCount)).toEqual([2, 3]);

    const fetched: number[] = [];
    const result = await downloadChunks(store, {
      sessionId: 's1',
      chunkCount,
      fileSize: content.length,
      chunkSize: CHUNK,
      chunkHashes: hashes,
      links,
      fetchChunk: async (i) => {
        fetched.push(i);
        return chunkBytes(i).buffer;
      },
      confirm: async () => {},
    });
    expect(result).toEqual({ ok: true });
    expect(fetched).toEqual([2, 3]);
    const assembled = await assemble(store, 's1', chunkCount, fileChecksum);
    expect(assembled.ok).toBe(true);
    expect(new Uint8Array(await assembled.blob.arrayBuffer())).toEqual(content);
  });
});

describe('clearing a finished session', () => {
  it('removes that session\'s chunks and keeps other sessions', async () => {
    const store = memoryStore();
    await storeChunk(store, 's1', 0, chunkBytes(0).buffer, hashes[0]);
    await storeChunk(store, 's2', 0, chunkBytes(0).buffer, hashes[0]);
    await store.clear('s1:');
    expect(await store.keys('s1:')).toEqual([]);
    expect(await store.keys('s2:')).toEqual(['s2:000000']);
  });
});

describe('confirmation after a finished download', () => {
  it('re-confirms the full size even when every chunk was already stored, so a lost confirm is recoverable', async () => {
    const store = memoryStore();
    for (let i = 0; i < chunkCount; i++) await storeChunk(store, 's1', i, chunkBytes(i).buffer, hashes[i]);
    const offsets: number[] = [];
    const result = await downloadChunks(store, {
      sessionId: 's1',
      chunkCount,
      fileSize: content.length,
      chunkSize: CHUNK,
      chunkHashes: hashes,
      links,
      fetchChunk: async () => {
        throw new Error('nothing should be fetched');
      },
      confirm: async (offset) => {
        offsets.push(offset);
      },
    });
    expect(result).toEqual({ ok: true });
    expect(offsets).toEqual([content.length]);
  });
});
