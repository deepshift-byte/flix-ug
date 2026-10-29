import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { Sha256 } from '../public/phone/assemble.js';

const nodeHex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('streaming SHA-256 (phone)', () => {
  it('matches node crypto for lengths around the block boundaries', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000]) {
      const data = new Uint8Array(randomBytes(n));
      expect(new Sha256().update(data).hex()).toBe(nodeHex(data));
    }
  });

  it('gives the same digest however the input is split into updates', () => {
    const data = new Uint8Array(randomBytes(10_003));
    const h = new Sha256();
    let offset = 0;
    for (const size of [1, 7, 64, 100, 4096, 5000]) {
      h.update(data.subarray(offset, offset + size));
      offset += size;
    }
    h.update(data.subarray(offset));
    expect(h.hex()).toBe(nodeHex(data));
  });

  it('matches node crypto for a multi-megabyte input fed in 4 MB pieces', () => {
    const data = new Uint8Array(randomBytes(9 * 1024 * 1024 + 123));
    const h = new Sha256();
    for (let s = 0; s < data.length; s += 4 * 1024 * 1024) h.update(data.subarray(s, s + 4 * 1024 * 1024));
    expect(h.hex()).toBe(nodeHex(data));
  });
});
