'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Cookies from 'js-cookie';
import { useTranslations } from 'next-intl';
import { preferenceCookieAttributes } from '@/lib/preference-cookie';

/** What the panel can show, in the order successive visits step through it. */
export const AUTH_BRAND_SLIDES = [
  { id: 'dashboard', image: 'dashboard-overview' },
  { id: 'transactions', image: 'transactions-page' },
  { id: 'investments', image: 'investments-page' },
  { id: 'bills', image: 'bills-calendar' },
  { id: 'budgets', image: 'budgets-page' },
  { id: 'reports', image: 'reports-page' },
] as const;

/** The index of the slide shown last. A cookie: localStorage is pinned before login. */
export const AUTH_BRAND_SLIDE_COOKIE = 'monize-auth-slide';

/** How soon after a panel goes away a new one still counts as the same visit. */
const SAME_VISIT_MS = 1000;

// The slide on screen, or just gone. Moving between screens of one visit swaps
// the shell, as register does into first-run setup, and that must not change
// the picture. Sign-out is a client navigation too, so this cannot simply last
// as long as the page does: the next sign-in has to step on.
let shown: { index: number; releasedAt: number | null } | null = null;

function slideIndexForMount(): number {
  if (shown && (shown.releasedAt === null || Date.now() - shown.releasedAt < SAME_VISIT_MS)) {
    return shown.index;
  }
  const last = Number.parseInt(Cookies.get(AUTH_BRAND_SLIDE_COOKIE) ?? '', 10);
  return Number.isInteger(last) && last >= 0 ? (last + 1) % AUTH_BRAND_SLIDES.length : 0;
}

interface AuthBrandPanelProps {
  /** The sample-data picture; the shell passes true only once the server allows it. */
  showScreenshot?: boolean;
}

/**
 * The gradient half of every auth screen: the brand, a line about one feature
 * and a picture of it, a different feature on each visit.
 * The gradient is the accent ramp, so each palette tints it, and the pictures
 * come from `scripts/build-brand-screenshots.mjs` and are bounded by the panel
 * both ways, so a narrow or short window scales them rather than cropping them.
 * Only the picture matching the mode is fetched, and neither below `lg`, where
 * the panel is not displayed: a lazy image that is `display: none` never loads.
 */
export function AuthBrandPanel({ showScreenshot = false }: AuthBrandPanelProps) {
  const t = useTranslations('auth.brandPanel');
  const [index] = useState(slideIndexForMount);
  const slide = AUTH_BRAND_SLIDES[index];

  useEffect(() => {
    Cookies.set(AUTH_BRAND_SLIDE_COOKIE, String(index), preferenceCookieAttributes());
    shown = { index, releasedAt: null };
    return () => {
      shown = { index, releasedAt: Date.now() };
    };
  }, [index]);

  return (
    <aside
      data-testid="auth-brand-panel"
      className="relative hidden h-screen flex-col overflow-hidden bg-linear-to-br from-blue-700 via-blue-800 to-blue-950 p-12 text-white lg:sticky lg:top-0 lg:flex xl:p-16"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-32 -top-32 h-[32rem] w-[32rem] rounded-full bg-white/10 blur-3xl"
      />
      <div className="relative flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white p-1">
          <Image src="/icons/monize-logo-transparent.svg" alt="" width={32} height={32} priority />
        </span>
        <span className="text-xl font-bold tracking-tight">Monize</span>
      </div>
      <div className="relative mt-12 max-w-xl xl:mt-16">
        <p className="text-3xl font-extrabold leading-tight tracking-tight xl:text-4xl">
          {t(`slides.${slide.id}.title`)}
        </p>
        <p className="mt-4 text-base text-white/80 xl:text-lg">{t(`slides.${slide.id}.body`)}</p>
      </div>
      <div className="auth-brand-rise relative mt-10 min-h-0 flex-1 xl:mt-14">
        {showScreenshot && (
          <div className="relative h-full w-fit max-w-full">
            {(['.light', ''] as const).map((variant) => (
              <Image
                key={variant}
                data-testid={`auth-brand-shot-${slide.image}${variant}`}
                src={`/brand/${slide.image}${variant}.webp`}
                alt=""
                width={1400}
                height={875}
                unoptimized
                className={`h-auto max-h-full w-auto max-w-full rounded-xl shadow-2xl ring-1 ring-white/15 ${
                  variant ? 'dark:hidden' : 'hidden dark:block'
                }`}
              />
            ))}
            <span className="absolute right-3 top-3 rounded-full bg-black/60 px-3 py-1 text-xs font-semibold text-white">
              {t('sampleData')}
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}
