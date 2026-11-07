/** Room left at the panel's right edge when the page's scrollbar floats over it. */
export const HELP_PANEL_OVERLAY_GUTTER = 16;

/**
 * Whether this browser draws scrollbars over the content instead of beside it
 * (Windows 11's thin scrollbars, macOS and Linux with "hide scrollbars"). A
 * classic scrollbar takes layout width, so a scroll box's `offsetWidth` is wider
 * than its `clientWidth`; an overlay one takes none, measured with a scroll box
 * nobody sees.
 *
 * Not cached: the answer is the system's setting and it can change under a
 * running page (macOS switches when a mouse is plugged in), so the panel asks
 * once each time it mounts, which is when it matters.
 */
export function scrollbarsOverlay(): boolean {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;visibility:hidden';
  document.body.appendChild(probe);
  const overlay = probe.offsetWidth - probe.clientWidth === 0;
  probe.remove();
  return overlay;
}
