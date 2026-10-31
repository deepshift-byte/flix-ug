// Phone-side download: the movie is fetched chunk by chunk, saved as parts, and each part is
// offered to the customer to save before the next one downloads. Progress and the running
// SHA-256 are saved to the same store, so a reloaded page continues where it stopped.

const MAX_CHUNK_ATTEMPTS = 3;
// 64 chunks of 4 MiB: 256 MiB per part, which stays within what phone browsers keep stored.
export const CHUNKS_PER_PART = 64;

export class StorageFullError extends Error {
  constructor(cause) {
    super('device storage is full');
    this.name = 'StorageFullError';
    this.cause = cause;
  }
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const keyFor = (sessionId, index) => `${sessionId}:${String(index).padStart(6, '0')}`;
const progressKey = (sessionId) => `${sessionId}:progress`;

export function memoryStore() {
  const map = new Map();
  return {
    async put(key, value) {
      map.set(key, value);
    },
    async get(key) {
      return map.get(key);
    },
    async delete(key) {
      map.delete(key);
    },
    async keys(prefix) {
      return [...map.keys()].filter((k) => k.startsWith(prefix));
    },
    async clear(prefix) {
      for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k);
    },
  };
}

export function indexedDbStore(name = 'flix-phone') {
  const opened = new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('chunks');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function run(mode, action) {
    const db = await opened;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('chunks', mode);
      const req = action(tx.objectStore('chunks'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  return {
    put: (key, value) => run('readwrite', (s) => s.put(value, key)),
    get: (key) => run('readonly', (s) => s.get(key)),
    delete: (key) => run('readwrite', (s) => s.delete(key)),
    keys: async (prefix) => (await run('readonly', (s) => s.getAllKeys())).filter((k) => k.startsWith(prefix)),
    clear: async (prefix) => {
      const keys = (await run('readonly', (s) => s.getAllKeys())).filter((k) => k.startsWith(prefix));
      await Promise.all(keys.map((k) => run('readwrite', (s) => s.delete(k))));
    },
  };
}

export function partCount(chunkCount) {
  return Math.ceil(chunkCount / CHUNKS_PER_PART);
}

export function partChunkRange(chunkCount, part) {
  const start = part * CHUNKS_PER_PART;
  return { start, end: Math.min(start + CHUNKS_PER_PART, chunkCount) };
}

export async function readProgress(store, sessionId) {
  return (await store.get(progressKey(sessionId))) ?? { next: 0, hash: new Sha256().snapshot(), cleared: 0 };
}

// Stores a verified chunk as a Blob, so browsers can keep large chunks on disk.
// Returns true when stored, false on hash mismatch. Throws StorageFullError when the device is full.
export async function storeChunk(store, sessionId, index, bytes, expectedHash) {
  if ((await sha256Hex(bytes)) !== expectedHash) return false;
  try {
    await store.put(keyFor(sessionId, index), new Blob([bytes]));
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') throw new StorageFullError(err);
    throw err;
  }
  return true;
}

// Downloads the next chunk, verifies it, stores it, extends the running hash and saves progress.
// Progress is saved only after the chunk is stored, so a crash in between just refetches that chunk.
export async function downloadNextChunk(store, opts) {
  const { sessionId, chunkCount, fileSize, chunkSize, chunkHashes, links, fetchChunk, confirm } = opts;
  const progress = await readProgress(store, sessionId);
  if (progress.next >= chunkCount) return { ok: true, done: true };

  // Hold at a finished part until the customer has saved it: its chunks are still needed for the save.
  const finishedParts = progress.next / CHUNKS_PER_PART;
  if (progress.next > 0 && Number.isInteger(finishedParts) && progress.cleared < finishedParts) {
    return { ok: true, done: false, awaitingSave: true, part: finishedParts - 1, partComplete: true };
  }

  const index = progress.next;
  let bytes = null;
  let failures = 0;
  while (bytes === null) {
    let fetched;
    try {
      fetched = new Uint8Array(await fetchChunk(index, links[index]));
    } catch {
      return { ok: false, reason: 'network_error' };
    }
    if ((await sha256Hex(fetched)) === chunkHashes[index]) bytes = fetched;
    else if (++failures >= MAX_CHUNK_ATTEMPTS) return { ok: false, reason: 'hash_failed' };
  }

  try {
    await store.put(keyFor(sessionId, index), new Blob([bytes]));
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') return { ok: false, reason: 'storage_full' };
    throw err;
  }

  const next = index + 1;
  const hash = Sha256.restore(progress.hash).update(bytes).snapshot();
  await store.put(progressKey(sessionId), { next, hash, cleared: progress.cleared });
  await confirm(Math.min(next * chunkSize, fileSize));
  return {
    ok: true,
    done: false,
    index,
    part: Math.floor(index / CHUNKS_PER_PART),
    partComplete: next % CHUNKS_PER_PART === 0 || next === chunkCount,
  };
}

// The saved part as one file. Its chunks are Blobs, so this does not copy them into memory.
export async function partBlob(store, sessionId, part, chunkCount) {
  const { start, end } = partChunkRange(chunkCount, part);
  const parts = [];
  for (let i = start; i < end; i++) parts.push(await store.get(keyFor(sessionId, i)));
  return new Blob(parts);
}

// Frees a part's chunks once the customer has saved that part, and records that it was saved.
export async function clearPart(store, sessionId, part, chunkCount) {
  const { start, end } = partChunkRange(chunkCount, part);
  for (let i = start; i < end; i++) await store.delete(keyFor(sessionId, i));
  const progress = await readProgress(store, sessionId);
  await store.put(progressKey(sessionId), { ...progress, cleared: Math.max(progress.cleared, part + 1) });
}

// True only once every chunk has been hashed and the whole movie matches the expected checksum.
export async function finalChecksumMatches(store, sessionId, expectedChecksum, chunkCount) {
  const progress = await readProgress(store, sessionId);
  if (progress.next !== chunkCount) return false;
  return Sha256.restore(progress.hash).hex() === expectedChecksum;
}

// Incremental SHA-256. WebCrypto cannot hash a stream, and a whole movie must not sit in memory at once.
// Constants are derived from the primes (fractional parts of cube and square roots) rather than typed in.
function primesUpTo(count) {
  const found = [];
  for (let n = 2; found.length < count; n++) {
    if (found.every((p) => n % p !== 0)) found.push(n);
  }
  return found;
}
const fractionBits = (x) => Math.floor((x - Math.floor(x)) * 2 ** 32) >>> 0;
const K = primesUpTo(64).map((p) => fractionBits(Math.cbrt(p)));
const H0 = primesUpTo(8).map((p) => fractionBits(Math.sqrt(p)));

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

function compress(h, data, offset) {
  const w = new Array(64);
  for (let i = 0; i < 16; i++) {
    const o = offset + i * 4;
    w[i] = ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0;
  }
  for (let i = 16; i < 64; i++) {
    const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
    const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }
  let [a, b, c, d, e, f, g, hh] = h;
  for (let i = 0; i < 64; i++) {
    const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
    const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) >>> 0;
    hh = g; g = f; f = e; e = (d + t1) >>> 0;
    d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  const out = [a, b, c, d, e, f, g, hh];
  for (let i = 0; i < 8; i++) h[i] = (h[i] + out[i]) >>> 0;
}

export class Sha256 {
  constructor() {
    this.h = [...H0];
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.length = 0;
  }

  update(bytes) {
    this.length += bytes.length;
    let offset = 0;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, bytes.length);
      this.buf.set(bytes.subarray(0, take), this.bufLen);
      this.bufLen += take;
      offset = take;
      if (this.bufLen === 64) {
        compress(this.h, this.buf, 0);
        this.bufLen = 0;
      }
    }
    while (bytes.length - offset >= 64) {
      compress(this.h, bytes, offset);
      offset += 64;
    }
    if (offset < bytes.length) {
      this.buf.set(bytes.subarray(offset));
      this.bufLen = bytes.length - offset;
    }
    return this;
  }

  // Saved state, so a reloaded page can continue hashing where it stopped.
  snapshot() {
    return { h: [...this.h], buf: Array.from(this.buf.subarray(0, this.bufLen)), length: this.length };
  }

  static restore(saved) {
    const hash = new Sha256();
    hash.h = [...saved.h];
    hash.buf.set(saved.buf);
    hash.bufLen = saved.buf.length;
    hash.length = saved.length;
    return hash;
  }

  hex() {
    const padBlocks = this.bufLen < 56 ? 64 : 128;
    const tail = new Uint8Array(padBlocks);
    tail.set(this.buf.subarray(0, this.bufLen));
    tail[this.bufLen] = 0x80;
    const bitLength = this.length * 8;
    const view = new DataView(tail.buffer);
    view.setUint32(padBlocks - 8, Math.floor(bitLength / 2 ** 32));
    view.setUint32(padBlocks - 4, bitLength >>> 0);
    for (let o = 0; o < padBlocks; o += 64) compress(this.h, tail, o);
    return this.h.map((x) => x.toString(16).padStart(8, '0')).join('');
  }
}
