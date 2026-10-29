import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { downloadToUsb, type ServerClient } from '../../src/kiosk/usb-download';
import { expireAbandoned } from '../../src/sessions/session-service';
import { getBalance } from '../../src/tokens/ledger';
import { injectClient, makeWorld, MB } from './harness';

const worlds: { cleanup: () => void }[] = [];
afterEach(() => worlds.splice(0).forEach((w) => w.cleanup()));

const journalOf = (dir: string) => JSON.parse(readFileSync(join(dir, '.flix-journal.json'), 'utf8'));

describe('fault injection', () => {
  it('no double charge when the client is killed after complete but before rename', async () => {
    const world = makeWorld(5000);
    worlds.push(world);
    const client = injectClient(world.app);
    const killed: ServerClient = {
      ...client,
      complete: async (sid, checksum) => {
        await client.complete(sid, checksum);
        throw new Error('killed before rename');
      },
    };
    const args = { usbDir: world.usbDir, tokenNumber: world.tokenNumber, pin: '4821', titleId: 'movie-1', fileName: 'movie.mp4' };

    await expect(downloadToUsb({ client: killed, ...args })).rejects.toThrow('killed before rename');
    expect(getBalance(world.db, world.tokenNumber)).toBe(4000);

    const again = await downloadToUsb({ client, ...args });
    expect(again.ok).toBe(true);
    expect(readFileSync(join(world.usbDir, 'movie.mp4')).equals(world.content)).toBe(true);
    expect(getBalance(world.db, world.tokenNumber)).toBe(4000);
  });

  it('no lost bytes when the process is killed mid-chunk', async () => {
    const world = makeWorld(5000);
    worlds.push(world);
    const client = injectClient(world.app);
    const killed: ServerClient = {
      ...client,
      fetchChunk: async (sid, index, link) => {
        if (index === 2) throw new Error('killed mid-chunk');
        return client.fetchChunk(sid, index, link);
      },
    };
    const args = { usbDir: world.usbDir, tokenNumber: world.tokenNumber, pin: '4821', titleId: 'movie-1', fileName: 'movie.mp4' };

    expect(await downloadToUsb({ client: killed, ...args })).toEqual({ ok: false, reason: 'network_error' });
    const again = await downloadToUsb({ client, ...args });
    expect(again.ok).toBe(true);
    expect(readFileSync(join(world.usbDir, 'movie.mp4')).equals(world.content)).toBe(true);
    expect(getBalance(world.db, world.tokenNumber)).toBe(4000);
  });

  it('no charge for an abandoned session', async () => {
    const world = makeWorld(5000);
    worlds.push(world);
    const client = injectClient(world.app);
    const stopped: ServerClient = {
      ...client,
      fetchChunk: async () => {
        throw new Error('stick removed');
      },
    };
    const args = { usbDir: world.usbDir, tokenNumber: world.tokenNumber, pin: '4821', titleId: 'movie-1', fileName: 'movie.mp4' };
    await downloadToUsb({ client: stopped, ...args });

    expect(expireAbandoned(world.db, new Date(Date.now() + 25 * 60 * 60 * 1000))).toBe(1);
    expect(getBalance(world.db, world.tokenNumber)).toBe(5000);

    const resumed = await downloadToUsb({ client, ...args });
    expect(resumed).toEqual({ ok: false, reason: 'session_not_active' });
    expect(getBalance(world.db, world.tokenNumber)).toBe(5000);
  });

  it('a corrupted chunk is re-fetched and the download still completes', async () => {
    const world = makeWorld(5000);
    worlds.push(world);
    const client = injectClient(world.app);
    let corrupted = false;
    const flaky: ServerClient = {
      ...client,
      fetchChunk: async (sid, index, link) => {
        const bytes = await client.fetchChunk(sid, index, link);
        if (index === 2 && !corrupted) {
          corrupted = true;
          bytes[0] ^= 0xff;
        }
        return bytes;
      },
    };
    const result = await downloadToUsb({
      client: flaky, usbDir: world.usbDir, tokenNumber: world.tokenNumber, pin: '4821', titleId: 'movie-1', fileName: 'movie.mp4',
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(world.usbDir, 'movie.mp4')).equals(world.content)).toBe(true);
    expect(getBalance(world.db, world.tokenNumber)).toBe(4000);
  });
});
