/** v1.0.2 世界体验配置。叙事天数仍由 GameStateManager 管理。 */
export const WORLD_EXPERIENCE = {
  clock: { mode: 'cycle' as 'cycle' | 'realtime', cycleSeconds: 300, speed: 1, offsetHours: 0, paused: false, fixedHour: null as number | null, startHour: 8 },
  rural: { seed: 188102, lampSpacing: 44, villageSpacing: 22, lampOffset: 8.4, lampHeight: 5.6, lightRadius: 4.2, poolOpacity: .28, haloOpacity: .24, keepout: 10, postSpacing: 18, fieldSpacing: 42, fieldOffset: 33, viewDistance: [100, 170, 240] as const },
  station: { roadsideOffset: 16, qinClearRadius: 30 },
} as const;
