import { config } from './config.js';
import { safeFetch } from './safefetch.js';

export const gifsEnabled = () => !!config.giphyKey;

function item(g) {
  const preview = g.images?.fixed_width_downsampled || g.images?.fixed_width || g.images?.preview_gif;
  const full = g.images?.downsized_medium || g.images?.downsized || g.images?.original;
  return {
    id: g.id,
    title: g.title || '',
    preview: preview?.url,
    width: Number(preview?.width) || 200,
    height: Number(preview?.height) || 200,
    url: full?.url,
  };
}

/** Trending when q is empty, otherwise a search. */
export async function findGifs(q, offset = 0) {
  const params = new URLSearchParams({
    api_key: config.giphyKey,
    limit: '24',
    offset: String(Math.max(0, Math.min(Number(offset) || 0, 4900))),
    rating: config.gifRating,
    bundle: 'messaging_non_clips',
  });
  const endpoint = q ? 'search' : 'trending';
  if (q) params.set('q', q.slice(0, 50));
  const res = await fetch(`https://api.giphy.com/v1/gifs/${endpoint}?${params}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Giphy said ${res.status}`);
  const json = await res.json();
  return {
    gifs: (json.data || []).map(item).filter((g) => g.preview && g.url),
    nextOffset: (json.pagination?.offset ?? 0) + (json.pagination?.count ?? 0),
  };
}

/** Downloads a GIF from Giphy's CDN only. */
export async function downloadGif(url) {
  const host = new URL(url).hostname;
  if (!/(^|\.)giphy\.com$/i.test(host)) throw new Error('Only Giphy GIFs');
  const file = await safeFetch(url, { maxBytes: 10_000_000, accept: 'image/gif,image/*' });
  if (!/^image\//i.test(file.contentType)) throw new Error('Not an image');
  return { body: file.body, mime: file.contentType.split(';')[0].trim() };
}
