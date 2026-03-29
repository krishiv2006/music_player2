import { Track } from './types';

export interface CustomPlaylist {
  id: string;
  name: string;
  tracks: Track[];
  createdAt: number;
}

const KEYS = {
  liked: 'sonic_liked_tracks_v2', // Upgraded to store entire Track metadata
  playlists: 'sonic_playlists',
};

export function loadLiked(): Track[] {
  try {
    const d = localStorage.getItem(KEYS.liked);
    return d ? JSON.parse(d) : [];
  } catch { return []; }
}

export function saveLiked(liked: Track[]) {
  localStorage.setItem(KEYS.liked, JSON.stringify(liked));
}

export function loadPlaylists(): CustomPlaylist[] {
  try {
    const d = localStorage.getItem(KEYS.playlists);
    return d ? JSON.parse(d) : [];
  } catch { return []; }
}

export function savePlaylists(playlists: CustomPlaylist[]) {
  localStorage.setItem(KEYS.playlists, JSON.stringify(playlists));
}
