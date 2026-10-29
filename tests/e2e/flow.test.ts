import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { downloadToUsb, type ServerClient } from '../../src/kiosk/usb-download';
import { getBalance } from '../../src/tokens/ledger';
import { injectClient, makeWorld, MB } from './harness';

const worlds: { cleanup: () => void }[] = [];
afterEach(() => worlds.splice(0).forEach((w) => w.cleanup()));

describe('full flow', () => {
  it('start, interrupt, resume, complete charges 1000 for a movie', async () => {
    const world = makeWorld(5000);
    worlds.push(world);
    const client = injectClient(world.app);
    let failed = false;
    const interrupting: ServerClient = {
      ...client,
      fetchChunk: async (sid, index, link) => {
        if (index === 1 && !failed) {
          failed = true;
          throw new Error('cable pulled');
        }
        return client.fetchChunk(sid, index, link);
      },
    };
    const args = { usbDir: world.usbDir, tokenNumber: world.tokenNumber, pin: '4821', titleId: 'movie-1', fileName: 'movie.mp4' };

    const first = await downloadToUsb({ client: interrupting, ...args });
    expect(first).toEqual({ ok: false, reason: 'network_error' });
    expect(getBalance(world.db, world.tokenNumber)).toBe(5000);

    const journal = JSON.parse(readFileSync(join(world.usbDir, '.flix-journal.json'), 'utf8'));
    const second = await downloadToUsb({ client, ...args, resumeSessionId: journal.sessionId });
    expect(second.ok).toBe(true);
    expect(readFileSync(join(world.usbDir, 'movie.mp4')).equals(world.content)).toBe(true);
    expect(getBalance(world.db, world.tokenNumber)).toBe(4000);
  });

  it('a 5000 coupon completes exactly five 1000 movies and refuses the sixth', async () => {
    const world = makeWorld(5000, 6);
    worlds.push(world);
    const client = injectClient(world.app);
    const results = [];
    for (const titleId of world.titleIds) {
      results.push(await downloadToUsb({
        client, usbDir: world.usbDir, tokenNumber: world.tokenNumber, pin: '4821', titleId, fileName: `${titleId}.mp4`,
      }));
    }
    expect(results.slice(0, 5).every((r) => r.ok)).toBe(true);
    expect(results[5]).toEqual({ ok: false, reason: 'insufficient_balance' });
    expect(getBalance(world.db, world.tokenNumber)).toBe(0);
    expect(existsSync(join(world.usbDir, 'movie-6.mp4.part'))).toBe(false);
  });
});
