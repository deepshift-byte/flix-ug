import type { CompleteResult, ServerClient, SignedLink, StartInfo, StartResult } from './usb-download.js';

// The kiosk's connection to the shop server over the LAN.
export function httpServerClient(baseUrl: string): ServerClient {
  const base = baseUrl.replace(/\/+$/, '');
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = async (res: Response) => (await res.json().catch(() => ({}))) as Record<string, unknown>;

  return {
    async startSession(input): Promise<StartResult> {
      const res = await post('/sessions', { ...input, destination: 'usb' });
      const body = await json(res);
      return res.ok ? { ok: true, info: body as unknown as StartInfo } : { ok: false, reason: String(body.reason ?? res.status) };
    },
    async fetchChunk(sessionId: string, index: number, link: SignedLink) {
      const res = await fetch(`${base}/sessions/${sessionId}/chunks/${index}?exp=${link.exp}&sig=${link.sig}`);
      if (!res.ok) throw new Error(`chunk ${index} returned ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async confirm(sessionId: string, offset: number) {
      const res = await post(`/sessions/${sessionId}/confirm`, { offset });
      if (!res.ok) throw new Error(`confirm returned ${res.status}`);
    },
    async status(sessionId: string) {
      const res = await fetch(`${base}/sessions/${sessionId}`);
      return (await json(res)) as unknown as StartInfo & { status: string; bytesConfirmed: number };
    },
    async complete(sessionId: string, checksum: string): Promise<CompleteResult> {
      const res = await post(`/sessions/${sessionId}/complete`, { checksum });
      const body = await json(res);
      return res.ok ? { ok: true, chargedUgx: Number(body.chargedUgx) } : { ok: false, reason: String(body.reason ?? res.status) };
    },
    async abandon(sessionId: string) {
      await post(`/sessions/${sessionId}/abandon`, {});
    },
  };
}
