'use client';

import { useEffect, useState } from 'react';
import { helpApi, type HelpPage } from '@/lib/help';

type Settled = { slug: string; attempt: number; page: HelpPage | null };

interface HelpPageState {
  /** The page for the requested slug; `null` while loading and after a failure. */
  page: HelpPage | null;
  /** The request for the requested slug failed. Never an empty page: the caller shows why. */
  error: boolean;
  loading: boolean;
  retry: () => void;
}

/**
 * One page of the bundled guide.
 *
 * The result is kept with the slug and attempt that produced it, so a slow
 * answer for a page the reader has already left cannot be shown under the new
 * one, and a failed request is an error state rather than a page with nothing
 * in it. `helpApi.getPage` shares in-flight requests and caches successes.
 */
export function useHelpPage(slug: string | null): HelpPageState {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    if (slug === null) return;
    let cancelled = false;
    helpApi.getPage(slug).then(
      (page) => {
        if (!cancelled) setSettled({ slug, attempt, page });
      },
      () => {
        if (!cancelled) setSettled({ slug, attempt, page: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [slug, attempt]);

  const current =
    settled && settled.slug === slug && settled.attempt === attempt ? settled : null;

  return {
    page: current?.page ?? null,
    error: current !== null && current.page === null,
    loading: slug !== null && current === null,
    retry: () => setAttempt((a) => a + 1),
  };
}
