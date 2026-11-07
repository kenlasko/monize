/**
 * Whether a keyboard event's target is a field that consumes ordinary typing
 * (an input, a textarea, a select or anything `contenteditable`). A global
 * shortcut that uses a plain character -- `?` for help search -- checks this
 * first, so it never steals a question mark from a payee field.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  ) {
    return true;
  }
  // `isContentEditable` is the right check, but jsdom never implements the
  // editing spec it depends on, so a typed child of a rich text editor is
  // matched this way instead: closest() reads the attribute directly and
  // works the same in both.
  return target.closest('[contenteditable=""], [contenteditable="true"]') !== null;
}
