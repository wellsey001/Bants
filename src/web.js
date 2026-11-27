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
  res.writeHead(200, {
    'content-type': TYPES[ext] || 'application/octet-stream',
    'content-length': stat.size,
    // Pages and code are checked for changes every load; pictures, sounds and fonts can be kept a day.
    'cache-control': isPage || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=86400',
    'x-content-type-options': 'nosniff',
    ...(ext === '.html' ? { 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin', 'permissions-policy': 'camera=(self), microphone=(self), display-capture=(self)' } : {}),
  });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
  return true;
}
