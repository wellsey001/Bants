// The web version of Bants: the Windows app's screens, served straight from this server,
// so friends can use Bants in a browser (including iPhones, via Add to Home Screen).
// The files are copied into WEB_DIR when the Docker image is built (see .github/workflows/docker.yml).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.env.WEB_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web'));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.gif': 'image/gif',
  '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.wasm': 'application/wasm', '.tflite': 'application/octet-stream',
};

// Each server build gets its own version tag on the page's scripts and styles, so browsers and
// Cloudflare can't keep serving yesterday's code after an update.
// (The start time is in it too: the web files can change without the server's code changing.)
const VERSION = `${(process.env.BANTS_BUILD || 'dev').slice(0, 7)}-${Date.now().toString(36)}`;
let pageCache = null;
function page(file) {
  const stat = fs.statSync(file);
  if (pageCache?.mtime === stat.mtimeMs && pageCache.file === file) return pageCache.body;
  const html = fs.readFileSync(file, 'utf8')
    .replace(/(<script[^>]+src="(?!https?:)[^"?]+\.js)"/g, `$1?v=${VERSION}"`)
    .replace(/(<link[^>]+href="(?!https?:)[^"?]+\.(?:css|webmanifest))"/g, `$1?v=${VERSION}"`);
  pageCache = { file, mtime: stat.mtimeMs, body: Buffer.from(html) };
  return pageCache.body;
}

export const webAvailable = () => fs.existsSync(path.join(root, 'index.html'));

/** Serves a web file for a GET that no API route took. Returns false if there's nothing to serve. */
export function serveWeb(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (pathname.startsWith('/api/') || pathname === '/ws' || pathname === '/admin') return false;

  // Invite links (bants.example.com/invite/CODE) open the web app's Join a server box.
  const inv = /^\/invite\/([A-Za-z0-9_-]{1,64})\/?$/.exec(pathname);
  if (inv) {
    if (!webAvailable()) return false;
    res.writeHead(302, { location: `/?invite=${encodeURIComponent(inv[1])}` });
    res.end();
    return true;
  }

  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return false; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.resolve(root, '.' + rel);
  if (file !== root && !file.startsWith(root + path.sep)) return false; // no climbing out with ../
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;

  const ext = path.extname(file).toLowerCase();
  const isPage = ext === '.html' || path.basename(file) === 'sw.js' || ext === '.webmanifest';
  const body = ext === '.html' ? page(file) : null;
  // The page is never kept (by the browser or by Cloudflare); it names this build's scripts,
  // which carry a version tag and so can be kept. Pictures, sounds and fonts can be kept a day.
  const versioned = /[?&]v=/.test(req.url);
  const cache = isPage ? 'no-store' : versioned ? 'public, max-age=31536000, immutable' : ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=86400';
  res.writeHead(200, {
    'content-type': TYPES[ext] || 'application/octet-stream',
    'content-length': body ? body.length : stat.size,
    'cache-control': cache,
    ...(isPage ? { 'cdn-cache-control': 'no-store', 'cloudflare-cdn-cache-control': 'no-store' } : {}),
    'x-content-type-options': 'nosniff',
    ...(ext === '.html' ? { 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin', 'permissions-policy': 'camera=(self), microphone=(self), display-capture=(self)' } : {}),
  });
  if (req.method === 'HEAD') res.end();
  else if (body) res.end(body);
  else fs.createReadStream(file).pipe(res);
  return true;
}
