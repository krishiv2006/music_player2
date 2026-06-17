import express from 'express';
import cors from 'cors';
import ytSearch from 'yt-search';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:4173',
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);
    if (origin.endsWith('.vercel.app')) return cb(null, true);
    cb(null, true);
  },
  credentials: true,
}));
app.use(express.json());

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

function transformTrack(item: any) {
  const raw = item.artworkUrl100 || item.artworkUrl60 || '';
  const cover = raw
    .replace('100x100bb', '400x400bb')
    .replace('100x100', '400x400')
    .replace('60x60bb', '400x400bb');

  const title = item.trackName || item.collectionName || 'Unknown Track';
  const artist = item.artistName || 'Unknown Artist';

  return {
    id: String(item.trackId || item.collectionId || Math.random()),
    title,
    artist,
    cover: cover || `https://picsum.photos/seed/${item.trackId}/400/400`,
    duration: item.trackTimeMillis ? formatDuration(item.trackTimeMillis) : '0:00',
    album: item.collectionName || '',
    preview: item.previewUrl || '',
    genre: item.primaryGenreName || '',
  };
}

async function itunesFetch(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'SonicImmersive/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Piped API instances — fallback list if one is down
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://piped-api.garudalinux.org',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.coldforge.xyz',
];

const audioCache = new Map<string, { url: string; contentType: string; expires: number }>();

async function resolveAudioUrl(q: string, expectedSecs: number): Promise<{ url: string; contentType: string } | null> {
  const cacheKey = `${q}_${expectedSecs}`;
  const cached = audioCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    console.log(`[resolveAudioUrl] cache hit for "${q}"`);
    return { url: cached.url, contentType: cached.contentType };
  }

  // Step 1: Find the best YouTube video ID via yt-search
  const cleanQ = q.replace(/\s*\(.*\)/g, '').replace(/\s*-.*$/g, '').trim();
  const searchPromises = [
    ytSearch(cleanQ + ' full official audio'),
    ytSearch(cleanQ + ' audio'),
  ];
  const searchAttempts = await Promise.allSettled(searchPromises);
  let allVideos: any[] = [];
  for (const result of searchAttempts) {
    if (result.status === 'fulfilled' && result.value?.videos?.length) {
      allVideos.push(...result.value.videos);
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  allVideos = allVideos.filter(v => {
    if (seen.has(v.videoId)) return false;
    seen.add(v.videoId);
    return true;
  });

  if (allVideos.length === 0) {
    console.error(`[resolveAudioUrl] no videos found for "${q}"`);
    return null;
  }

  // Pick the best matching video by duration
  let bestVideo = null;
  if (expectedSecs > 0) {
    bestVideo = allVideos.find(v => Math.abs(v.seconds - expectedSecs) < 60);
    if (!bestVideo) bestVideo = allVideos.find(v => v.seconds > 60 && v.seconds > expectedSecs - 120);
  }
  if (!bestVideo) bestVideo = allVideos.find(v => v.seconds > 60) || allVideos[0];

  const videoId = bestVideo.videoId;
  console.log(`[resolveAudioUrl] best video for "${q}" → ${videoId} (${bestVideo.timestamp})`);

  // Step 2: Get audio stream URL from Piped API
  let audioUrl: string | null = null;
  let contentType = 'audio/webm';

  for (const instance of PIPED_INSTANCES) {
    try {
      console.log(`[resolveAudioUrl] trying Piped instance: ${instance}`);
      const res = await fetch(`${instance}/streams/${videoId}`, {
        headers: { 'User-Agent': 'SonicImmersive/1.0' },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        console.warn(`[resolveAudioUrl] ${instance} returned ${res.status}`);
        continue;
      }

      const data = await res.json();

      // Pick the best audio stream (highest quality, audio-only)
      const audioStreams: any[] = data.audioStreams || [];
      if (audioStreams.length === 0) {
        console.warn(`[resolveAudioUrl] no audio streams from ${instance}`);
        continue;
      }

      // Sort by bitrate descending, prefer m4a/mp4 over webm
      const sorted = audioStreams.sort((a: any, b: any) => {
        const bitrateScore = (b.bitrate || 0) - (a.bitrate || 0);
        if (bitrateScore !== 0) return bitrateScore;
        // prefer m4a
        if (a.mimeType?.includes('mp4') && !b.mimeType?.includes('mp4')) return -1;
        if (!a.mimeType?.includes('mp4') && b.mimeType?.includes('mp4')) return 1;
        return 0;
      });

      const best = sorted[0];
      if (!best?.url) continue;

      audioUrl = best.url;
      contentType = best.mimeType?.includes('mp4') ? 'audio/mp4' : 'audio/webm';
      console.log(`[resolveAudioUrl] ✅ got audio from ${instance} — type: ${contentType}, bitrate: ${best.bitrate}`);
      break;

    } catch (e: any) {
      console.warn(`[resolveAudioUrl] ${instance} failed: ${e.message}`);
      continue;
    }
  }

  if (!audioUrl) {
    console.error(`[resolveAudioUrl] all Piped instances failed for "${q}"`);
    return null;
  }

  // Cache for 1 hour
  audioCache.set(cacheKey, { url: audioUrl, contentType, expires: Date.now() + 60 * 60 * 1000 });
  return { url: audioUrl, contentType };
}

// GET /api/trending
app.get('/api/trending', async (_req, res) => {
  try {
    const rss = await itunesFetch(
      'https://rss.applemarketingtools.com/api/v2/us/music/most-played/25/songs.json'
    );
    const ids = rss.feed.results
      .slice(0, 25)
      .map((r: any) => r.id.replace('id', ''))
      .filter(Boolean)
      .join(',');

    const lookup = await itunesFetch(
      `https://itunes.apple.com/lookup?id=${ids}&media=music&country=us`
    );
    const tracks = (lookup.results || [])
      .filter((r: any) => r.wrapperType === 'track')
      .map(transformTrack);

    if (tracks.length === 0) throw new Error('No tracks from lookup');
    res.json(tracks);
  } catch (err: any) {
    console.error('[/api/trending] falling back:', err.message);
    try {
      const fallback = await itunesFetch(
        'https://itunes.apple.com/search?term=top+hits&media=music&entity=song&limit=20'
      );
      res.json((fallback.results || []).map(transformTrack));
    } catch (e2: any) {
      console.error('[/api/trending] fallback failed:', e2.message);
      res.status(500).json({ error: 'Failed to fetch trending tracks' });
    }
  }
});

// GET /api/search?q=query
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(parseInt(String(req.query.limit || '20')), 50);
  if (!q) return res.json([]);
  try {
    const data = await itunesFetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=${limit}`
    );
    res.json((data.results || []).map(transformTrack));
  } catch (err: any) {
    console.error('[/api/search]', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/genre/:genre
app.get('/api/genre/:genre', async (req, res) => {
  const genre = String(req.params.genre || '').trim();
  try {
    const data = await itunesFetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(genre)}&media=music&entity=song&limit=20`
    );
    res.json((data.results || []).map(transformTrack));
  } catch (err: any) {
    console.error('[/api/genre]', err.message);
    res.status(500).json({ error: 'Genre fetch failed' });
  }
});

// GET /api/recommendations
app.get('/api/recommendations', async (_req, res) => {
  const queries = ['ambient chill', 'lo fi beats', 'jazz classics', 'deep focus'];
  try {
    const results = await Promise.allSettled(
      queries.map((q) =>
        itunesFetch(
          `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=5`
        ).then((d: any) => (d.results || []).map(transformTrack))
      )
    );
    const tracks = results
      .filter((r) => r.status === 'fulfilled')
      .flatMap((r: any) => r.value);
    res.json(tracks);
  } catch (err: any) {
    console.error('[/api/recommendations]', err.message);
    res.status(500).json({ error: 'Recommendations failed' });
  }
});

// GET /api/stream
app.get('/api/stream', async (req, res) => {
  let q = String(req.query.q || '');
  const expectedSecs = parseInt(String(req.query.duration || '0'));
  if (!q) return res.status(400).send('Query required');

  try {
    const result = await resolveAudioUrl(q, expectedSecs);
    if (!result) return res.status(404).send('No audio format found');

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.youtube.com/',
    };

    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const upstream = await fetch(result.url, { headers });

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');

    if (upstream.headers.get('content-length')) {
      res.setHeader('Content-Length', upstream.headers.get('content-length')!);
    }
    if (upstream.headers.get('content-range')) {
      res.setHeader('Content-Range', upstream.headers.get('content-range')!);
    }

    res.status(upstream.status === 206 ? 206 : 200);

    if (upstream.body) {
      const reader = upstream.body.getReader();
      let cancelled = false;

      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { if (!res.writableEnded) res.end(); break; }
            if (res.writableEnded || cancelled) { reader.cancel().catch(() => { }); break; }
            res.write(Buffer.from(value));
          }
        } catch (e) {
          reader.cancel().catch(() => { });
          if (!res.writableEnded) res.end();
        }
      };
      pump();

      req.on('close', () => {
        cancelled = true;
        reader.cancel().catch(() => { });
        if (!res.writableEnded) res.end();
      });
    } else {
      res.end();
    }
  } catch (err: any) {
    console.error('[/api/stream]', err.message);
    if (!res.headersSent) res.status(500).send('Stream error');
  }
});

// GET /api/preload
app.get('/api/preload', async (req, res) => {
  const q = String(req.query.q || '');
  const expectedSecs = parseInt(String(req.query.duration || '0'));
  if (!q) return res.status(400).json({ ok: false });

  try {
    const result = await resolveAudioUrl(q, expectedSecs);
    res.json({ ok: !!result });
  } catch (err: any) {
    console.error('[/api/preload]', err.message);
    res.json({ ok: false });
  }
});

// GET /api/lyrics
app.get('/api/lyrics', async (req, res) => {
  const artist = String(req.query.artist || '').trim();
  const title = String(req.query.title || '').trim();

  let artistClean1 = artist.split(/[&,]/)[0].trim();
  let titleClean = title.replace(/\s*\(.*\)/g, '').replace(/\s*-.*$/g, '').trim();
  let artistFull = artist.trim();

  if (!artist || !title) return res.json({ lyrics: '' });

  const searchCycles = [
    { art: artistClean1, tit: titleClean },
    { art: artistFull, tit: titleClean }
  ];

  for (const { art, tit } of searchCycles) {
    const urls = [
      `https://api.lyrics.ovh/v1/${encodeURIComponent(art)}/${encodeURIComponent(tit)}`,
      `https://lyrist.vercel.app/api/${encodeURIComponent(tit + ' ' + art)}`,
      `https://api.popcat.xyz/lyrics?song=${encodeURIComponent(tit + ' ' + art)}`,
      `https://api.vagalume.com.br/search.php?art=${encodeURIComponent(art)}&mus=${encodeURIComponent(tit)}&apikey=666a35d448b08da93992f1331a4777ad`
    ];

    for (const url of urls) {
      try {
        console.log(`[/api/lyrics] Trying: ${url}`);
        const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) continue;
        const data: any = await resp.json();
        const lyrics = data.lyrics || data.content || (data.mus && data.mus[0] && data.mus[0].text);
        if (lyrics && lyrics.trim().length > 20) {
          console.log(`[/api/lyrics] found lyrics via ${url}`);
          return res.json({ lyrics });
        }
      } catch (e: any) {
        console.error(`[/api/lyrics] failed: ${url}`, e.message);
      }
    }
  }

  try {
    const finalUrl = `https://lyrist.vercel.app/api/${encodeURIComponent(titleClean)}`;
    const resp = await fetch(finalUrl, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const data = await resp.json();
      if (data.lyrics || data.content) return res.json({ lyrics: data.lyrics || data.content });
    }
  } catch { }

  res.json({ lyrics: '' });
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});
process.on('unhandledRejection', (reason: any) => {
  console.error('[unhandledRejection]', reason?.message || reason);
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎵 Sonic Immersive API running on http://0.0.0.0:${PORT}`);
});