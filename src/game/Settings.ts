export interface Settings {
  sensitivity: number;
  invertY: boolean;
  volume: number;
  brightness: number;
  pixelHeight: number;
  textSpeed: number;
  fov: number;
}

const KEY = 'kao.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 1,
  invertY: false,
  volume: 0.8,
  brightness: 1.15,
  pixelHeight: 360,
  textSpeed: 1,
  fov: 70,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* private mode or corrupted */ }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
