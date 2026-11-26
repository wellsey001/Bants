// Fetches public web pages for link previews and GIFs, refusing anything on the
// home network so nobody can use the server to poke at your LAN.
import dns from 'node:dns/promises';
import net from 'node:net';

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivate(mapped[1]) : false;
}

export async function assertPublic(url) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error('private address');
  return u;
}

/** Returns { url, contentType, body: Buffer } or throws. Follows up to 3 redirects. */
export async function safeFetch(url, { maxBytes = 1_000_000, timeoutMs = 6000, accept = '*/*' } = {}, redirects = 3) {
  const u = await assertPublic(url);
  const res = await fetch(u, {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; BantsBot/1.0; +link previews)',
      accept,
      'accept-language': 'en-GB,en;q=0.8',
    },
  });
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    if (redirects <= 0) throw new Error('too many redirects');
    return safeFetch(new URL(res.headers.get('location'), u).toString(), { maxBytes, timeoutMs, accept }, redirects - 1);
  }
  if (!res.ok) throw new Error(`status ${res.status}`);
  const chunks = [];
  let size = 0;
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      if (accept.startsWith('text/html')) break; // a partial page is fine for previews
      throw new Error('too big');
    }
    chunks.push(value);
  }
  return { url: u.toString(), contentType: res.headers.get('content-type') || '', body: Buffer.concat(chunks) };
}

export { isPrivate };
