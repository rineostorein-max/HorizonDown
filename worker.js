// HorizonDown worker (Cloudflare Workers) - ONE worker for:
//   ?mode=info&url=<youtube link>          -> JSON { title, thumbnail, height, filename }
//   ?url=<youtube link>&filename=x.mp4     -> streams the YouTube video as a download
//   ?dl=<direct media url>&filename=x.mp4  -> streams any file as a download (instant "Save" on phones)
// Deploy: Cloudflare dashboard -> Workers -> Create -> paste this -> Deploy. Put the address in index.html (WORKER_URL).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Disposition, Content-Range, Accept-Ranges'
};

// YouTube clients that hand out direct, un-ciphered links. YouTube changes these often:
// if one stops working, the next one in the list is tried automatically.
const CLIENTS = [
  { id: 28, ua: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    client: { clientName: 'ANDROID_VR', clientVersion: '1.60.19', deviceMake: 'Oculus', deviceModel: 'Quest 3', osName: 'Android', osVersion: '12L', androidSdkVersion: 32 } },
  { id: 56, ua: 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20250310.01.00' },
    thirdParty: { embedUrl: 'https://www.google.com/' } },
  { id: 5, ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' } },
  { id: 3, ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, osName: 'Android', osVersion: '11' } }
];

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function videoIdOf(link) {
  try {
    const u = new URL(link);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0];
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = /\/(shorts|embed|live|v)\/([\w-]{6,})/.exec(u.pathname);
    return m ? m[2] : '';
  } catch (e) { return ''; }
}

function safeName(name, fallback) {
  const n = String(name || '').replace(/[^\w.\- ]+/g, '').trim().slice(0, 80);
  return n || fallback;
}

async function resolveYouTube(id) {
  let lastErr = 'no client worked';
  for (const c of CLIENTS) {
    try {
      const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'User-Agent': c.ua,
          'X-YouTube-Client-Name': String(c.id), 'X-YouTube-Client-Version': c.client.clientVersion,
          'Origin': 'https://www.youtube.com'
        },
        body: JSON.stringify({
          context: { client: { ...c.client, hl: 'en', gl: 'US' }, ...(c.thirdParty ? { thirdParty: c.thirdParty } : {}) },
          videoId: id, contentCheckOk: true, racyCheckOk: true
        })
      });
      const j = await r.json();
      const st = j.playabilityStatus || {};
      if (st.status !== 'OK') { lastErr = st.reason || st.status || 'unplayable'; continue; }
      // "formats" = video+audio in ONE file (adaptiveFormats are separate and cannot be merged here)
      const list = ((j.streamingData && j.streamingData.formats) || [])
        .filter(f => f.url && /video\/mp4/.test(f.mimeType || ''))
        .sort((a, b) => (b.height || 0) - (a.height || 0));
      if (!list.length) { lastErr = 'no direct stream'; continue; }
      const f = list[0];
      return {
        url: f.url, ua: c.ua, height: f.height || 0, size: +f.contentLength || 0,
        title: (j.videoDetails && j.videoDetails.title) || 'YouTube video',
        thumbnail: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'
      };
    } catch (e) { lastErr = String(e && e.message || e); }
  }
  throw new Error(lastErr);
}

// Streams a file in ~9 MB pieces (YouTube refuses very large single requests)
function chunked(url, size, ua) {
  const CH = 9 * 1024 * 1024;
  let pos = 0;
  return new ReadableStream({
    async pull(ctrl) {
      if (pos >= size) return ctrl.close();
      const end = Math.min(pos + CH, size) - 1;
      const u = new URL(url);
      u.searchParams.set('range', pos + '-' + end);
      const r = await fetch(u.toString(), { headers: { 'User-Agent': ua } });
      if (!r.ok) return ctrl.error(new Error('upstream ' + r.status));
      ctrl.enqueue(new Uint8Array(await r.arrayBuffer()));
      pos = end + 1;
    }
  });
}

const attachment = name =>
  'attachment; filename="' + name.replace(/"/g, '') + '"; filename*=UTF-8\'\'' + encodeURIComponent(name);

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const u = new URL(request.url);
    const mode = u.searchParams.get('mode');
    const dl = u.searchParams.get('dl');
    const link = u.searchParams.get('url');

    // ---------- any direct file: instant download ----------
    if (dl) {
      let t;
      try { t = new URL(dl); } catch (e) { return json({ error: 'bad url' }, 400); }
      const h = t.hostname.toLowerCase();
      if (!/^https?:$/.test(t.protocol) || h === 'localhost' || /^[\d.]+$/.test(h) || h.includes(':') || h.endsWith('.local') || h.endsWith('.internal'))
        return json({ error: 'blocked' }, 400);
      const headers = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' };
      const range = request.headers.get('Range');
      if (range) headers.Range = range;
      const up = await fetch(t.toString(), { headers, redirect: 'follow' });
      if (!up.ok && up.status !== 206) return json({ error: 'upstream ' + up.status }, 502);
      const out = new Headers(CORS);
      ['content-length', 'content-range', 'accept-ranges'].forEach(k => { const v = up.headers.get(k); if (v) out.set(k, v); });
      const ext = (up.headers.get('content-type') || '').includes('image') ? 'jpg' : 'mp4';
      out.set('Content-Type', 'application/octet-stream');
      out.set('Content-Disposition', attachment(safeName(u.searchParams.get('filename'), 'HorizonDown.' + ext)));
      out.set('Cache-Control', 'no-store');
      return new Response(up.body, { status: up.status, headers: out });
    }

    // ---------- YouTube ----------
    if (link) {
      const id = videoIdOf(link);
      if (!id) return json({ error: 'not a youtube link' }, 400);
      let v;
      try { v = await resolveYouTube(id); } catch (e) { return json({ error: String(e.message || e) }, 502); }
      const name = safeName(u.searchParams.get('filename'), 'HorizonDown_' + safeName(v.title, 'YouTube').replace(/\s+/g, '_') + (v.height ? '_' + v.height + 'p' : '') + '.mp4');

      if (mode === 'info') return json({ title: v.title, thumbnail: v.thumbnail, height: v.height, filename: name.endsWith('.mp4') ? name : name + '.mp4' });

      const out = new Headers(CORS);
      out.set('Content-Type', 'application/octet-stream');
      out.set('Content-Disposition', attachment(name.endsWith('.mp4') ? name : name + '.mp4'));
      out.set('Cache-Control', 'no-store');
      if (v.size) {
        out.set('Content-Length', String(v.size));
        return new Response(chunked(v.url, v.size, v.ua), { headers: out });
      }
      const up = await fetch(v.url, { headers: { 'User-Agent': v.ua, Range: 'bytes=0-' } });
      if (!up.ok && up.status !== 206) return json({ error: 'upstream ' + up.status }, 502);
      return new Response(up.body, { headers: out });
    }

    return json({ ok: true, service: 'HorizonDown worker' });
  }
};
