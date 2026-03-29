export interface Track {
  id: string;
  title: string;
  artist: string;
  cover: string;
  duration: string;
  album?: string;
  preview?: string | null;
  genre?: string;
}

export interface Playlist {
  id: string;
  title: string;
  description: string;
  cover: string;
  trackCount: number;
  type: 'playlist' | 'album' | 'mix';
  tag?: string;
}

export type NavItem = 'home' | 'explore' | 'library' | 'premium' | 'now-playing';
