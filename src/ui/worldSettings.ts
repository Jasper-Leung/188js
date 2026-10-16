import { t } from '../i18n';
import { DayClock, saveClockSettings, type ClockSettings } from '../core/dayClock';
import { button, el } from './dom';
export function worldSettings(clock: DayClock): HTMLElement & { refresh(): void } {
  const root = el('div', 'g-world-settings');
  const build = () => {
    root.textContent = '';
    root.appendChild(el('h3', '', t('clock_title')));
    const s = clock.settings;
    const patch = (p: Partial<ClockSettings>) => { clock.configure(p); saveClockSettings(clock.settings); build(); };
    root.appendChild(button(t(s.mode === 'cycle' ? 'clock_cycle' : 'clock_realtime'), { onClick: () => patch({ mode: s.mode === 'cycle' ? 'realtime' : 'cycle' }) }));
    for (const [key, value, min, max, step] of [['cycleSeconds',s.cycleSeconds,30,86400,30], ['speed',s.speed,0.1,20,0.1], ['offsetHours',s.offsetHours,-24,24,0.5]] as const) {
      const label = el('label', 'g-clock-field', t(`clock_${key}`));
      const input = document.createElement('input'); input.type = 'number'; input.value = String(value); input.min = String(min); input.max = String(max); input.step = String(step);
      input.addEventListener('change', () => { if (input.value.trim() !== '' && Number.isFinite(input.valueAsNumber)) patch({ [key]: input.valueAsNumber }); });
      label.appendChild(input); root.appendChild(label);
    }
    root.appendChild(button(t(s.paused ? 'clock_resume' : 'clock_pause'), { onClick: () => patch({ paused: !s.paused }) }));
    const label = el('label', 'g-clock-field', t('clock_fixed'));
    const select = document.createElement('select');
    for (const h of [-1, 5, 8, 12, 18, 22]) { const opt = document.createElement('option'); opt.value = String(h); opt.textContent = h < 0 ? t('clock_live') : `${h}:00`; select.appendChild(opt); }
    select.value = String(s.fixedHour ?? -1);
    select.addEventListener('change', () => patch({ fixedHour: Number(select.value) < 0 ? null : Number(select.value) }));
    label.appendChild(select); root.appendChild(label); root.appendChild(el('p', 'g-note', t('clock_hint')));
  };
  build(); return Object.assign(root, { refresh: build });
}
