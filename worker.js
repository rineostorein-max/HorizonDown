// HorizonDown - YouTube worker (Cloudflare Workers)
// Uses the official VidPickr API (https://vidpickr.com/docs). Requires a VidPickr API key.
//
// Setup:
//   1. wrangler secret put VIDPICKR_API_KEY      (key looks like vpk_live_...)
//   2. (optional) set ALLOWED_ORIGIN in wrangler.toml [vars], e.g. "https://yoursite.com". Default: "*"
//   3. wrangler deploy
//
// Usage:
//   GET /?url=<youtube link>&mode=info      -> JSON { title, thumbnail, height, filename, sizeMB }
//   GET /?url=<youtube link>                -> streams the MP4 as an attachment (saves, never plays)
//   optional: &quality=1080 (max height, default 1080)
//
// NOTE: VidPickr serves 1080p as separate video + audio tracks that must be muxed locally
// (their SDKs do this). A Worker cannot mux, so this picks the best *progressive* format
// (video and audio already in ONE file) up to the requested height. That is often 720p or 360p
// for YouTube. See the "ASSUMPTIONS" below - verify them against vidpickr.com/docs.

const BASE = 'https://api.vidpickr.com/v1';

// ASSUMPTIONS (check the VidPickr docs and adjust if needed):
const authHeaders = env => ({ Authorization: 'Bearer ' + env.VIDPICKR_API_KEY });
const infoUrl = link => BASE + '/info?url=' + encodeURIComponent(link);
const streamUrl = token => BASE + '/stream?token=' + encodeURIComponent(token);

const YT_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'];

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length',
    'Vary': 'Origin'
  };
}

function json(env, obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(env) }
  });
}

function isYouTube(link) {
  try {
    const u = new URL(link);
    return /^https?:$/.test(u.protocol) && YT_HOSTS.includes(u.hostname.toLowerCase());
  } catch (e) { return false; }
}

// best progressive (video+audio in one file) resolution up to maxHeight
function pickFormat(info, maxHeight) {
  const list = (info.resolutions || [])
    .filter(r => r && r.is_progressive && r.download_token && (r.height || 0) <= maxHeight)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  return list[0] || null;
}

function safeName(name, height) {
  const base = String(name || 'YouTube').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'YouTube';
  return 'HorizonDown_' + base.replace(/\s+/g, '_') + '_' + height + 'p.mp4';
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    if (request.method !== 'GET') return json(env, { error: 'method_not_allowed' }, 405);
    if (!env.VIDPICKR_API_KEY) return json(env, { error: 'VIDPICKR_API_KEY is not set' }, 500);

    const q = new URL(request.url).searchParams;
    const link = (q.get('url') || '').trim();
    const mode = q.get('mode') === 'info' ? 'info' : 'download';
    const maxHeight = parseInt(q.get('quality'), 10) || 1080;

    if (!isYouTube(link)) return json(env, { error: 'Only YouTube links are supported' }, 400);

    try {
      // 1) resolve formats
      const infoRes = await fetch(infoUrl(link), { headers: { Accept: 'application/json', ...authHeaders(env) } });
      if (!infoRes.ok) return json(env, { error: 'vidpickr_info_failed', status: infoRes.status }, 502);
      const info = await infoRes.json();

      const fmt = pickFormat(info, maxHeight);
      if (!fmt) return json(env, { error: 'no_merged_format', message: 'No single-file video+audio format available.' }, 422);

      const filename = safeName(info.title, fmt.height);

      if (mode === 'info') {
        return json(env, {
          title: info.title || 'YouTube video',
          thumbnail: info.thumbnail || '',
          height: fmt.height,
          sizeMB: fmt.size_mb || null,
          filename
        });
      }

      // 2) stream the file with Content-Disposition: attachment so the browser saves it
      const up = await fetch(streamUrl(fmt.download_token), { headers: authHeaders(env) });
      if (!up.ok || !up.body) return json(env, { error: 'vidpickr_stream_failed', status: up.status }, 502);

      const headers = new Headers(cors(env));
      headers.set('Content-Type', 'video/mp4');
      headers.set('Content-Disposition', 'attachment; filename="' + filename + '"; filename*=UTF-8\'\'' + encodeURIComponent(filename));
      headers.set('Cache-Control', 'no-store');
      const len = up.headers.get('Content-Length');
      if (len) headers.set('Content-Length', len);
      return new Response(up.body, { status: 200, headers });
    } catch (e) {
      return json(env, { error: 'worker_error' }, 500);
    }
  }
};
