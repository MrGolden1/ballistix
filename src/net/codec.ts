/**
 * Turns a WebRTC session description into a short-ish text code that people can paste into a chat,
 * and back. The SDP is deflated and base64url-encoded; a prefix guards against pasting random text.
 */

const PREFIX = 'BX1';

export interface Signal {
  type: 'offer' | 'answer';
  sdp: string;
}

function toB64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(data: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const res = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export async function encodeSignal(sig: Signal): Promise<string> {
  // Candidate lines for IPv6 link-local and TCP are rarely useful and make the code longer.
  const sdp = sig.sdp
    .split('\r\n')
    .filter((l) => !(l.startsWith('a=candidate') && / tcp /i.test(l)))
    .join('\r\n');
  const packed = await pipe(new TextEncoder().encode(`${sig.type[0]}${sdp}`), new CompressionStream('deflate-raw'));
  return `${PREFIX}.${toB64Url(packed)}`;
}

export async function decodeSignal(code: string, expect: Signal['type']): Promise<Signal> {
  const clean = code.replace(/\s+/g, '');
  if (!clean.startsWith(`${PREFIX}.`)) throw new Error('That is not a Ballistix code.');
  let text: string;
  try {
    text = new TextDecoder().decode(await pipe(fromB64Url(clean.slice(PREFIX.length + 1)), new DecompressionStream('deflate-raw')));
  } catch {
    throw new Error('The code is incomplete or damaged. Copy the whole code and try again.');
  }
  const type = text[0] === 'o' ? 'offer' : 'answer';
  if (type !== expect) throw new Error(expect === 'offer' ? 'This is a reply code. Paste it on the host computer instead.' : 'This is an invite code. Paste it on the joining computer instead.');
  return { type, sdp: text.slice(1) };
}
