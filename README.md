# 🎵 The Sonic Immersive

A premium Hi-Fi music player with a decoupled full-stack architecture. Features robust live search, dynamic full-length audio streaming, lyrics finding, and trending tracks – seamlessly running on a modern tech stack and 100% free with no API keys required.

## Features

- 🎧 **Full Audio Playback** — Streams full-length tracks seamlessly using a custom YouTube-DL backend audio proxy.
- ⏭️ **Zero-Lag Preloading** — Automatically pre-resolves audio URLs for upcoming tracks to ensure gapless playback.
- 🎤 **Lyrics Integration** — robust multi-provider lyrics lookup system with a dynamic fallback to Google Search if lyrics are unavailable.
- 🔍 **Live Search & Metadata** — Uses iTunes Search API for lightning-fast track metadata, accurate durations, and high-quality cover art.
- 📈 **Trending Tracks** — Pulled dynamically from Apple Music's Most Played RSS feed.
- 🔀 **Shuffle & Repeat** — Comprehensive playlist and queue management.
- 📱 **Fully Responsive** — Works beautifully and feels premium on mobile, tablet, and desktop visually powered by TailwindCSS and Framer Motion.

## Tech Stack

The project has been restructured into an independent frontend and backend to facilitate easy deployment on platforms like Vercel and Render.

### Frontend (`/frontend`)
- **Framework**: React 19 + TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS + Framer Motion + Lucide React
- **Integration**: Environment-based dynamic base URLs for the API backend (`VITE_API_BASE_URL`).

### Backend (`/backend`)
- **Environment**: Node.js + Express
- **Language**: TypeScript
- **Audio Streaming**: `yt-search` and `youtube-dl-exec` for audio resolution and proxying.
- **APIs Used**: iTunes Search API (Metadata), Apple Music RSS (Trending), multiple APIs for Lyrics (`api.lyrics.ovh`, `lyrist.vercel.app`, `api.popcat.xyz`, Vagalume).

## Getting Started

Because the application is split into two parts, you need to run both the frontend and the backend servers.

### 1. Start the Backend API

```bash
cd backend
npm install
npm run dev
```

The server will start on `http://localhost:3001`.
*(Optional: Copy `.env.example` to `.env` to override the port or define custom variables).*

### 2. Start the Frontend App

Open a new terminal window:

```bash
cd frontend
npm install
npm run dev
```

The UI will be available at `http://localhost:5173`. 

## Architecture

```text
┌─────────────────────────────────────────────┐
│  Browser (React + Vite)                     │
│  Base API URL: http://localhost:3001        │
└──────────────────┬──────────────────────────┘
                   │ HTTP GET /api/*
┌──────────────────▼──────────────────────────┐
│  Express Backend Server (:3001)             │
│  - GET /api/trending   (Apple RSS)          │
│  - GET /api/search     (iTunes Search API)  │
│  - GET /api/stream     (yt-search & yt-dlp) │
│  - GET /api/preload    (Audio caching)      │
│  - GET /api/lyrics     (Multi-provider)     │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  External APIs (iTunes, YouTube, Lyrics)    │
└─────────────────────────────────────────────┘
```

## Note on Playback & Lyrics

Unlike projects restricted to 30-second previews, **Sonic Immersive** dynamically searches for full-length audio tracks that match the iTunes metadata's exact duration and streams the audio buffer securely through the backend. The backend dynamically matches the best audio formats on the fly. 

Lyrics are fetched through multiple fallback mechanisms; if none match, the UI conveniently provides a one-click Google search fallback.
