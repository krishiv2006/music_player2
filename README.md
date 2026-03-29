# 🎵 The Sonic Immersive

A premium Hi-Fi music player with a real backend powered by the **iTunes Search API** — 100% free, no API key required.

## Features

- 🎧 **Real audio playback** — 30-second iTunes previews via HTML5 Audio
- 🔍 **Live search** — Search any track or artist using the iTunes Search API
- 📈 **Trending tracks** — Pulled from Apple Music's Most Played RSS feed
- 🎭 **Genre browser** — Click any genre to explore matching tracks
- ❤️ **Liked tracks** — Heart tracks and view them in your Library
- 🔀 **Shuffle & Repeat** — Full queue management
- 📱 **Fully responsive** — Works beautifully on mobile, tablet, and desktop

## Free APIs Used

| API | What it does | Auth Required |
|-----|-------------|---------------|
| [iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/) | Search tracks + 30s previews + artwork | None ✅ |
| [Apple Music RSS Feed](https://rss.applemarketingtools.com/) | Most Played / Trending charts | None ✅ |

## Getting Started

```bash
# Install dependencies
npm install

# Start both the API server and Vite dev server
npm run dev
```

- Frontend: http://localhost:3000  
- API: http://localhost:3001

## Architecture

```
┌─────────────────────────────────────────────┐
│  Browser (React + Vite)   :3000             │
│  ┌─────────────────────────────────────┐    │
│  │  Vite proxy /api → localhost:3001   │    │
│  └─────────────────────────────────────┘    │
└──────────────────┬──────────────────────────┘
                   │ /api/*
┌──────────────────▼──────────────────────────┐
│  Express Server           :3001             │
│  GET /api/trending        iTunes RSS        │
│  GET /api/search?q=       iTunes Search     │
│  GET /api/genre/:genre    iTunes Search     │
│  GET /api/recommendations iTunes Search     │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  iTunes / Apple Music APIs (free, no key)   │
└─────────────────────────────────────────────┘
```

## Note on Previews

iTunes provides 30-second audio previews for most tracks. If a track shows "No preview available", it means Apple hasn't provided a preview URL for that particular track — this is uncommon but possible.
