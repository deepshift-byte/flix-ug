import { describe, it, expect } from 'vitest';
import { CHUNK_SIZE, chunkCount, chunkRange } from '../src/download/chunks';

describe('chunk planning', () => {
  it('last_chunk_is_shorter_when_size_not_multiple', () => {
    const size = CHUNK_SIZE * 2 + 100;
    expect(chunkCount(size)).toBe(3);
    expect(chunkRange(size, 2)).toEqual({ start: CHUNK_SIZE * 2, end: CHUNK_SIZE * 2 + 100 });
  });
  it('exact multiple has no short chunk', () => {
    expect(chunkCount(CHUNK_SIZE * 2)).toBe(2);
    expect(chunkRange(CHUNK_SIZE * 2, 1)).toEqual({ start: CHUNK_SIZE, end: CHUNK_SIZE * 2 });
  });
});
