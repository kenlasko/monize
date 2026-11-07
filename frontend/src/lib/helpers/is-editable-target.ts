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
  // editing spec it depends on, so the nearest contenteditable ancestor
  // (self included) is found directly instead; closest() works the same in
  // both. Its own value decides, not just whether one exists: a region
  // nested inside an editable ancestor can turn itself off with
  // `contenteditable="false"` (a non-editable @-mention chip inside a rich
  // text editor, say), and a bare `contenteditable` or `="true"` or
  // `="plaintext-only"` are all editable.
  const editable = target.closest('[contenteditable]');
  return editable !== null && editable.getAttribute('contenteditable') !== 'false';
}
