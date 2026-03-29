import {
  Home, Search, Library, Crown, Menu, Bell, User,
  SkipBack, Play, Pause, SkipForward, Volume2, Maximize2,
  Shuffle, Repeat, Heart, ListMusic, X, Loader2, Music, ChevronLeft,
  Plus, Trash2, MoreHorizontal, Mic2, ExternalLink,
} from 'lucide-react';
import { useState, useEffect, useRef, useCallback, ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { NavItem, Track } from './types';
import { GENRES, MADE_FOR_YOU_SEEDS } from './constants';
import { fetchTrending, searchTracks, fetchByGenre, fetchRecommendations, fetchLyrics, preloadTrack, getStreamUrl } from './api';
import { CustomPlaylist, loadLiked, saveLiked, loadPlaylists, savePlaylists } from './storage';

// ─── Placeholder cover for tracks without artwork ─────────────────────────────
const PLACEHOLDER = 'https://picsum.photos/seed/music/400/400';

function safeCover(url?: string | null) {
  return url && url.length > 10 ? url : PLACEHOLDER;
}

// ─── Root App ────────────────────────────────────────────────────────────────
export default function App() {
  const [activeTab, setActiveTab] = useState<NavItem>('home');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [volume, setVolume] = useState(0.8);
  const [progress, setProgress] = useState(0); // 0–1
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isShuffled, setIsShuffled] = useState(false);
  const [isRepeating, setIsRepeating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Track[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [likedTracks, setLikedTracks] = useState<Track[]>(() => loadLiked());
  const likedIds = new Set(likedTracks.map(t => t.id));

  // ── NEW: Feature states
  const [customPlaylists, setCustomPlaylists] = useState<CustomPlaylist[]>(() => loadPlaylists());
  const [lyrics, setLyrics] = useState('');
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);
  const [crossfadeSecs] = useState(5);
  const [addToPlaylistTrack, setAddToPlaylistTrack] = useState<Track | null>(null);
  const [showAccountMenu, setShowAccountMenu] = useState(false);

  // ── Dual audio refs for crossfade
  const audioRefA = useRef<HTMLAudioElement>(null);
  const audioRefB = useRef<HTMLAudioElement>(null);
  const activeSlot = useRef<'A' | 'B'>('A');
  const isCrossfadingRef = useRef(false);
  const crossfadeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const getAudio = useCallback(() => activeSlot.current === 'A' ? audioRefA.current : audioRefB.current, []);
  const getNextAudioEl = useCallback(() => activeSlot.current === 'A' ? audioRefB.current : audioRefA.current, []);

  // ── Responsive sidebar
  useEffect(() => {
    const handle = () => setIsSidebarOpen(window.innerWidth >= 1024);
    handle();
    window.addEventListener('resize', handle);
    return () => window.removeEventListener('resize', handle);
  }, []);

  // ── Persist liked & playlists
  useEffect(() => { saveLiked(likedTracks); }, [likedTracks]);
  useEffect(() => { savePlaylists(customPlaylists); }, [customPlaylists]);

  // ── Fetch lyrics when track changes
  useEffect(() => {
    if (!currentTrack) { setLyrics(''); return; }
    setLyricsLoading(true); setLyrics('');
    fetchLyrics(currentTrack.artist, currentTrack.title)
      .then(l => setLyrics(l)).catch(() => setLyrics(''))
      .finally(() => setLyricsLoading(false));
  }, [currentTrack?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pre-fetch next track audio URL for instant playback
  useEffect(() => {
    if (!currentTrack || queue.length < 2) return;
    const idx = queue.findIndex(t => t.id === currentTrack.id);
    const nextIdx = (idx + 1) % queue.length;
    const nextTrack = queue[nextIdx];
    if (!nextTrack) return;
    const parts = (nextTrack.duration || '0:00').split(':');
    const secs = parts.length === 2 ? (parseInt(parts[0]) * 60 + parseInt(parts[1])) : 0;
    // Fire and forget — pre-warm the server cache
    preloadTrack(nextTrack.title + ' ' + nextTrack.artist, secs).catch(() => {});
  }, [currentTrack?.id, queue]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Audio event listeners
  useEffect(() => {
    const audio = getAudio();
    if (!audio) return;
    const onTime = () => {
      setCurrentTime(audio.currentTime);
      setDuration(audio.duration || 0);
      setProgress(audio.duration ? audio.currentTime / audio.duration : 0);
      // Crossfade detection
      if (crossfadeSecs > 0 && audio.duration && !isCrossfadingRef.current &&
          audio.duration - audio.currentTime <= crossfadeSecs &&
          audio.duration - audio.currentTime > 0.5 && queue.length > 0 && currentTrack) {
        startCrossfade();
      }
    };
    const onEnded = () => { if (!isCrossfadingRef.current) handleNext(); };
    const onWaiting = () => setIsBuffering(true);
    const onPlaying = () => setIsBuffering(false);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('canplay', onPlaying);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('playing', onPlaying);
      audio.removeEventListener('canplay', onPlaying);
    };
  }, [queue, currentTrack, isShuffled, isRepeating, crossfadeSecs]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Volume sync
  useEffect(() => {
    const a = getAudio(); if (a) a.volume = volume;
  }, [volume, getAudio]);

  // ── Play/Pause
  useEffect(() => {
    const audio = getAudio();
    if (!audio) return;
    if (isPlaying) { audio.play().catch(() => setIsPlaying(false)); } else { audio.pause(); }
  }, [isPlaying, getAudio]);

  // ── Crossfade helpers
  const cancelCrossfade = useCallback(() => {
    if (crossfadeTimerRef.current) { clearInterval(crossfadeTimerRef.current); crossfadeTimerRef.current = null; }
    const nx = getNextAudioEl(); if (nx) { nx.pause(); nx.src = ''; }
    isCrossfadingRef.current = false;
  }, [getNextAudioEl]);

  const startCrossfade = useCallback(() => {
    if (isCrossfadingRef.current || !currentTrack || queue.length === 0) return;
    const idx = queue.findIndex(t => t.id === currentTrack.id);
    const nextIdx = isShuffled ? Math.floor(Math.random() * queue.length) : (idx + 1) % queue.length;
    const nextTrack = queue[nextIdx];
    const parts = (nextTrack.duration || "0:00").split(':');
    const secs = parts.length === 2 ? (parseInt(parts[0]) * 60 + parseInt(parts[1])) : 0;
    
    isCrossfadingRef.current = true;
    const nx = getNextAudioEl(); const cur = getAudio();
    if (!nx || !cur) return;
    
    nx.pause();
    nx.src = '';
    nx.load();
    
    nx.src = getStreamUrl(nextTrack.title + ' ' + nextTrack.artist, secs);
    nx.volume = 0;
    nx.play().catch(() => {});
    const steps = Math.max(1, crossfadeSecs * 20);
    const interval = (crossfadeSecs * 1000) / steps;
    const volStep = volume / steps; let step = 0;
    crossfadeTimerRef.current = setInterval(() => {
      step++;
      cur.volume = Math.max(0, volume - volStep * step);
      nx.volume = Math.min(volume, volStep * step);
      if (step >= steps) {
        if (crossfadeTimerRef.current) clearInterval(crossfadeTimerRef.current);
        crossfadeTimerRef.current = null;
        cur.pause(); cur.src = '';
        activeSlot.current = activeSlot.current === 'A' ? 'B' : 'A';
        setCurrentTrack(nextTrack); setProgress(0); setCurrentTime(0); setIsPlaying(true);
        isCrossfadingRef.current = false;
      }
    }, interval);
  }, [currentTrack, queue, isShuffled, volume, crossfadeSecs, getAudio, getNextAudioEl]);

  // ── Load new track
  const playTrack = useCallback((track: Track, newQueue?: Track[]) => {
    cancelCrossfade();
    if (newQueue) setQueue(newQueue);
    setCurrentTrack(track); setProgress(0); setCurrentTime(0);
    const audio = getAudio(); if (!audio) return;
    
    // Explicit reset to clear metadata and previous source
    audio.pause();
    audio.src = '';
    audio.load();
    
    // Parse duration MM:SS to seconds for backend matching
    const parts = (track.duration || "0:00").split(':');
    const secs = parts.length === 2 ? (parseInt(parts[0]) * 60 + parseInt(parts[1])) : 0;
    
    // Use a cache-busting timestamp to ensure fresh resolution
    const src = getStreamUrl(track.title + ' ' + track.artist, secs);
    audio.src = src; audio.volume = volume;
    audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
  }, [cancelCrossfade, getAudio, volume]);

  const handleNext = useCallback(() => {
    if (!currentTrack || queue.length === 0) return;
    if (isRepeating) {
      const audio = getAudio();
      if (audio) { audio.currentTime = 0; audio.play(); }
      return;
    }
    const idx = queue.findIndex((t) => t.id === currentTrack.id);
    const nextIdx = isShuffled ? Math.floor(Math.random() * queue.length) : (idx + 1) % queue.length;
    playTrack(queue[nextIdx]);
  }, [currentTrack, queue, isShuffled, isRepeating, playTrack, getAudio]);

  const handlePrev = useCallback(() => {
    if (!currentTrack || queue.length === 0) return;
    cancelCrossfade();
    const audio = getAudio();
    if (audio && audio.currentTime > 3) { audio.currentTime = 0; return; }
    const idx = queue.findIndex((t) => t.id === currentTrack.id);
    const prevIdx = (idx - 1 + queue.length) % queue.length;
    playTrack(queue[prevIdx]);
  }, [currentTrack, queue, playTrack, cancelCrossfade, getAudio]);

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = getAudio();
    if (!audio || !audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    audio.currentTime = ratio * audio.duration;
  };

  // ── Search
  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); return; }
    const t = setTimeout(async () => {
      setIsSearching(true);
      try {
        const results = await searchTracks(searchQuery);
        setSearchResults(results);
      } catch { /* ignore */ }
      setIsSearching(false);
    }, 400);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const toggleLike = (track: Track) => {
    setLikedTracks((prev) => {
      const exists = prev.find(t => t.id === track.id);
      return exists ? prev.filter(t => t.id !== track.id) : [...prev, track];
    });
  };

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  // ── Queue management
  const addToQueue = useCallback((track: Track) => {
    setQueue(prev => prev.find(t => t.id === track.id) ? prev : [...prev, track]);
  }, []);
  const removeFromQueue = useCallback((index: number) => {
    setQueue(prev => prev.filter((_, i) => i !== index));
  }, []);

  // ── Playlist CRUD
  const createPlaylist = useCallback((name: string) => {
    const pl: CustomPlaylist = { id: `pl_${Date.now()}`, name, tracks: [], createdAt: Date.now() };
    setCustomPlaylists(prev => [pl, ...prev]);
    return pl;
  }, []);
  const deletePlaylist = useCallback((id: string) => {
    setCustomPlaylists(prev => prev.filter(p => p.id !== id));
  }, []);
  const addTrackToPlaylist = useCallback((playlistId: string, track: Track) => {
    setCustomPlaylists(prev => prev.map(p =>
      p.id === playlistId && !p.tracks.find(t => t.id === track.id)
        ? { ...p, tracks: [...p.tracks, track] } : p
    ));
  }, []);
  const removeTrackFromPlaylist = useCallback((playlistId: string, trackId: string) => {
    setCustomPlaylists(prev => prev.map(p =>
      p.id === playlistId ? { ...p, tracks: p.tracks.filter(t => t.id !== trackId) } : p
    ));
  }, []);

  const renderContent = () => {
    switch (activeTab) {
      case 'home':    return <HomeView onPlay={playTrack} likedIds={likedIds} onLike={toggleLike} onAddToQueue={addToQueue} onAddToPlaylist={(t: Track) => setAddToPlaylistTrack(t)} />;
      case 'explore': return <ExploreView onPlay={playTrack} likedIds={likedIds} onLike={toggleLike} onAddToQueue={addToQueue} onAddToPlaylist={(t: Track) => setAddToPlaylistTrack(t)} />;
      case 'library': return <LibraryView onPlay={playTrack} likedIds={likedIds} likedTracks={likedTracks} onLike={toggleLike} customPlaylists={customPlaylists} onCreatePlaylist={createPlaylist} onDeletePlaylist={deletePlaylist} onRemoveTrackFromPlaylist={removeTrackFromPlaylist} />;
      case 'premium': return <PremiumView />;
      case 'now-playing':
        return currentTrack ? (
          <NowPlayingView
            track={currentTrack}
            isPlaying={isPlaying}
            isBuffering={isBuffering}
            progress={progress}
            currentTime={currentTime}
            duration={duration}
            isShuffled={isShuffled}
            isRepeating={isRepeating}
            liked={likedIds.has(currentTrack.id)}
            onTogglePlay={() => setIsPlaying((p) => !p)}
            onNext={handleNext}
            onPrev={handlePrev}
            onSeek={handleSeek}
            onToggleShuffle={() => setIsShuffled((s) => !s)}
            onToggleRepeat={() => setIsRepeating((r) => !r)}
            onLike={() => toggleLike(currentTrack)}
            onAddToPlaylist={() => setAddToPlaylistTrack(currentTrack)}
            onBack={() => setActiveTab('home')}
            lyrics={lyrics}
            lyricsLoading={lyricsLoading}
            showLyrics={showLyrics}
            onToggleLyrics={() => setShowLyrics(v => !v)}
            queue={queue}
            onPlayFromQueue={(idx) => playTrack(queue[idx])}
            onRemoveFromQueue={(idx) => setQueue(q => q.filter((_, i) => i !== idx))}
          />
        ) : null;
      default: return <HomeView onPlay={playTrack} likedIds={likedIds} onLike={toggleLike} onAddToQueue={addToQueue} onAddToPlaylist={(t: Track) => setAddToPlaylistTrack(t)} />;
    }
  };

  return (
    <div className="h-screen bg-surface flex text-white overflow-hidden">
      {/* Hidden Audio Elements (dual for crossfade) */}
      <audio ref={audioRefA} preload="auto" />
      <audio ref={audioRefB} preload="auto" />

      {/* Sidebar Overlay (mobile) */}
      <AnimatePresence>
        {isSidebarOpen && window.innerWidth < 1024 && (
          <motion.div
            className="fixed inset-0 bg-black/60 z-40 lg:hidden"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setIsSidebarOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-64 bg-black border-r border-white/5 transition-transform duration-300 lg:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="p-8 flex flex-col h-full">
          <div className="mb-10">
            <h1 className="font-headline font-extrabold text-2xl tracking-tighter text-primary uppercase">
              Sonic Immersive
            </h1>
            <span className="text-[10px] font-bold tracking-[0.2em] text-on-surface-variant uppercase">Premium Hi-Fi</span>
          </div>

          <nav className="flex-1 space-y-1">
            <SidebarLink icon={<Home size={20} />} label="Home" active={activeTab === 'home'} onClick={() => { setActiveTab('home'); if (window.innerWidth < 1024) setIsSidebarOpen(false); }} />
            <SidebarLink icon={<Search size={20} />} label="Explore" active={activeTab === 'explore'} onClick={() => { setActiveTab('explore'); if (window.innerWidth < 1024) setIsSidebarOpen(false); }} />
            <SidebarLink icon={<Library size={20} />} label="Library" active={activeTab === 'library'} onClick={() => { setActiveTab('library'); if (window.innerWidth < 1024) setIsSidebarOpen(false); }} />
          </nav>

          <div className="mt-auto space-y-6">
            <div className="p-4 bg-surface-container rounded-xl">
              <p className="text-[10px] font-bold text-primary uppercase tracking-widest mb-1">Upgrade</p>
              <p className="text-xs text-on-surface-variant mb-3">Unlock Lossless Audio</p>
              <button className="w-full py-2.5 pulse-button rounded-full text-xs font-bold" onClick={() => setActiveTab('premium')}>
                Go Premium
              </button>
            </div>
            <div className="flex items-center gap-3 px-2">
              <div className="w-10 h-10 rounded-full bg-surface-container-high overflow-hidden border border-white/10">
                <img src="https://picsum.photos/seed/user/100/100" alt="User" referrerPolicy="no-referrer" />
              </div>
              <div className="overflow-hidden">
                <p className="text-sm font-bold truncate">Julian Conductor</p>
                <p className="text-[10px] text-on-surface-variant uppercase">Pro Member</p>
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className={`flex-1 flex flex-col h-screen min-w-0 transition-all duration-300 ${isSidebarOpen ? 'lg:ml-64' : 'ml-0'}`}>
        {/* Top Bar */}
        <header className="h-16 sm:h-20 px-4 sm:px-8 flex items-center justify-between sticky top-0 z-40 bg-surface/90 backdrop-blur-md border-b border-white/5">
          <div className="flex items-center gap-3 sm:gap-4">
            <button onClick={() => setIsSidebarOpen((o) => !o)} className="p-2 hover:bg-white/5 rounded-full lg:hidden">
              <Menu size={22} />
            </button>
            <div className="hidden lg:flex items-center gap-8 font-headline font-bold text-sm uppercase tracking-widest text-on-surface-variant">
              <button onClick={() => setActiveTab('explore')} className="hover:text-white transition-colors">New Releases</button>
              <button onClick={() => setActiveTab('home')} className="hover:text-white transition-colors">Charts</button>
              <button onClick={() => setActiveTab('explore')} className="hover:text-white transition-colors">Podcasts</button>
            </div>
          </div>

          <div className="flex items-center gap-3 sm:gap-5 flex-1 justify-end max-w-md ml-4">
            <div className="relative flex-1 max-w-xs">
              {isSearching
                ? <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant animate-spin" size={16} />
                : <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" size={16} />
              }
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search tracks…"
                className="bg-surface-container border border-white/10 rounded-full py-2 pl-9 pr-8 w-full text-sm focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all"
              />
              {searchQuery && (
                <button onClick={() => { setSearchQuery(''); setSearchResults([]); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-white">
                  <X size={14} />
                </button>
              )}
              {/* Search Dropdown */}
              <AnimatePresence>
                {searchResults.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}
                    className="absolute top-full mt-2 left-0 right-0 bg-surface-container border border-white/10 rounded-xl overflow-hidden z-50 shadow-2xl max-h-80 overflow-y-auto no-scrollbar"
                  >
                    {searchResults.map((track) => (
                      <div key={track.id} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/5 group/search transition-colors cursor-pointer">
                        <div className="flex items-center gap-3 flex-1 overflow-hidden" onClick={() => { playTrack(track, searchResults); setSearchQuery(''); setSearchResults([]); }}>
                          <img src={safeCover(track.cover)} alt={track.title} className="w-9 h-9 rounded object-cover flex-shrink-0" />
                          <div className="overflow-hidden flex-1">
                            <p className="text-sm font-bold truncate">{track.title}</p>
                            <p className="text-xs text-on-surface-variant truncate">{track.artist}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover/search:opacity-100 transition-opacity pl-2">
                          <button onClick={(e) => { e.stopPropagation(); addToQueue(track); }} className="p-1.5 hover:bg-white/10 rounded-full text-on-surface-variant hover:text-white" title="Add to Queue">
                            <ListMusic size={14} />
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); setAddToPlaylistTrack(track); }} className="p-1.5 hover:bg-white/10 rounded-full text-on-surface-variant hover:text-white" title="Add to Playlist">
                            <Plus size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <button className="p-2 hover:bg-white/5 rounded-full text-on-surface-variant hover:text-white transition-colors hidden sm:block">
              <Bell size={18} />
            </button>
            <div className="relative">
              <button onClick={() => setShowAccountMenu(m => !m)} className="p-2 hover:bg-white/5 rounded-full text-on-surface-variant hover:text-white transition-colors">
                <User size={18} />
              </button>
              <AnimatePresence>
                {showAccountMenu && (
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} className="absolute top-full mt-2 right-0 w-64 bg-surface-container-high border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden">
                    <div className="p-4 border-b border-white/5">
                      <p className="font-bold">Julian Conductor</p>
                      <p className="text-xs text-secondary">Free Plan</p>
                    </div>
                    <div className="py-2">
                      <button onClick={() => { setActiveTab('premium'); setShowAccountMenu(false); }} className="w-full text-left px-4 py-3 text-sm hover:bg-white/10 flex items-center gap-3 transition-colors">
                        <Crown size={16} className="text-secondary" /> Upgrade to Pro
                      </button>
                      <button onClick={() => setShowAccountMenu(false)} className="w-full text-left px-4 py-3 text-sm hover:bg-white/10 text-on-surface-variant transition-colors mt-2">
                        Settings
                      </button>
                      <button onClick={() => { alert('Sign out is not implemented yet.'); setShowAccountMenu(false); }} className="w-full text-left px-4 py-3 text-sm hover:bg-red-500/10 text-red-500 transition-colors">
                        Sign Out
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </header>

        {/* Dynamic View */}
        <div className="flex-1 overflow-y-auto no-scrollbar">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.25 }}
              className={`p-4 sm:p-8 lg:p-12 ${currentTrack ? 'pb-44 lg:pb-36' : 'pb-28 lg:pb-12'}`}
            >
              {renderContent()}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      {/* Player Dock */}
      {currentTrack && (
        <PlayerDock
          track={currentTrack}
          isPlaying={isPlaying}
          isBuffering={isBuffering}
          progress={progress}
          currentTime={currentTime}
          duration={duration}
          volume={volume}
          liked={likedIds.has(currentTrack.id)}
          onTogglePlay={() => setIsPlaying((p) => !p)}
          onNext={handleNext}
          onPrev={handlePrev}
          onSeek={handleSeek}
          onVolumeChange={setVolume}
          onLike={() => toggleLike(currentTrack)}
          onOpenFull={() => setActiveTab('now-playing')}
        />
      )}

      {/* Add to Playlist Modal */}
      {addToPlaylistTrack && (
        <AddToPlaylistModal
          track={addToPlaylistTrack}
          customPlaylists={customPlaylists}
          onCreatePlaylist={createPlaylist}
          onAdd={addTrackToPlaylist}
          onClose={() => setAddToPlaylistTrack(null)}
        />
      )}

      {/* Mobile Bottom Nav */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 h-16 bg-black/90 backdrop-blur-xl border-t border-white/5 flex justify-around items-center px-4 z-50">
        <MobileNavLink icon={<Home size={20} />} label="Home" active={activeTab === 'home'} onClick={() => setActiveTab('home')} />
        <MobileNavLink icon={<Search size={20} />} label="Explore" active={activeTab === 'explore'} onClick={() => setActiveTab('explore')} />
        <MobileNavLink icon={<Library size={20} />} label="Library" active={activeTab === 'library'} onClick={() => setActiveTab('library')} />
        <MobileNavLink icon={<Crown size={20} />} label="Premium" active={activeTab === 'premium'} onClick={() => setActiveTab('premium')} />
      </nav>
    </div>
  );
}

// ─── Home View ────────────────────────────────────────────────────────────────
function HomeView({ onPlay, likedIds, onLike, onAddToQueue, onAddToPlaylist }: { onPlay: (t: Track, q: Track[]) => void; likedIds: Set<string>; onLike: (track: Track) => void; onAddToQueue: (t: Track) => void; onAddToPlaylist: (t: Track) => void }) {
  const [trending, setTrending] = useState<Track[]>([]);
  const [recommendations, setRecommendations] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setApiError(null);
    Promise.all([fetchTrending(), fetchRecommendations()])
      .then(([t, r]) => { setTrending(t); setRecommendations(r); })
      .catch((e) => {
        console.error(e);
        setApiError("API server not reachable. Make sure it is running on port 3001 with: npm run dev:api");
      })
      .finally(() => setLoading(false));
  }, []);

  const recentlyPlayed = trending.slice(0, 6);
  const madeForYou = recommendations.slice(0, 5);
  const trendingList = trending.slice(6, 15);

  if (loading) return <LoadingState />;
  if (apiError) return (
    <div className="flex flex-col items-center justify-center py-32 gap-4 text-center max-w-md mx-auto">
      <Music size={48} className="text-on-surface-variant" />
      <p className="font-bold text-lg">Backend not reachable</p>
      <p className="text-on-surface-variant text-sm">{apiError}</p>
      <code className="text-xs bg-surface-container px-4 py-2 rounded-lg text-primary mt-2">npm run dev:api</code>
    </div>
  );

  return (
    <div className="space-y-12 sm:space-y-16 max-w-7xl mx-auto relative">
      <div className="absolute -top-40 -left-40 w-96 h-96 bg-primary/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute top-1/2 -right-40 w-80 h-80 bg-secondary/10 rounded-full blur-[100px] pointer-events-none" />

      <section className="relative z-10">
        <span className="text-secondary font-bold text-xs tracking-[0.3em] uppercase mb-2 block">Welcome back</span>
        <h2 className="font-headline text-4xl sm:text-6xl md:text-8xl font-extrabold tracking-tighter leading-none">
          Good Evening, <br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-white to-white/40">Conductor.</span>
        </h2>
      </section>

      {recentlyPlayed.length > 0 && (
        <section>
          <div className="flex justify-between items-end mb-6">
            <h3 className="font-headline text-xl sm:text-2xl font-bold">Recently Played</h3>
          </div>
          <div className="flex gap-5 sm:gap-8 overflow-x-auto no-scrollbar -mx-4 px-4">
            {recentlyPlayed.map((track) => (
              <TrackCard key={track.id} track={track} onPlay={() => onPlay(track, recentlyPlayed)} liked={likedIds.has(track.id)} onLike={() => onLike(track)} onAddToQueue={() => onAddToQueue(track)} onAddToPlaylist={() => onAddToPlaylist(track)} />
            ))}
          </div>
        </section>
      )}

      {madeForYou.length > 0 && (
        <section>
          <div className="mb-6">
            <h3 className="font-headline text-xl sm:text-2xl font-bold">Made For You</h3>
            <p className="text-on-surface-variant text-sm mt-1">Curated journeys based on your nocturnal habits.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
            {/* Bento Feature */}
            <div
              className="sm:col-span-2 sm:row-span-2 relative aspect-video sm:aspect-auto min-h-48 sm:min-h-64 rounded-xl overflow-hidden group cursor-pointer"
              onClick={() => onPlay(madeForYou[0], madeForYou)}
            >
              <img src={safeCover(madeForYou[0].cover)} alt={madeForYou[0].title} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" referrerPolicy="no-referrer" />
              <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent flex flex-col justify-end p-6">
                <span className="text-secondary text-[10px] font-black tracking-[0.3em] uppercase mb-2">Algorithm Pick</span>
                <h4 className="text-2xl sm:text-3xl font-headline font-extrabold mb-1">{madeForYou[0].title}</h4>
                <p className="text-on-surface-variant text-xs">{madeForYou[0].artist}</p>
              </div>
            </div>
            {madeForYou.slice(1, 5).map((track) => (
              <div key={track.id} className="relative aspect-square rounded-xl overflow-hidden group cursor-pointer bg-surface-container" onClick={() => onPlay(track, madeForYou)}>
                <img src={safeCover(track.cover)} alt={track.title} className="w-full h-full object-cover opacity-60 transition-transform duration-500 group-hover:scale-110" referrerPolicy="no-referrer" />
                <div className="absolute inset-0 flex flex-col justify-end p-4 sm:p-6">
                  <h4 className="text-base sm:text-xl font-headline font-bold leading-tight">{track.title}</h4>
                  <p className="text-xs text-on-surface-variant mt-1 truncate">{track.artist}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {trendingList.length > 0 && (
        <section className="pb-4">
          <h3 className="font-headline text-xl sm:text-2xl font-bold mb-6">Trending Now</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            {trendingList.map((track, idx) => (
              <div key={track.id} className="flex items-center gap-4 p-3 sm:p-4 bg-surface-container rounded-xl hover:bg-surface-container-high transition-colors cursor-pointer group" onClick={() => onPlay(track, trendingList)}>
                <div className="relative w-14 h-14 sm:w-16 sm:h-16 rounded-lg overflow-hidden flex-shrink-0">
                  <img src={safeCover(track.cover)} alt={track.title} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <Play size={18} className="fill-white text-white" />
                  </div>
                </div>
                <div className="flex-1 overflow-hidden">
                  <span className="text-secondary text-[10px] font-bold uppercase tracking-widest">#{idx + 1}</span>
                  <h4 className="font-bold text-sm truncate">{track.title}</h4>
                  <p className="text-xs text-on-surface-variant truncate">{track.artist}</p>
                </div>
                <button onClick={(e) => { e.stopPropagation(); onLike(track); }} className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5">
                  <Heart size={16} className={likedIds.has(track.id) ? 'fill-primary text-primary' : 'text-on-surface-variant'} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Explore View ─────────────────────────────────────────────────────────────
function ExploreView({ onPlay, likedIds, onLike, onAddToQueue, onAddToPlaylist }: { onPlay: (t: Track, q: Track[]) => void; likedIds: Set<string>; onLike: (track: Track) => void; onAddToQueue: (t: Track) => void; onAddToPlaylist: (t: Track) => void }) {
  const [genreTracks, setGenreTracks] = useState<Track[]>([]);
  const [activeGenre, setActiveGenre] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadGenre = async (genre: typeof GENRES[0]) => {
    setActiveGenre(genre.name);
    setLoading(true);
    try {
      const tracks = await fetchByGenre(genre.query);
      setGenreTracks(tracks);
    } catch { /* ignore */ }
    setLoading(false);
  };

  return (
    <div className="space-y-12 sm:space-y-16 max-w-7xl mx-auto">
      <section>
        <h2 className="font-headline text-3xl sm:text-4xl font-extrabold tracking-tight mb-6 sm:mb-8">Browse Genres</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
          {GENRES.map((genre) => (
            <button
              key={genre.name}
              onClick={() => loadGenre(genre)}
              className={`aspect-square rounded-xl ${genre.color} p-5 sm:p-6 relative overflow-hidden cursor-pointer group shadow-lg transition-all hover:-translate-y-1 text-left ${activeGenre === genre.name ? 'ring-2 ring-white/40' : ''}`}
            >
              <h4 className="font-headline text-lg sm:text-xl font-extrabold text-white relative z-10">{genre.name}</h4>
              <div className="absolute -right-4 -bottom-4 w-24 h-24 bg-white/10 rounded-full blur-xl group-hover:scale-125 transition-transform" />
            </button>
          ))}
        </div>
      </section>

      {(activeGenre || loading) && (
        <section>
          <h2 className="font-headline text-xl sm:text-2xl font-bold mb-5 sm:mb-6">{activeGenre}</h2>
          {loading ? <LoadingState /> : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 sm:gap-5">
              {genreTracks.map((track) => (
                <TrackCard key={track.id} track={track} onPlay={() => onPlay(track, genreTracks)} liked={likedIds.has(track.id)} onLike={() => onLike(track)} onAddToQueue={() => onAddToQueue(track)} onAddToPlaylist={() => onAddToPlaylist(track)} />
              ))}
            </div>
          )}
        </section>
      )}

      {!activeGenre && !loading && (
        <section className="text-center py-16">
          <Music size={48} className="mx-auto text-on-surface-variant mb-4" />
          <p className="text-on-surface-variant">Pick a genre to discover tracks</p>
        </section>
      )}
    </div>
  );
}

// ─── Library View ─────────────────────────────────────────────────────────────
function LibraryView({ onPlay, likedIds, likedTracks, onLike, customPlaylists, onCreatePlaylist, onDeletePlaylist, onRemoveTrackFromPlaylist }: { onPlay: (t: Track, q: Track[]) => void; likedIds: Set<string>; likedTracks: Track[]; onLike: (track: Track) => void; customPlaylists: CustomPlaylist[]; onCreatePlaylist: (name: string) => void; onDeletePlaylist: (id: string) => void; onRemoveTrackFromPlaylist: (pid: string, tid: string) => void }) {
  const [tab, setTab] = useState<'playlists' | 'liked'>('playlists');
  const [viewingPlaylist, setViewingPlaylist] = useState<CustomPlaylist | null>(null);
  const [trending, setTrending] = useState<Track[]>([]);

  // Update viewingPlaylist dynamically if customPlaylists changes
  useEffect(() => {
    if (viewingPlaylist) {
      const pl = customPlaylists.find(p => p.id === viewingPlaylist.id);
      if (pl) setViewingPlaylist(pl);
      else setViewingPlaylist(null);
    }
  }, [customPlaylists, viewingPlaylist]);

  useEffect(() => {
    fetchTrending().then(setTrending).catch(console.error);
  }, []);

  if (viewingPlaylist) {
    return (
      <div className="space-y-6 max-w-7xl mx-auto">
        <button onClick={() => setViewingPlaylist(null)} className="flex items-center gap-2 text-on-surface-variant hover:text-white transition-colors">
          <ChevronLeft size={20} /> Back to Library
        </button>
        <div className="flex items-end gap-6 mb-10">
          <div className="w-32 h-32 sm:w-48 sm:h-48 bg-surface-container-high rounded-2xl flex items-center justify-center shrink-0 shadow-2xl border border-white/5">
            <ListMusic size={64} className="text-secondary" />
          </div>
          <div>
            <h2 className="font-headline font-extrabold text-4xl sm:text-6xl tracking-tighter">{viewingPlaylist.name}</h2>
            <p className="text-on-surface-variant mt-2">{viewingPlaylist.tracks.length} tracks</p>
            {viewingPlaylist.tracks.length > 0 && (
              <button onClick={() => onPlay(viewingPlaylist.tracks[0], viewingPlaylist.tracks)} className="mt-4 flex items-center gap-2 bg-secondary text-black font-bold px-6 py-2.5 rounded-full hover:scale-105 transition-transform">
                <Play size={18} fill="black" /> Play All
              </button>
            )}
          </div>
        </div>

        {viewingPlaylist.tracks.length === 0 ? (
          <p className="text-on-surface-variant text-center py-10">This playlist is empty. Browse and add some tracks!</p>
        ) : (
          <div className="space-y-2">
            {viewingPlaylist.tracks.map((track, i) => (
              <div key={`${track.id}-${i}`} className="flex items-center gap-4 p-3 rounded-xl hover:bg-surface-container transition-colors group cursor-pointer" onClick={() => onPlay(track, viewingPlaylist.tracks)}>
                <span className="text-on-surface-variant text-sm w-6 text-right shrink-0">{i + 1}</span>
                <img src={safeCover(track.cover)} alt={track.title} className="w-10 h-10 rounded-lg object-cover shrink-0" />
                <div className="flex-1 overflow-hidden">
                  <p className="font-bold text-sm truncate group-hover:text-secondary transition-colors">{track.title}</p>
                  <p className="text-xs text-on-surface-variant truncate">{track.artist}</p>
                </div>
                <span className="text-xs text-on-surface-variant shrink-0 hidden sm:block">{track.duration}</span>
                <button onClick={(e) => { e.stopPropagation(); onLike(track); }} className="p-1.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <Heart size={16} className={likedIds.has(track.id) ? 'fill-primary text-primary' : 'text-on-surface-variant'} />
                </button>
                <button onClick={(e) => { e.stopPropagation(); onRemoveTrackFromPlaylist(viewingPlaylist.id, track.id); }} className="p-1.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 hover:text-red-400">
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-10 sm:space-y-12 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/5 pb-5">
        <nav className="flex gap-6 sm:gap-10">
          {(['playlists', 'liked'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`font-headline font-bold text-lg sm:text-xl tracking-tight relative pb-1 transition-colors ${tab === t ? 'text-secondary after:content-[""] after:absolute after:-bottom-5 after:left-0 after:w-full after:h-0.5 after:bg-secondary' : 'text-on-surface-variant hover:text-white'}`}
            >
              {t === 'playlists' ? 'Playlists' : `Liked (${likedTracks.length})`}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'playlists' && (
        <>
          <section>
            <h2 className="font-headline font-extrabold text-2xl sm:text-3xl mb-6 tracking-tighter">Your Playlists</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
              <div 
                onClick={() => {
                  const name = prompt("Enter playlist name:");
                  if (name) onCreatePlaylist(name);
                }}
                className="h-48 rounded-xl border-2 border-dashed border-white/20 flex flex-col items-center justify-center gap-2 text-on-surface-variant hover:border-secondary hover:text-secondary transition-colors cursor-pointer group"
              >
                <Plus size={32} className="group-hover:scale-110 transition-transform" />
                <span className="font-bold">Create Playlist</span>
              </div>
              {customPlaylists.map(pl => (
                <div key={pl.id} onClick={() => setViewingPlaylist(pl)} className="relative group overflow-hidden rounded-xl h-48 bg-surface-container-high border border-white/5 flex flex-col justify-end p-5 cursor-pointer">
                  <div className="absolute top-4 right-4 z-10 opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
                    <button onClick={(e) => { e.stopPropagation(); onDeletePlaylist(pl.id); }} className="p-2 bg-black/50 hover:bg-red-500/80 rounded-full transition-colors text-white" title="Delete Playlist"><Trash2 size={16} /></button>
                  </div>
                  <div className="absolute inset-0 flex items-center justify-center opacity-10 group-hover:opacity-30 transition-opacity">
                    <ListMusic size={64} className="text-secondary" />
                  </div>
                  <div className="relative z-10 pointer-events-none">
                    <h3 className="text-xl font-bold truncate">{pl.name}</h3>
                    <p className="text-xs text-on-surface-variant">{pl.tracks.length} tracks</p>
                  </div>
                  {pl.tracks.length > 0 && (
                    <button onClick={(e) => { e.stopPropagation(); onPlay(pl.tracks[0], pl.tracks); }} className="absolute bottom-5 right-5 w-10 h-10 rounded-full bg-secondary text-black flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity translate-y-4 group-hover:translate-y-0 shadow-lg cursor-pointer z-20 hover:scale-105">
                      <Play size={16} className="ml-1" fill="black" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="font-headline font-extrabold text-2xl sm:text-3xl mb-6 tracking-tighter">Featured Playlists</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
              {MADE_FOR_YOU_SEEDS.slice(0, 2).map((seed) => (
                <div key={seed.id} className="relative group cursor-pointer overflow-hidden rounded-xl h-48 sm:h-64">
                  <img src={seed.cover} className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" alt={seed.title} referrerPolicy="no-referrer" />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />
                  <div className="absolute bottom-5 left-6">
                    {seed.tag && <span className="text-secondary font-bold text-[10px] tracking-widest uppercase mb-1 block">{seed.tag}</span>}
                    <h3 className="text-2xl sm:text-3xl font-black font-headline leading-none mb-1">{seed.title}</h3>
                    <p className="text-on-surface-variant text-xs">{seed.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="font-headline font-extrabold text-2xl sm:text-3xl mb-6 tracking-tighter">All Tracks</h2>
            <div className="space-y-2">
              {trending.slice(0, 10).map((track, i) => (
                <div key={track.id} className="flex items-center gap-4 p-3 rounded-xl hover:bg-surface-container transition-colors group cursor-pointer" onClick={() => onPlay(track, trending)}>
                  <span className="text-on-surface-variant text-sm w-6 text-right shrink-0">{i + 1}</span>
                  <img src={safeCover(track.cover)} alt={track.title} className="w-10 h-10 rounded-lg object-cover shrink-0" />
                  <div className="flex-1 overflow-hidden">
                    <p className="font-bold text-sm truncate group-hover:text-secondary transition-colors">{track.title}</p>
                    <p className="text-xs text-on-surface-variant truncate">{track.artist}</p>
                  </div>
                  <span className="text-xs text-on-surface-variant shrink-0 hidden sm:block">{track.duration}</span>
                  <button onClick={(e) => { e.stopPropagation(); onLike(track); }} className="p-1.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <Heart size={16} className={likedIds.has(track.id) ? 'fill-primary text-primary' : 'text-on-surface-variant'} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {tab === 'liked' && (
        <section>
          {likedTracks.length === 0 ? (
            <div className="text-center py-16">
              <Heart size={48} className="mx-auto text-on-surface-variant mb-4" />
              <p className="text-on-surface-variant">No liked tracks yet — heart some tracks!</p>
            </div>
          ) : (
            <div className="space-y-2">
              {likedTracks.map((track, i) => (
                <div key={track.id} className="flex items-center gap-4 p-3 rounded-xl hover:bg-surface-container transition-colors group cursor-pointer" onClick={() => onPlay(track, likedTracks)}>
                  <span className="text-on-surface-variant text-sm w-6 text-right shrink-0">{i + 1}</span>
                  <img src={safeCover(track.cover)} alt={track.title} className="w-10 h-10 rounded-lg object-cover shrink-0" />
                  <div className="flex-1 overflow-hidden">
                    <p className="font-bold text-sm truncate group-hover:text-secondary transition-colors">{track.title}</p>
                    <p className="text-xs text-on-surface-variant truncate">{track.artist}</p>
                  </div>
                  <span className="text-xs text-on-surface-variant shrink-0 hidden sm:block">{track.duration}</span>
                  <button onClick={(e) => { e.stopPropagation(); onLike(track); }} className="p-1.5 shrink-0">
                    <Heart size={16} className="fill-primary text-primary" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ─── Premium View ─────────────────────────────────────────────────────────────
function PremiumView() {
  const plans = [
    { name: 'Free', price: '$0', features: ['30-second previews', 'Standard quality', 'Ads between tracks', 'Basic queue'] },
    { name: 'Pro', price: '$9.99', features: ['Full tracks via iTunes', 'High-fidelity 320kbps', 'Unlimited skips', 'Offline mode', 'No ads'], highlight: true },
    { name: 'Lossless', price: '$19.99', features: ['Everything in Pro', 'Lossless FLAC audio', 'Spatial audio', 'Unlimited devices', 'Priority support'] },
  ];
  return (
    <div className="max-w-4xl mx-auto space-y-12 py-4">
      <div className="text-center">
        <span className="text-secondary font-bold text-xs tracking-[0.3em] uppercase">Upgrade</span>
        <h2 className="font-headline text-4xl sm:text-6xl font-extrabold tracking-tighter mt-2">Go Premium</h2>
        <p className="text-on-surface-variant mt-3">Unlock the full sonic experience</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        {plans.map((plan) => (
          <div key={plan.name} className={`p-6 rounded-2xl border flex flex-col gap-4 ${plan.highlight ? 'border-primary bg-primary/10 ring-1 ring-primary/30' : 'border-white/10 bg-surface-container'}`}>
            {plan.highlight && <span className="text-[10px] font-black tracking-widest uppercase text-primary">Most Popular</span>}
            <div>
              <h3 className="font-headline font-extrabold text-2xl">{plan.name}</h3>
              <p className="text-3xl font-bold mt-1">{plan.price}<span className="text-sm text-on-surface-variant font-normal">/mo</span></p>
            </div>
            <ul className="space-y-2 flex-1">
              {plan.features.map((f) => (
                <li key={f} className="text-sm text-on-surface-variant flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-secondary shrink-0" />{f}
                </li>
              ))}
            </ul>
            <button className={`w-full py-3 rounded-full font-bold text-sm transition-all ${plan.highlight ? 'pulse-button' : 'bg-surface-container-high hover:bg-surface-bright'}`}>
              {plan.name === 'Free' ? 'Current Plan' : 'Upgrade'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Now Playing View ─────────────────────────────────────────────────────────
function NowPlayingView({
  track, isPlaying, isBuffering, progress, currentTime, duration,
  isShuffled, isRepeating, liked,
  onTogglePlay, onNext, onPrev, onSeek,
  onToggleShuffle, onToggleRepeat, onLike, onAddToPlaylist, onBack,
  lyrics, lyricsLoading, showLyrics, onToggleLyrics,
  queue, onPlayFromQueue, onRemoveFromQueue
}: {
  track: Track; isPlaying: boolean; isBuffering: boolean; progress: number;
  currentTime: number; duration: number;
  isShuffled: boolean; isRepeating: boolean; liked: boolean;
  onTogglePlay: () => void; onNext: () => void; onPrev: () => void;
  onSeek: (e: React.MouseEvent<HTMLDivElement>) => void;
  onToggleShuffle: () => void; onToggleRepeat: () => void;
  onLike: () => void; onAddToPlaylist: () => void; onBack: () => void;
  lyrics: string; lyricsLoading: boolean; showLyrics: boolean; onToggleLyrics: () => void;
  queue: Track[]; onPlayFromQueue: (idx: number) => void; onRemoveFromQueue: (idx: number) => void;
}) {
  const [activeTab, setActiveTab] = useState<'player' | 'queue' | 'lyrics'>('player');
  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  return (
    <div className="fixed inset-0 z-[60] bg-surface overflow-y-auto no-scrollbar">
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <img src={safeCover(track.cover)} className="w-full h-full object-cover opacity-20 blur-[120px] scale-150" alt="" referrerPolicy="no-referrer" />
        <div className="absolute inset-0 bg-gradient-to-b from-surface/40 via-surface/80 to-surface" />
      </div>

      <div className="relative z-10 min-h-screen flex flex-col p-6 sm:p-10 lg:p-16">
        <header className="flex justify-between items-center mb-8 sm:mb-12">
          <button onClick={onBack} className="p-3 glass-panel rounded-full hover:bg-white/10 transition-colors">
            <ChevronLeft size={20} />
          </button>
          <div className="flex bg-surface-container rounded-full p-1">
            <button onClick={() => setActiveTab('player')} className={`px-4 py-1.5 rounded-full text-xs font-bold transition-colors ${activeTab === 'player' ? 'bg-white text-black' : 'text-on-surface-variant hover:text-white'}`}>Player</button>
            <button onClick={() => setActiveTab('lyrics')} className={`px-4 py-1.5 rounded-full text-xs font-bold transition-colors ${activeTab === 'lyrics' ? 'bg-white text-black' : 'text-on-surface-variant hover:text-white'}`}>Lyrics</button>
            <button onClick={() => setActiveTab('queue')} className={`px-4 py-1.5 rounded-full text-xs font-bold transition-colors ${activeTab === 'queue' ? 'bg-white text-black' : 'text-on-surface-variant hover:text-white'}`}>Queue</button>
          </div>
          <button onClick={() => setActiveTab(t => t === 'queue' ? 'player' : 'queue')} className={`p-3 glass-panel rounded-full hover:bg-white/10 transition-colors ${activeTab === 'queue' ? 'text-secondary' : 'text-white'}`}>
            <ListMusic size={20} />
          </button>
        </header>

        {activeTab === 'player' && (
          <div className="flex-1 flex flex-col lg:flex-row items-center justify-center gap-10 sm:gap-16 lg:gap-24 max-w-6xl mx-auto w-full">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              className="w-full max-w-xs sm:max-w-sm aspect-square rounded-2xl overflow-hidden shadow-[0_40px_120px_rgba(0,0,0,0.8)] border border-white/5 shrink-0"
            >
              <img src={safeCover(track.cover)} alt={track.title} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
            </motion.div>

          <div className="w-full max-w-xl space-y-8 sm:space-y-10">
            <div className="flex items-start justify-between gap-4">
              <div className="overflow-hidden">
                <h1 className="font-headline font-extrabold text-3xl sm:text-5xl lg:text-6xl tracking-tighter leading-none mb-2">{track.title}</h1>
                <h2 className="font-headline font-medium text-lg sm:text-2xl text-primary/80">{track.artist}</h2>
                {track.album && <p className="text-sm text-on-surface-variant mt-1">{track.album}</p>}
              </div>
              <div className="flex items-center gap-1 mt-1 shrink-0">
                <button onClick={onAddToPlaylist} className="p-2 text-on-surface-variant hover:text-white transition-colors" title="Add to Playlist">
                  <Plus size={24} />
                </button>
                <button onClick={onLike} className="p-2 shrink-0">
                  <Heart size={24} className={liked ? 'fill-primary text-primary' : 'text-on-surface-variant hover:text-white'} />
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <div className="relative h-1.5 w-full bg-white/10 rounded-full overflow-hidden cursor-pointer group" onClick={onSeek}>
                <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary to-secondary rounded-full shadow-[0_0_15px_rgba(182,160,255,0.4)] transition-all" style={{ width: `${progress * 100}%` }} />
              </div>
              <div className="flex justify-between text-[10px] font-black tracking-[0.2em] text-on-surface-variant uppercase">
                <span>{fmtTime(currentTime)}</span>
                <span>{fmtTime(duration || 0)}</span>
              </div>
            </div>

            <div className="flex items-center justify-between px-2">
              <button onClick={onToggleShuffle} className={`transition-colors ${isShuffled ? 'text-secondary' : 'text-on-surface-variant hover:text-white'}`}>
                <Shuffle size={22} />
              </button>
              <div className="flex items-center gap-6 sm:gap-8">
                <button onClick={onPrev} className="text-white hover:text-primary transition-all active:scale-90">
                  <SkipBack size={32} />
                </button>
                <button onClick={onTogglePlay} className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-white flex items-center justify-center text-black shadow-2xl hover:scale-105 active:scale-95 transition-all">
                  {isBuffering ? (
                    <Loader2 size={40} className="animate-spin" />
                  ) : isPlaying ? (
                    <Pause size={32} fill="black" />
                  ) : (
                    <Play size={32} fill="black" className="ml-1" />
                  )}
                </button>
                <button onClick={onNext} className="text-white hover:text-primary transition-all active:scale-90">
                  <SkipForward size={32} />
                </button>
              </div>
              <button onClick={onToggleRepeat} className={`transition-colors ${isRepeating ? 'text-secondary' : 'text-on-surface-variant hover:text-white'}`}>
                <Repeat size={22} />
              </button>
            </div>

            {!track.preview && (
              <p className="text-center text-xs text-on-surface-variant bg-surface-container rounded-lg px-4 py-2">
                No preview available for this track
              </p>
            )}
          </div>
        </div>
        )}

        {activeTab === 'lyrics' && (
          <div className="flex-1 overflow-y-auto no-scrollbar max-w-2xl mx-auto w-full pb-32">
            <h2 className="text-2xl font-bold mb-6 font-headline tracking-tighter">Lyrics</h2>
            {lyricsLoading ? (
              <div className="flex items-center justify-center gap-3 text-secondary py-12">
                <Loader2 size={24} className="animate-spin" />
                <span className="font-medium animate-pulse">Finding lyrics...</span>
              </div>
            ) : lyrics ? (
              <div className="space-y-6 text-2xl sm:text-3xl leading-relaxed font-bold tracking-tight text-white/90 pb-20">
                {lyrics.split('\n').map((line, i) => (
                  <p key={i} className={line.trim() ? "hover:text-secondary hover:scale-[1.02] transform-origin-left transition-all duration-300 cursor-default" : ""}>
                    {line.trim() ? line : <br />}
                  </p>
                ))}
              </div>
            ) : (
              <div className="p-10 bg-surface-container rounded-2xl flex flex-col items-center justify-center gap-4 text-center mt-12">
                <Mic2 size={48} className="text-white/20 mb-2" />
                <div>
                  <p className="font-bold text-xl mb-2">No lyrics available</p>
                  <p className="text-sm text-on-surface-variant max-w-sm mb-4">We couldn't find lyrics for this track from our sources.</p>
                  <a
                    href={`https://www.google.com/search?q=${encodeURIComponent(track.title + ' ' + track.artist + ' lyrics')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-5 py-2.5 bg-white/10 hover:bg-white/20 border border-white/10 rounded-full text-sm font-bold text-white transition-all hover:scale-105"
                  >
                    <ExternalLink size={16} />
                    Search on Google
                  </a>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'queue' && (
          <div className="flex-1 overflow-y-auto no-scrollbar max-w-2xl mx-auto w-full pb-32 space-y-4">
            <h2 className="text-2xl font-bold mb-6 font-headline tracking-tighter flex items-center gap-3">
              Up Next
              <span className="text-sm font-medium text-on-surface-variant bg-surface-container px-3 py-1 rounded-full">{queue.length} tracks</span>
            </h2>
            {queue.length === 0 ? (
              <div className="p-10 border-2 border-dashed border-white/10 rounded-2xl flex flex-col items-center justify-center gap-4 text-center mt-6">
                <ListMusic size={48} className="text-white/20" />
                <div>
                  <p className="font-bold text-xl mb-2">Queue is empty</p>
                  <p className="text-sm text-on-surface-variant">Add some tracks to keep the music flowing</p>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {queue.map((t, i) => (
                  <div key={`${t.id}-${i}`} className="flex items-center gap-4 p-3 rounded-xl bg-surface-container/50 hover:bg-surface-container transition-colors group">
                    <span className="text-xs font-medium text-on-surface-variant w-6 text-center shrink-0">{i + 1}</span>
                    <div className="relative shrink-0">
                      <img src={safeCover(t.cover)} alt={t.title} className="w-12 h-12 rounded-lg object-cover" />
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center rounded-lg">
                        <button onClick={() => onPlayFromQueue(i)} className="text-white hover:text-secondary hover:scale-110 shadow-lg transition-all rounded-full bg-black/50 p-1">
                          <Play size={14} fill="currentColor" className="ml-0.5" />
                        </button>
                      </div>
                    </div>
                    <div className="flex-1 min-w-0 pr-2">
                      <p className="font-bold truncate text-sm text-white/90 group-hover:text-white transition-colors">{t.title}</p>
                      <p className="text-xs text-on-surface-variant truncate">{t.artist}</p>
                    </div>
                    <button onClick={() => onRemoveFromQueue(i)} className="p-2 text-on-surface-variant opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-white/5 rounded-full transition-all shrink-0">
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Player Dock ──────────────────────────────────────────────────────────────
function PlayerDock({
  track, isPlaying, isBuffering, progress, currentTime, duration, volume, liked,
  onTogglePlay, onNext, onPrev, onSeek, onVolumeChange, onLike, onOpenFull,
}: {
  track: Track; isPlaying: boolean; isBuffering: boolean; progress: number;
  currentTime: number; duration: number; volume: number; liked: boolean;
  onTogglePlay: () => void; onNext: () => void; onPrev: () => void;
  onSeek: (e: React.MouseEvent<HTMLDivElement>) => void;
  onVolumeChange: (v: number) => void; onLike: () => void; onOpenFull: () => void;
}) {
  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  return (
    <div className="fixed bottom-16 lg:bottom-6 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-4xl glass-panel rounded-2xl sm:rounded-full z-50 shadow-2xl">
      <div className="flex items-center gap-2 sm:gap-4 px-3 sm:px-5 h-16 sm:h-18">
        {/* Track Info */}
        <div className="flex items-center gap-2 sm:gap-3 w-1/3 min-w-0 cursor-pointer" onClick={onOpenFull}>
          <div className="w-9 h-9 sm:w-11 sm:h-11 rounded-lg overflow-hidden flex-shrink-0 shadow-md">
            <img src={safeCover(track.cover)} alt={track.title} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
          </div>
          <div className="overflow-hidden hidden sm:block">
            <p className="font-bold text-xs truncate">{track.title}</p>
            <p className="text-[10px] text-on-surface-variant uppercase tracking-wide truncate">{track.artist}</p>
          </div>
        </div>

        {/* Controls + Progress */}
        <div className="flex flex-col items-center gap-1 flex-1 min-w-0">
          <div className="flex items-center gap-3 sm:gap-5">
            <button onClick={onPrev} className="text-on-surface-variant hover:text-white transition-colors hidden sm:block">
              <SkipBack size={16} />
            </button>
            <button onClick={onTogglePlay} className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-white flex items-center justify-center text-black hover:scale-105 transition-transform shadow relative">
              {isBuffering ? (
                <Loader2 size={16} className="animate-spin" />
              ) : isPlaying ? (
                <Pause size={16} fill="black" />
              ) : (
                <Play size={16} fill="black" className="ml-0.5" />
              )}
            </button>
            <button onClick={onNext} className="text-on-surface-variant hover:text-white transition-colors hidden sm:block">
              <SkipForward size={16} />
            </button>
          </div>
          <div className="flex items-center gap-2 w-full max-w-xs">
            <span className="text-[9px] text-on-surface-variant shrink-0">{fmtTime(currentTime)}</span>
            <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden cursor-pointer" onClick={onSeek}>
              <div className="h-full bg-secondary shadow-[0_0_8px_rgba(0,227,253,0.4)] transition-all" style={{ width: `${progress * 100}%` }} />
            </div>
            <span className="text-[9px] text-on-surface-variant shrink-0">{fmtTime(duration)}</span>
          </div>
        </div>

        {/* Right Controls */}
        <div className="flex items-center justify-end gap-2 sm:gap-3 w-1/3">
          <button onClick={onLike} className="hidden sm:block">
            <Heart size={15} className={liked ? 'fill-primary text-primary' : 'text-on-surface-variant hover:text-white'} />
          </button>
          <div className="hidden md:flex items-center gap-2 group">
            <Volume2 size={15} className="text-on-surface-variant" />
            <input
              type="range" min="0" max="1" step="0.01" value={volume}
              onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
              className="w-16 accent-primary cursor-pointer"
            />
          </div>
          <button onClick={onOpenFull} className="text-on-surface-variant hover:text-white">
            <Maximize2 size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Reusable Components ──────────────────────────────────────────────────────
function TrackCard({ track, onPlay, liked, onLike, onAddToQueue, onAddToPlaylist }: { track: Track; onPlay: () => void; liked: boolean; onLike: () => void; onAddToQueue?: () => void; onAddToPlaylist?: () => void }) {
  const [showMenu, setShowMenu] = useState(false);
  return (
    <div className="flex-shrink-0 group cursor-pointer w-36 sm:w-44" onClick={onPlay}>
      <div className="relative aspect-square rounded-lg overflow-hidden mb-3 shadow-xl transition-transform duration-300 group-hover:scale-105" onMouseLeave={() => setShowMenu(false)}>
        <img src={safeCover(track.cover)} alt={track.title} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <Play className="fill-white text-white" size={36} />
        </div>
        <button onClick={(e) => { e.stopPropagation(); onLike(); }} className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity p-1">
          <Heart size={14} className={liked ? 'fill-primary text-primary' : 'text-white'} />
        </button>
        {(onAddToQueue || onAddToPlaylist) && (
          <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }} className="p-1 glass-panel rounded-full hover:bg-white/20">
              <MoreHorizontal size={14} className="text-white" />
            </button>
            {showMenu && (
              <div className="absolute bottom-full right-0 mb-1 glass-panel rounded-lg py-1 w-36 shadow-lg border border-white/10 z-10 flex flex-col items-start origin-bottom-right animate-in fade-in zoom-in-95 duration-200">
                {onAddToQueue && (
                  <button onClick={(e) => { e.stopPropagation(); onAddToQueue(); setShowMenu(false); }} className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/10 flex items-center gap-2 text-white">
                    <ListMusic size={12} /> Add to Queue
                  </button>
                )}
                {onAddToPlaylist && (
                  <button onClick={(e) => { e.stopPropagation(); onAddToPlaylist(); setShowMenu(false); }} className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/10 flex items-center gap-2 text-white">
                    <Plus size={12} /> Add to Playlist
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <h4 className="font-bold text-xs sm:text-sm truncate">{track.title}</h4>
      <p className="text-[11px] sm:text-xs text-on-surface-variant font-medium truncate">{track.artist}</p>
    </div>
  );
}

function SidebarLink({ icon, label, active, onClick }: { icon: ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`w-full flex items-center gap-4 px-4 py-3 rounded-xl transition-all duration-200 group ${active ? 'text-primary font-bold bg-gradient-to-r from-primary/10 to-transparent' : 'text-on-surface-variant hover:text-white hover:bg-white/5'}`}>
      <span className={active ? 'text-primary' : 'group-hover:scale-110 transition-transform'}>{icon}</span>
      <span className="font-headline text-sm tracking-wide">{label}</span>
    </button>
  );
}

function MobileNavLink({ icon, label, active, onClick }: { icon: ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`flex flex-col items-center justify-center gap-0.5 transition-all min-w-0 ${active ? 'text-secondary scale-110' : 'text-on-surface-variant'}`}>
      {icon}
      <span className="text-[9px] font-bold uppercase tracking-tight">{label}</span>
    </button>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4 text-on-surface-variant">
      <Loader2 size={32} className="animate-spin text-primary" />
      <p className="text-sm font-medium">Loading tracks…</p>
    </div>
  );
}

function AddToPlaylistModal({ track, customPlaylists, onCreatePlaylist, onAdd, onClose }: { track: Track; customPlaylists: CustomPlaylist[]; onCreatePlaylist: (name: string) => void; onAdd: (playlistId: string, track: Track) => void; onClose: () => void }) {
  const [newName, setNewName] = useState('');
  return (
    <div className="fixed inset-0 bg-black/80 z-[100] flex items-center justify-center p-4">
      <div className="bg-surface-container rounded-2xl w-full max-w-sm overflow-hidden flex flex-col shadow-2xl shrink-0 pointer-events-auto">
        <div className="flex justify-between items-center p-4 border-b border-white/5">
          <h3 className="font-headline font-bold text-lg">Add to Playlist</h3>
          <button onClick={onClose} className="p-1 hover:bg-white/10 rounded-full"><X size={20} className="text-white" /></button>
        </div>
        <div className="p-4 space-y-4 max-h-96 overflow-y-auto">
          {customPlaylists.length === 0 ? (
            <p className="text-on-surface-variant text-sm text-center">No playlists yet.</p>
          ) : (
            <div className="space-y-2">
              {customPlaylists.map(pl => (
                <button key={pl.id} onClick={() => { onAdd(pl.id, track); onClose(); }} className="w-full flex items-center gap-3 p-3 hover:bg-white/5 rounded-xl transition-colors text-left group">
                  <div className="w-12 h-12 bg-surface-container-high rounded-lg flex items-center justify-center shrink-0">
                    <ListMusic size={20} className="text-on-surface-variant group-hover:text-secondary transition-colors" />
                  </div>
                  <div className="text-left flex-1 min-w-0">
                    <p className="font-bold truncate group-hover:text-white text-on-surface-variant transition-colors">{pl.name}</p>
                    <p className="text-xs text-on-surface-variant">{pl.tracks.length} tracks</p>
                  </div>
                  {pl.tracks.find(t => t.id === track.id) && <span className="text-xs text-primary font-bold">Added</span>}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 pt-2 border-t border-white/5">
            <input type="text" value={newName} onChange={e => setNewName(e.target.value)} placeholder="New playlist name..." className="flex-1 bg-surface-bright/50 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-secondary transition-colors text-white placeholder-white/30" />
            <button onClick={() => { if (newName.trim()) { onCreatePlaylist(newName.trim()); setNewName(''); } }} disabled={!newName.trim()} className="bg-secondary text-black p-2 rounded-lg disabled:opacity-50"><Plus size={20} /></button>
          </div>
        </div>
      </div>
    </div>
  );
}
