'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { quickAddApi } from '@/lib/quick-add';
import { createLogger } from '@/lib/logger';
import type { QuickAddInterpretation, QuickAddPins } from '@/types/quick-add';
import { hasPins } from './quick-add-chips';

const logger = createLogger('QuickAdd');

/** How long typing has to pause before the server is asked. */
export const QUICK_ADD_DEBOUNCE_MS = 200;

/**
 * `idle`: nothing to read. `pending`: the reading for what is on screen has not
 * arrived. `failed`: it was asked for and the request failed. `ready`: it is in.
 */
export type QuickAddReadingStatus = 'idle' | 'pending' | 'failed' | 'ready';

export interface QuickAddReadingInput {
  text: string;
  pins: QuickAddPins;
  /** YYYY-MM-DD, the reader's financial today. */
  today: string;
  contextAccountId?: string;
}

/** One answer, kept with the request that produced it; null is a failed request. */
interface Answer {
  key: string;
  interpretation: QuickAddInterpretation | null;
}

/** Everything that changes what the server would answer, pins in a fixed order. */
function requestKey({ text, pins, today, contextAccountId }: QuickAddReadingInput): string {
  const orderedPins = Object.keys(pins)
    .sort()
    .map((key) => [key, pins[key as keyof QuickAddPins]]);
  return JSON.stringify([text, today, contextAccountId ?? null, orderedPins]);
}

/** The key without the text: what a pin, the day or the account changes. */
function contextKey(input: QuickAddReadingInput): string {
  return requestKey({ ...input, text: '' });
}

/**
 * The server's reading of the line (`docs/future-plans/quick-add.md`, "When the
 * server is asked"). Typing asks once it pauses for `QUICK_ADD_DEBOUNCE_MS`; a
 * pin, the day or the account context asks at once. A response is kept with
 * the request that produced it, and one for a request that is no longer
 * current is dropped (`docs/frontend/api-and-cache.md`), so a slow answer to
 * an earlier line never lands under a later one.
 *
 * `interpretation` is the reading for what is on screen, and only that: it is
 * what Save and Full Form may act on. `shown` is the last reading that
 * arrived, which may stay on screen marked stale while a newer one is on its
 * way; it is never actionable. A failed request is `failed`, never an empty
 * reading.
 */
export function useQuickAddInterpretation(input: QuickAddReadingInput) {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [lastReading, setLastReading] = useState<QuickAddInterpretation | null>(null);
  // Bumped by Try Again, so the same request is asked once more.
  const [attempt, setAttempt] = useState(0);
  const key = `${requestKey(input)}#${attempt}`;
  const context = `${contextKey(input)}#${attempt}`;
  const isEmpty = input.text.trim() === '' && !hasPins(input.pins);

  // A cleared line (Save & New, or the reader deleting it) starts the next
  // entry from nothing: the last entry's reading is not drawn under it while
  // its own is on the way, and an answer to an identical earlier line is not
  // reused, since a save in between has moved the balance it reports.
  // Reset during render (the "info from previous render" pattern), not in an effect.
  if (isEmpty && (answer !== null || lastReading !== null)) {
    setAnswer(null);
    setLastReading(null);
  }

  // What the last ask was made against, so only typing waits for a pause.
  const lastContext = useRef<string | null>(null);
  // The request body as of this render, read when the timer fires.
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });

  useEffect(() => {
    const previousContext = lastContext.current;
    lastContext.current = context;
    if (isEmpty) return;
    // Typing waits for a pause; the first ask (a line handed in already typed),
    // a changed pin, day or account, and Try Again ask at once.
    const delay =
      previousContext !== null && previousContext === context ? QUICK_ADD_DEBOUNCE_MS : 0;
    let cancelled = false;
    const handle = setTimeout(() => {
      const { text, pins, today, contextAccountId } = latest.current;
      quickAddApi
        .interpret({
          text,
          today,
          ...(contextAccountId ? { contextAccountId } : {}),
          ...(hasPins(pins) ? { pins } : {}),
        })
        .then(
          (interpretation) => {
            if (cancelled) return;
            setAnswer({ key, interpretation });
            setLastReading(interpretation);
          },
          (error: unknown) => {
            if (cancelled) return;
            logger.error(error);
            setAnswer({ key, interpretation: null });
          },
        );
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [key, context, isEmpty]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const current = !isEmpty && answer?.key === key ? answer : null;
  const status: QuickAddReadingStatus = isEmpty
    ? 'idle'
    : current === null
      ? 'pending'
      : current.interpretation === null
        ? 'failed'
        : 'ready';

  return {
    status,
    /** The reading for what is on screen; null unless `ready`. */
    interpretation: status === 'ready' ? (current?.interpretation ?? null) : null,
    /** What to draw: the current reading, or the last one while a newer is pending. */
    shown: status === 'ready' ? (current?.interpretation ?? null) : status === 'pending' ? lastReading : null,
    retry,
  };
}
