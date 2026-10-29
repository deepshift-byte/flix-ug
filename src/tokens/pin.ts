import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 32;
const SALT_BYTES = 16;

export function hashPin(pin: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(pin, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function checkPin(pin: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pin, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
