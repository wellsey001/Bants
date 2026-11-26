import { safeFetch } from './safefetch.js';

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,!?;:)\]]/i;

export function firstUrl(text) {
  const m = URL_RE.exec(text || '');
  return m ? m[0] : null;
}

function decode(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function meta(html, names) {
  for (const name of names) {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i');
    const m = re1.exec(html) || re2.exec(html);
    if (m && m[1].trim()) return decode(m[1]);
  }
  return null;
}

/**
 * Looks up a page's title, description and picture.
 * Returns null if there's nothing worth showing.
 */
export async function fetchPreview(url) {
  const page = await safeFetch(url, { maxBytes: 600_000, accept: 'text/html,application/xhtml+xml' });
  if (!/html/i.test(page.contentType)) return null;
  const html = page.body.toString('utf8');
  const title = meta(html, ['og:title', 'twitter:title']) || (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] && decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)[1]));
  if (!title) return null;
  const description = meta(html, ['og:description', 'twitter:description', 'description']);
  const siteName = meta(html, ['og:site_name']) || new URL(page.url).hostname.replace(/^www\./, '');
  let image = null;
  const imageUrl = meta(html, ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']);
  if (imageUrl) {
    try {
      const img = await safeFetch(new URL(imageUrl, page.url).toString(), { maxBytes: 3_000_000, accept: 'image/*' });
      if (/^image\//i.test(img.contentType)) image = { body: img.body, mime: img.contentType.split(';')[0].trim() };
    } catch {
      // No picture is fine.
    }
  }
  return {
    url,
    title: title.slice(0, 200),
    description: description ? description.slice(0, 300) : null,
    siteName: siteName.slice(0, 80),
    image,
  };
}
