import { WORLD_EXPERIENCE } from '../data/worldExperience';
export interface ClockSettings {
  mode: 'cycle' | 'realtime'; cycleSeconds: number; speed: number; offsetHours: number;
  paused: boolean; fixedHour: number | null; startHour: number;
}
const KEY = 'gift188.clock';
const wrap = (v: number) => ((v % 24) + 24) % 24;
const finite = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? v : fallback;
export function clockSettings(raw: Partial<ClockSettings> = {}): ClockSettings {
  const d = WORLD_EXPERIENCE.clock;
  const fixed = raw.fixedHour === undefined ? d.fixedHour : raw.fixedHour;
  return {
    mode: (raw.mode ?? d.mode) === 'realtime' ? 'realtime' : 'cycle',
    cycleSeconds: Math.max(30, Math.min(86400, finite(raw.cycleSeconds, d.cycleSeconds))),
    speed: Math.max(0.1, Math.min(20, finite(raw.speed, d.speed))),
    offsetHours: Math.max(-24, Math.min(24, finite(raw.offsetHours, d.offsetHours))),
    paused: (raw.paused ?? d.paused) === true,
    fixedHour: typeof fixed === 'number' && Number.isFinite(fixed) ? wrap(fixed) : null,
    startHour: wrap(finite(raw.startHour, d.startHour)),
  };
}
export class DayClock {
  settings: ClockSettings;
  private elapsed = 0;
  hour: number;
  constructor(settings: Partial<ClockSettings> = {}) { this.settings = clockSettings(settings); this.hour = this.settings.startHour; this.tick(0); }
  tick(dt: number, now = new Date()): number {
    const s = this.settings;
    if (s.fixedHour !== null) return this.hour = s.fixedHour;
    if (s.paused) return this.hour;
    if (s.mode === 'realtime') this.hour = wrap(now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600 + s.offsetHours);
    else {
      this.elapsed += Math.max(0, Number.isFinite(dt) ? dt : 0) * s.speed;
      this.hour = wrap(s.startHour + this.elapsed * 24 / s.cycleSeconds + s.offsetHours);
    }
    return this.hour;
  }
  configure(patch: Partial<ClockSettings>): void { this.settings = clockSettings({ ...this.settings, ...patch }); this.tick(0); }
}
export function loadClockSettings(): ClockSettings {
  try { return clockSettings(JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { return clockSettings(); }
}
export function saveClockSettings(s: ClockSettings): void { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 世界设置不可写不影响存档 */ } }
/** 连续的太阳高度、夜色和暮色，清晨/黄昏对称，午夜不产生负光强。 */
export function daylightAt(hour: number) {
  const angle = (wrap(hour) - 6) * Math.PI / 12;
  const elevation = Math.sin(angle);
  const day = Math.max(0, Math.min(1, (elevation + 0.12) / 0.42));
  const twilight = Math.max(0, 1 - Math.abs(elevation) / 0.32);
  return { angle, elevation, day, night: 1 - day, twilight };
}

export const worldClock = new DayClock(loadClockSettings());
