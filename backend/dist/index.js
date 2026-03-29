import express from 'express';
import cors from 'cors';
import ytSearch from 'yt-search';
import youtubeDl from 'youtube-dl-exec';
const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
app.use(cors({
    origin: [
        'http://localhost:5173',
        'https://music-player2-your-name.vercel.app' // Add your Vercel link here
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Range'], // Range is important for seeking audio
    exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length']
}));
app.use(express.json());
function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}
function transformTrack(item) {
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
        preview: `/api/stream?q=${encodeURIComponent(title + ' ' + artist)}`,
        genre: item.primaryGenreName || '',
    };
}
async function itunesFetch(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': 'SonicImmersive/1.0' },
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
    return res.json();
}
// ── Simple in-memory cache for resolved audio URLs (avoids re-querying yt-dlp) ──
const audioCache = new Map();
// Helper: resolve audio URL from YouTube (shared by /api/stream and /api/preload)
async function resolveAudioUrl(q, expectedSecs) {
    const cacheKey = `${q}_${expectedSecs}`;
    const cached = audioCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
        return { url: cached.url, contentType: cached.contentType };
    }
    const cleanQ = q.replace(/\s*\(.*\)/g, '').replace(/\s*-.*$/g, '').trim();
    // Parallel search attempts for speed
    const searchPromises = [
        ytSearch(cleanQ + ' full official audio'),
        ytSearch(cleanQ + ' audio'),
    ];
    const searchAttempts = await Promise.allSettled(searchPromises);
    let allVideos = [];
    for (const result of searchAttempts) {
        if (result.status === 'fulfilled' && result.value?.videos?.length) {
            allVideos.push(...result.value.videos);
        }
    }
    // Deduplicate by videoId
    const seen = new Set();
    allVideos = allVideos.filter(v => {
        if (seen.has(v.videoId))
            return false;
        seen.add(v.videoId);
        return true;
    });
    if (allVideos.length === 0)
        return null;
    // Strict filtering: find video within range of expected duration
    let bestVideo = null;
    if (expectedSecs > 0) {
        bestVideo = allVideos.find(v => Math.abs(v.seconds - expectedSecs) < 60);
        if (!bestVideo)
            bestVideo = allVideos.find(v => v.seconds > 60 && v.seconds > expectedSecs - 120);
    }
    if (!bestVideo)
        bestVideo = allVideos.find(v => v.seconds > 60) || allVideos[0];
    const videoUrl = bestVideo.url;
    console.log(`[resolveAudioUrl] resolved for "${q}" (exp: ${expectedSecs}s) → ${videoUrl} (${bestVideo.timestamp})`);
    const info = await youtubeDl(videoUrl, {
        dumpSingleJson: true,
        noCheckCertificates: true,
        noWarnings: true,
        preferFreeFormats: true,
        addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0'],
    });
    const audioFormats = (info.formats || [])
        .filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
        .sort((a, b) => (b.abr || 0) - (a.abr || 0));
    const format = audioFormats[0];
    if (!format?.url)
        return null;
    const contentType = format.ext === 'webm' ? 'audio/webm' : 'audio/mp4';
    // Cache for 60 minutes
    audioCache.set(cacheKey, { url: format.url, contentType, expires: Date.now() + 60 * 60 * 1000 });
    return { url: format.url, contentType };
}
// GET /api/trending
app.get('/api/trending', async (_req, res) => {
    try {
        const rss = await itunesFetch('https://rss.applemarketingtools.com/api/v2/us/music/most-played/25/songs.json');
        const ids = rss.feed.results
            .slice(0, 25)
            .map((r) => r.id.replace('id', ''))
            .filter(Boolean)
            .join(',');
        const lookup = await itunesFetch(`https://itunes.apple.com/lookup?id=${ids}&media=music&country=us`);
        const tracks = (lookup.results || [])
            .filter((r) => r.wrapperType === 'track')
            .map(transformTrack);
        if (tracks.length === 0)
            throw new Error('No tracks from lookup');
        res.json(tracks);
    }
    catch (err) {
        console.error('[/api/trending] falling back:', err.message);
        try {
            const fallback = await itunesFetch('https://itunes.apple.com/search?term=top+hits&media=music&entity=song&limit=20');
            res.json((fallback.results || []).map(transformTrack));
        }
        catch (e2) {
            console.error('[/api/trending] fallback failed:', e2.message);
            res.status(500).json({ error: 'Failed to fetch trending tracks' });
        }
    }
});
// GET /api/search?q=query
app.get('/api/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(String(req.query.limit || '20')), 50);
    if (!q)
        return res.json([]);
    try {
        const data = await itunesFetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=${limit}`);
        res.json((data.results || []).map(transformTrack));
    }
    catch (err) {
        console.error('[/api/search]', err.message);
        res.status(500).json({ error: 'Search failed' });
    }
});
// GET /api/genre/:genre
app.get('/api/genre/:genre', async (req, res) => {
    const genre = String(req.params.genre || '').trim();
    try {
        const data = await itunesFetch(`https://itunes.apple.com/search?term=${encodeURIComponent(genre)}&media=music&entity=song&limit=20`);
        res.json((data.results || []).map(transformTrack));
    }
    catch (err) {
        console.error('[/api/genre]', err.message);
        res.status(500).json({ error: 'Genre fetch failed' });
    }
});
// GET /api/recommendations
app.get('/api/recommendations', async (_req, res) => {
    const queries = ['ambient chill', 'lo fi beats', 'jazz classics', 'deep focus'];
    try {
        const results = await Promise.allSettled(queries.map((q) => itunesFetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=5`).then((d) => (d.results || []).map(transformTrack))));
        const tracks = results
            .filter((r) => r.status === 'fulfilled')
            .flatMap((r) => r.value);
        res.json(tracks);
    }
    catch (err) {
        console.error('[/api/recommendations]', err.message);
        res.status(500).json({ error: 'Recommendations failed' });
    }
});
// GET /api/stream — proxies full audio from YouTube via yt-dlp
app.get('/api/stream', async (req, res) => {
    let q = String(req.query.q || '');
    const expectedSecs = parseInt(String(req.query.duration || '0'));
    if (!q)
        return res.status(400).send('Query required');
    try {
        const result = await resolveAudioUrl(q, expectedSecs);
        if (!result)
            return res.status(404).send('No audio format found');
        // Proxy audio through server to avoid CORS issues with YouTube CDN
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.youtube.com/',
        };
        // Forward range requests for seeking support
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }
        const upstream = await fetch(result.url, { headers });
        // Set response headers
        res.setHeader('Content-Type', result.contentType);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'no-cache');
        if (upstream.headers.get('content-length')) {
            res.setHeader('Content-Length', upstream.headers.get('content-length'));
        }
        if (upstream.headers.get('content-range')) {
            res.setHeader('Content-Range', upstream.headers.get('content-range'));
        }
        // Use 206 for range requests, 200 otherwise
        res.status(upstream.status === 206 ? 206 : 200);
        // Pipe the audio stream to the response
        if (upstream.body) {
            const reader = upstream.body.getReader();
            let cancelled = false;
            const pump = async () => {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            if (!res.writableEnded)
                                res.end();
                            break;
                        }
                        if (res.writableEnded || cancelled) {
                            reader.cancel().catch(() => { });
                            break;
                        }
                        res.write(Buffer.from(value));
                    }
                }
                catch (e) {
                    reader.cancel().catch(() => { });
                    if (!res.writableEnded)
                        res.end();
                }
            };
            pump();
            // Clean up if client disconnects — cancel the READER, not the body
            req.on('close', () => {
                cancelled = true;
                reader.cancel().catch(() => { });
                if (!res.writableEnded)
                    res.end();
            });
        }
        else {
            res.end();
        }
    }
    catch (err) {
        console.error('[/api/stream]', err.message);
        if (!res.headersSent)
            res.status(500).send('Stream error');
    }
});
// GET /api/preload — pre-resolves audio URL and caches it (returns immediately)
app.get('/api/preload', async (req, res) => {
    const q = String(req.query.q || '');
    const expectedSecs = parseInt(String(req.query.duration || '0'));
    if (!q)
        return res.status(400).json({ ok: false });
    try {
        const result = await resolveAudioUrl(q, expectedSecs);
        res.json({ ok: !!result });
    }
    catch (err) {
        console.error('[/api/preload]', err.message);
        res.json({ ok: false });
    }
});
// GET /api/lyrics — robust provider lookup with multiple search variations
app.get('/api/lyrics', async (req, res) => {
    const artist = String(req.query.artist || '').trim();
    const title = String(req.query.title || '').trim();
    // Variation 1: Clean artist (first one) + Clean title
    let artistClean1 = artist.split(/[&,]/)[0].trim();
    let titleClean = title.replace(/\s*\(.*\)/g, '').replace(/\s*-.*$/g, '').trim();
    // Variation 2: Full artist + Clean title
    let artistFull = artist.trim();
    if (!artist || !title)
        return res.json({ lyrics: '' });
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
                if (!resp.ok)
                    continue;
                const data = await resp.json();
                // Vagalume response has a different structure
                const lyrics = data.lyrics || data.content || (data.mus && data.mus[0] && data.mus[0].text);
                if (lyrics && lyrics.trim().length > 20) {
                    console.log(`[/api/lyrics] found lyrics via ${url}`);
                    return res.json({ lyrics });
                }
            }
            catch (e) {
                console.error(`[/api/lyrics] failed: ${url}`, e.message);
            }
        }
    }
    // Final hail-mary: Search Lyrist with just the title
    try {
        const finalUrl = `https://lyrist.vercel.app/api/${encodeURIComponent(titleClean)}`;
        const resp = await fetch(finalUrl, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
            const data = await resp.json();
            if (data.lyrics || data.content)
                return res.json({ lyrics: data.lyrics || data.content });
        }
    }
    catch { }
    res.json({ lyrics: '' });
});
// Removed proxyAudio to utilize native 302 redirects for zero-lag streaming
// ── Global error handlers — prevent unhandled errors from crashing the server ──
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason?.message || reason);
});
app.listen(PORT, () => {
    console.log(`\n🎵 Sonic Immersive API running on http://localhost:${PORT}`);
});
