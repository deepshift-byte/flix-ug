import { describe, it, expect } from 'vitest';
import { signLink, verifyLink } from '../src/download/signed-link';

const secret = Buffer.from('test-secret-32-bytes-long-xxxxxx');
const p = { sessionId: 's1', chunkIndex: 3 };
const exp = new Date('2026-10-29T10:10:00Z');

describe('signed chunk links', () => {
  it('verifies a valid link before expiry', () => {
    const q = Object.fromEntries(new URLSearchParams(signLink({ ...p, expiresAt: exp }, secret)));
    expect(verifyLink(p, q as any, secret, new Date('2026-10-29T10:05:00Z'))).toBe(true);
  });
  it('rejects after expiry', () => {
    const q = Object.fromEntries(new URLSearchParams(signLink({ ...p, expiresAt: exp }, secret)));
    expect(verifyLink(p, q as any, secret, new Date('2026-10-29T10:11:00Z'))).toBe(false);
  });
  it('rejects a link for a different chunk', () => {
    const q = Object.fromEntries(new URLSearchParams(signLink({ ...p, expiresAt: exp }, secret)));
    expect(verifyLink({ ...p, chunkIndex: 4 }, q as any, secret, new Date('2026-10-29T10:05:00Z'))).toBe(false);
  });
});
