import { createHmac, timingSafeEqual } from 'node:crypto';

export type LinkTarget = { sessionId: string; chunkIndex: number };
export type LinkQuery = { exp: string; sig: string };

function sign(target: LinkTarget, exp: number, secret: Buffer): string {
  return createHmac('sha256', secret)
    .update(`${target.sessionId}|${target.chunkIndex}|${exp}`)
    .digest('hex');
}

export function signLink(target: LinkTarget & { expiresAt: Date }, secret: Buffer): string {
  const exp = target.expiresAt.getTime();
  const params = new URLSearchParams({ exp: String(exp), sig: sign(target, exp, secret) });
  return params.toString();
}

export function verifyLink(target: LinkTarget, query: LinkQuery, secret: Buffer, now: Date): boolean {
  const exp = Number(query.exp);
  if (!Number.isInteger(exp) || now.getTime() > exp) return false;

  const expected = Buffer.from(sign(target, exp, secret), 'hex');
  const actual = Buffer.from(query.sig, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
