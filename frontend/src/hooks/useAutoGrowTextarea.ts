import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Size a textarea to its content: as tall as one line until the text has more,
 * then tall enough to show every line without a scrollbar. Re-fits when it
 * mounts (a saved multi-line note opens expanded) and whenever `value` changes
 * (typing, pasting, a quick fill). The reader can still drag it taller with
 * `resize-y`; the next change fits it again.
 */
export function fitTextareaToContent(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  // Nothing laid out (a hidden parent, or a DOM without layout): leave `auto`,
  // which is the textarea's own `rows` height.
  if (el.scrollHeight <= 0) return;
  // scrollHeight is the content box plus padding; the border-box height also
  // needs the borders, which are what offsetHeight adds over clientHeight.
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

/**
 * Returns a stable callback ref for the textarea. Merge it with any other ref
 * the element needs (a react-hook-form `register` ref); calling it again with
 * the same element is a no-op, so an inline merged ref costs no extra layout.
 */
export function useAutoGrowTextarea(
  value: string | null | undefined,
): (el: HTMLTextAreaElement | null) => void {
  const elRef = useRef<HTMLTextAreaElement | null>(null);

  const attach = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el || el === elRef.current) return;
    elRef.current = el;
    fitTextareaToContent(el);
  }, []);

  useLayoutEffect(() => {
    const el = elRef.current;
    if (el?.isConnected) fitTextareaToContent(el);
  }, [value]);

  return attach;
}
