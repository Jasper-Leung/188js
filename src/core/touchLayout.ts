export type TouchHand = 'right' | 'left';
const KEY = 'gift188.touchhand';
export function touchHand(): TouchHand { try { return localStorage.getItem(KEY) === 'left' ? 'left' : 'right'; } catch { return 'right'; } }
export function setTouchHand(hand: TouchHand): void {
  try { localStorage.setItem(KEY, hand); } catch { /* 可用但不持久 */ }
  window.dispatchEvent(new Event('gift188-touch-hand'));
}
export async function requestLandscape(): Promise<boolean> {
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    const orientation = screen.orientation as ScreenOrientation & { lock?: (mode: string) => Promise<void> };
    await orientation?.lock?.('landscape');
  } catch { /* iOS/WebView 可拒绝，旋转提示和普通触控始终保留 */ }
  return window.innerWidth >= window.innerHeight;
}
