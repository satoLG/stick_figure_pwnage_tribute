/**
 * The handful of choices that outlive a session. One object, written straight
 * through to storage whenever it changes, so the menu and everything it drives
 * can never disagree about what is set.
 */
export interface Settings {
  /** Indices into VOLUMES. */
  music: number;
  sfx: number;
  /** Index into AIM_SPEEDS. Only stick aiming has a speed to scale. */
  aimSpeed: number;
}

export const VOLUMES = [
  { name: 'OFF', v: 0 },
  { name: '25', v: 0.25 },
  { name: '50', v: 0.5 },
  { name: '75', v: 0.75 },
  { name: 'MAX', v: 1 },
];

export const AIM_SPEEDS = [
  { name: 'SLOW', k: 0.5 },
  { name: 'MED', k: 1 },
  { name: 'FAST', k: 1.8 },
];

// Music sits under everything else rather than over it: the sound this game
// is actually made of is the wall coming apart, so the track starts at a
// quarter and the player turns it up if they want it.
const DEFAULTS: Settings = { music: 1, sfx: 3, aimSpeed: 2 };
const STORE = 'pwnage.settings.v1';

const pick = (v: unknown, len: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(len - 1, Math.max(0, Math.round(v))) : fallback;

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return { ...DEFAULTS };
    const got = JSON.parse(raw) as Partial<Settings>;
    return {
      music: pick(got.music, VOLUMES.length, DEFAULTS.music),
      sfx: pick(got.sfx, VOLUMES.length, DEFAULTS.sfx),
      aimSpeed: pick(got.aimSpeed, AIM_SPEEDS.length, DEFAULTS.aimSpeed),
    };
  } catch {
    return { ...DEFAULTS };   // private mode, blocked storage: defaults still play
  }
}

export const settings: Settings = load();

export function saveSettings(): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(settings));
  } catch {
    /* Not being able to remember a choice is not worth failing over. */
  }
}

export const musicVolume = (): number => VOLUMES[settings.music].v;
export const sfxVolume = (): number => VOLUMES[settings.sfx].v;
export const aimSpeed = (): number => AIM_SPEEDS[settings.aimSpeed].k;
