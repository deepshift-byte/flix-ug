import { createReadStream, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
};

export const contentTypeFor = (path: string) => TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

// Sends a file, honouring a single byte range so video players can seek.
export function sendFile(request: FastifyRequest, reply: FastifyReply, path: string) {
  const size = statSync(path).size;
  reply.header('accept-ranges', 'bytes').type(contentTypeFor(path));
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ''));
  if (!range || (range[1] === '' && range[2] === '')) {
    reply.header('content-length', size);
    return reply.send(createReadStream(path));
  }
  let start: number;
  let end: number;
  if (range[1] === '') {
    start = Math.max(0, size - Number(range[2]));
    end = size - 1;
  } else {
    start = Number(range[1]);
    end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
  }
  if (start > end || start >= size) {
    return reply.code(416).header('content-range', `bytes */${size}`).send();
  }
  reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1);
  return reply.send(createReadStream(path, { start, end }));
}

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A poster for titles that have none yet: the name on a colour picked from the title id.
export function generatedPoster(titleId: string, name: string, subtitle: string): string {
  let hash = 0;
  for (const ch of titleId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const words = name.split(/\s+/);
  const lines: string[] = [];
  for (const word of words) {
    const last = lines[lines.length - 1];
    if (last && (last + ' ' + word).length <= 12) lines[lines.length - 1] = last + ' ' + word;
    else lines.push(word);
  }
  const text = lines.slice(0, 4).map((line, i) =>
    `<text x="20" y="${300 + i * 40 - lines.length * 20}" font-size="34" font-weight="800" fill="#fff">${escapeXml(line)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
<title>${escapeXml(name)}</title>
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},65%,38%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},70%,12%)"/>
</linearGradient></defs>
<rect width="300" height="450" fill="url(#g)"/>
<text x="20" y="40" font-size="18" font-weight="900" fill="#e50914" font-family="Arial, sans-serif">FLIX-UG</text>
<g font-family="Arial, sans-serif">${text}</g>
<text x="20" y="420" font-size="16" fill="rgba(255,255,255,.75)" font-family="Arial, sans-serif">${escapeXml(subtitle)}</text>
</svg>`;
}
