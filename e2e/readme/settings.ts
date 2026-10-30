import { resolve } from 'node:path';
import { devices, type BrowserContextOptions } from '@playwright/test';
import { DEMO_USER_EMAIL, DEMO_USER_PASSWORD } from '../../frontend/src/lib/demo-credentials';

// Everything the README capture agrees on, in one place.

/**
 * The built-in demo user, spelled once per layer in `frontend/src/lib/demo-credentials.ts`
 * (a second spelling here would trip the CI secret scan). Override for an instance
 * whose demo user differs.
 */
export const SHOTS_EMAIL = process.env.README_SHOTS_EMAIL ?? DEMO_USER_EMAIL;
export const SHOTS_PASSWORD = process.env.README_SHOTS_PASSWORD ?? DEMO_USER_PASSWORD;

/** Where the PNGs and GIFs land (the repository's `docs/images/readme`). */
export const IMAGE_DIR = resolve(__dirname, '../../docs/images/readme');

/** Where the user documentation's screenshots land (`npm run docs:screenshots`). */
export const DOCS_IMAGE_DIR = resolve(__dirname, '../../website/docs/images');

/**
 * Raw screen recordings, one deterministic `<name>.webm` per GIF. Kept out of
 * Playwright's own output folder, which it empties at the start of every run.
 */
export const RECORDING_DIR = resolve(__dirname, '../readme-recordings');

/** Where Playwright drops the videos it names at random, before `finishRecording` renames them. */
export const RAW_DIR = resolve(RECORDING_DIR, 'raw');

/** The logged-in browser state shared by the specs of one run (git-ignored). */
export const STATE_FILE = resolve(
  __dirname,
  '../test-results-readme/session/state.json',
);

// 1600 wide: the Accounts table cuts its Balance column at 1440.
export const DESKTOP_VIEWPORT = { width: 1600, height: 1000 } as const;
// 1440 wide: the app header clips its Logout button at 1280.
export const VIDEO_VIEWPORT = { width: 1440, height: 900 } as const;
export const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

const PIXEL = devices['Pixel 7'];

/** The phone every mobile picture is taken on: 390x844 at 2x, with touch. */
export const MOBILE_CONTEXT: BrowserContextOptions = {
  viewport: MOBILE_VIEWPORT,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: PIXEL.userAgent,
  locale: 'en',
  timezoneId: 'UTC',
  colorScheme: 'dark',
};

export const DESKTOP_CONTEXT: BrowserContextOptions = {
  viewport: DESKTOP_VIEWPORT,
  deviceScaleFactor: 1,
  locale: 'en',
  timezoneId: 'UTC',
  colorScheme: 'dark',
};

/** The month the budget, the calendar and the day notes are built around. */
export interface ShowcaseMonth {
  year: number;
  /** 1-12 */
  month: number;
  /** YYYY-MM-01 */
  start: string;
  /** Number of months back from today: 0 = this month, 1 = last month. */
  monthsBack: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The demo ledger runs up to a few days before it was seeded, so in the first
 * days of a month the current month holds almost nothing: a budget or a
 * calendar for it would show zeros. Until the 10th the showcase uses the month
 * before, which is full; after that, the current month.
 */
export function showcaseMonth(today: Date = new Date()): ShowcaseMonth {
  const monthsBack = today.getUTCDate() < 10 ? 1 : 0;
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsBack, 1));
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  return { year, month, start: `${year}-${pad(month)}-01`, monthsBack };
}

/** This month, as the budget wizard's own default (its period is always the calendar month). */
export function currentMonth(today: Date = new Date()): ShowcaseMonth {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  return { year, month, start: `${year}-${pad(month)}-01`, monthsBack: 0 };
}

/** YYYY-MM-DD for `days` after (or before, when negative) `from`, in UTC. */
export function addDays(from: string, days: number): string {
  const [y, m, d] = from.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function todayYmd(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
}

export function monthName(month: number): string {
  return new Date(Date.UTC(2000, month - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  });
}
