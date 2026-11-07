/** Room left at the panel's right edge when the page's scrollbar floats over it. */
export const HELP_PANEL_OVERLAY_GUTTER = 16;

let overlay: boolean | undefined;

/**
 * Whether this browser draws scrollbars over the content instead of beside it
 * (Windows 11's thin scrollbars, macOS and Linux with "hide scrollbars"). A
 * classic scrollbar takes layout width, so a scroll box's `offsetWidth` is wider
 * than its `clientWidth`; an overlay one takes none. Asked once, with a scroll
 * box nobody sees, because the answer is the browser's, not the page's.
 */
export function scrollbarsOverlay(): boolean {
  if (overlay !== undefined) return overlay;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;visibility:hidden';
  document.body.appendChild(probe);
  overlay = probe.offsetWidth - probe.clientWidth === 0;
  probe.remove();
  return overlay;
}

/** Forgets the answer, for a test that changes what the browser reports. */
export function resetScrollbarProbe(): void {
  overlay = undefined;
}
