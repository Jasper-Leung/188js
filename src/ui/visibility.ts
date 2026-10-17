import { actionOf } from '../core/keymap';
import { onLangChange, t } from '../i18n';
import { button, el, setShown, setText } from './dom';

/** Only presentation preferences persist. A new session always has a visible exit. */
const MODULES = ['items', 'tasks', 'actions', 'map'] as const;
type Module = typeof MODULES[number];
const STORE = 'gift188-ui-modules';

export class HudVisibility {
  readonly root = el('div', 'g-visibility g-hidden');
  private hide: HTMLButtonElement;
  private customize: HTMLButtonElement;
  private panel = el('div', 'g-visibility-panel g-hidden');
  private hint = el('p', 'g-note');
  private toggles = new Map<Module, HTMLButtonElement>();
  private hidden = new Set<Module>();
  private clean = false;
  private unbindLang: () => void;

  constructor(private parent: HTMLElement, private releaseActions: () => void) {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(STORE) ?? '[]');
      if (Array.isArray(saved)) for (const id of MODULES) if (saved.includes(id)) this.hidden.add(id);
    } catch { /* Private browsing still supports session preferences. */ }
    this.hide = button('', { cls: 'g-visibility-hide', onClick: () => this.setClean(!this.clean) });
    this.customize = button('', { onClick: () => {
      const open = this.panel.classList.contains('g-hidden');
      setShown(this.panel, open);
      this.customize.setAttribute('aria-expanded', String(open));
    } });
    this.panel.setAttribute('role', 'group');
    for (const id of MODULES) {
      const toggle = button('', { onClick: () => {
        if (this.hidden.has(id)) this.hidden.delete(id); else this.hidden.add(id);
        this.applyModules();
        try { localStorage.setItem(STORE, JSON.stringify([...this.hidden])); } catch { /* optional */ }
      } });
      this.toggles.set(id, toggle);
      this.panel.appendChild(toggle);
    }
    this.panel.appendChild(this.hint);
    this.root.appendChild(this.hide);
    this.root.appendChild(this.customize);
    this.root.appendChild(this.panel);
    parent.appendChild(this.root);
    window.addEventListener('keydown', this.onKey, true);
    this.unbindLang = onLangChange(() => this.sync());
    this.applyModules();
    this.sync();
  }

  setClean(on: boolean): void {
    this.clean = on;
    this.releaseActions();
    this.parent.classList.toggle('is-clean', on);
    setShown(this.panel, false);
    this.customize.setAttribute('aria-expanded', 'false');
    this.sync();
  }

  setAvailable(on: boolean): void {
    if (!on && this.clean) this.setClean(false);
    setShown(this.root, on);
  }

  private applyModules(): void {
    for (const id of MODULES) {
      this.parent.dataset[`hide${id[0].toUpperCase()}${id.slice(1)}`] = String(this.hidden.has(id));
      this.toggles.get(id)?.setAttribute('aria-pressed', String(!this.hidden.has(id)));
    }
    this.releaseActions();
  }

  private sync(): void {
    setText(this.hide, t(this.clean ? 'ui_show_all' : 'ui_hide_all'));
    this.hide.title = t('ui_restore_hint', { key: actionOf('KeyH') ? 'Shift+H' : 'H' });
    this.hide.setAttribute('aria-label', t(this.clean ? 'ui_show_all' : 'ui_hide_all'));
    setText(this.customize, t('ui_customize'));
    this.panel.setAttribute('aria-label', t('ui_customize'));
    for (const [id, b] of this.toggles) setText(b, t(`ui_module_${id}`));
    setText(this.hint, t('ui_restore_hint', { key: actionOf('KeyH') ? 'Shift+H' : 'H' }));
  }

  private onKey = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if ((actionOf(e.code) && !e.shiftKey) || e.code !== 'KeyH' || e.repeat || e.ctrlKey || e.metaKey || e.altKey ||
        target?.closest?.('input, textarea, select, [contenteditable="true"]') ||
        this.root.classList.contains('g-hidden')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    this.setClean(!this.clean);
  };

  dispose(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.unbindLang(); this.root.remove();
  }
}
