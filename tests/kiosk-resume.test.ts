import { describe, it, expect } from 'vitest';
import { resumeOffset, chunkAlignedStart } from '../src/kiosk/resume';
import { CHUNK_SIZE } from '../src/download/chunks';

describe('resumeOffset', () => {
  it('trusts the smaller of server and local values', () => {
    expect(resumeOffset(8_000_000, 4_000_000)).toBe(4_000_000);
    expect(resumeOffset(4_000_000, 8_000_000)).toBe(4_000_000);
  });
  it('aligns a resume point down to a chunk boundary', () => {
    expect(chunkAlignedStart(CHUNK_SIZE + 1)).toBe(CHUNK_SIZE);
    expect(chunkAlignedStart(CHUNK_SIZE * 2)).toBe(CHUNK_SIZE * 2);
    expect(chunkAlignedStart(0)).toBe(0);
  });
});
