import { expect, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loginUser } from '../helpers/auth';
import { createApiClient, type ApiClient } from '../helpers/api';
import { differingPixels } from './png-diff';
import {
  DESKTOP_CONTEXT,
  IMAGE_DIR,
  SHOTS_EMAIL,
  SHOTS_PASSWORD,
  STATE_FILE,
} from './settings';

// Signing in, keeping the session, and the waits that make a picture clean.

/**
 * Sign in through the UI once and keep the browser state for every later
 * context of the run. The login endpoint allows five attempts per fifteen
 * minutes, so a context per picture must not each sign in.
 */
export async function ensureSession(browser: Browser): Promise<string> {
  if (existsSync(STATE_FILE)) return STATE_FILE;

  const context = await browser.newContext(DESKTOP_CONTEXT);
  const page = await context.newPage();
  await loginUser(page, SHOTS_EMAIL, SHOTS_PASSWORD);
  await dismissNotificationPrompt(page);

  mkdirSync(dirname(STATE_FILE), { recursive: true });
  await context.storageState({ path: STATE_FILE });
  await context.close();
  return STATE_FILE;
}

/** A new context that is already signed in. */
export async function openSession(
  browser: Browser,
  options: BrowserContextOptions = DESKTOP_CONTEXT,
): Promise<BrowserContext> {
  const storageState = await ensureSession(browser);
  return browser.newContext({ ...options, storageState });
}

export function apiFor(page: Page): ApiClient {
  return createApiClient(page.request);
}

/**
 * The ask the app puts under the header ("Turn on notifications?"), in each of
 * its three forms. The app remembers a "Not now" per account in localStorage;
 * writing that same record is how it is dismissed here, because the banner only
 * appears once the server has told the page that push is available, and a
 * click that waits for it either costs a long timeout or misses it.
 */
const PUSH_PROMPT_KINDS = ['enable', 'install-ios', 'blocked'];

export async function dismissNotificationPrompt(page: Page): Promise<void> {
  const me = await page.request.get('/api/v1/users/me');
  if (!me.ok()) throw new Error(`Could not read the signed-in user (${me.status()})`);
  const { id } = (await me.json()) as { id: string };
  await page.evaluate(
    ({ userId, kinds }) => {
      window.localStorage.setItem('monize.push.promptDismissed', JSON.stringify({ userId, kinds }));
    },
    { userId: id, kinds: PUSH_PROMPT_KINDS },
  );
}

/** Spinners and skeletons are the two ways this app says "still loading". */
const LOADING = '.animate-spin, .animate-pulse';

/** react-hot-toast mounts each toast as a polite live region. */
const TOAST = 'div[role="status"][aria-live="polite"]';

/** Wait until the page has real content on it and nothing is still loading. */
export async function waitForReady(page: Page): Promise<void> {
  await expect(page.getByRole('main').first()).toBeVisible();
  await expect(page.locator(LOADING)).toHaveCount(0);
  await expect(page.locator(TOAST)).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

export async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForReady(page);
}

/** What a chart has drawn once its data is on screen (an empty chart has only its axes). */
const CHART_DATA =
  'path.recharts-sector, .recharts-bar-rectangle, .recharts-area-area, .recharts-line-curve, .recharts-scatter-symbol';

/**
 * Resolves once every chart has drawn its data and stopped changing for 600 ms.
 * A donut starts drawing a moment after the page is ready, and until then two
 * frames are equally empty, so "the same twice" alone would settle on a blank.
 * A chart that never gets data (an empty one) is waited for six seconds, no more.
 */
async function chartsSettled(page: Page): Promise<void> {
  const startedAt = Date.now();
  let last = '';
  let steady = 0;
  await expect
    .poll(
      async () => {
        const { painted, signature } = await page.evaluate((dataSelector) => {
          const hash = (text: string) => {
            let h = 5381;
            for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
            return h;
          };
          const charts = [...document.querySelectorAll('.recharts-wrapper')];
          return {
            painted: charts.every((chart) => chart.querySelector(dataSelector) !== null),
            signature: charts.map((chart) => hash(chart.innerHTML)).join(','),
          };
        }, CHART_DATA);
        steady = signature === last ? steady + 1 : 0;
        last = signature;
        return steady >= 6 && (painted || Date.now() - startedAt > 6_000);
      },
      { message: 'the charts never settled', timeout: 20_000, intervals: [100] },
    )
    .toBe(true);
}

/**
 * Two frames this close count as the same picture: a rounded corner can
 * anti-alias differently between captures, while a chart still drawing or a
 * spinner turning moves thousands of pixels.
 */
const SETTLED_PIXELS = 64;

/**
 * Save the page as `<IMAGE_DIR>/<name>.png` once two consecutive frames are
 * identical, which is how a chart that is still animating in, or a font that
 * has not swapped yet, is told apart from a finished page without a sleep.
 */
export async function shoot(
  page: Page,
  name: string,
  options: {
    fullPage?: boolean;
    /** Crop to this element (a widget, a dialog) instead of the viewport. */
    element?: Locator;
    /** Where the PNG lands; the README's `docs/images/readme` by default. */
    dir?: string;
  } = {},
): Promise<void> {
  const dir = options.dir ?? IMAGE_DIR;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.png`);
  // Nothing hovered, nothing focused: a button under the pointer or a focus
  // ring left by the last click is a state a frame can flicker between.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await chartsSettled(page);
  let previous: Buffer | undefined;
  await expect
    .poll(
      async () => {
        const frame = options.element
          ? await options.element.screenshot({ animations: 'disabled', caret: 'hide' })
          : await page.screenshot({
              animations: 'disabled',
              caret: 'hide',
              fullPage: options.fullPage ?? false,
            });
        const settled =
          previous !== undefined && differingPixels(previous, frame) <= SETTLED_PIXELS;
        previous = frame;
        if (settled) writeFileSync(file, frame);
        return settled;
      },
      { message: `${name}.png never settled`, timeout: 20_000, intervals: [300] },
    )
    .toBe(true);
}

/**
 * Resolves once the page has the same height and `target` the same place for
 * half a second: a chart that is still measuring itself, or a list that is still
 * filling in above the target, moves it after the page has been scrolled.
 */
async function layoutSettled(page: Page, target: Locator): Promise<void> {
  let last = '';
  let steady = 0;
  await expect
    .poll(
      async () => {
        const now = await target
          .first()
          .evaluate(
            (el) =>
              `${document.documentElement.scrollHeight}:${Math.round(el.getBoundingClientRect().top + window.scrollY)}`,
          );
        steady = now === last ? steady + 1 : 0;
        last = now;
        return steady;
      },
      { message: 'the layout never settled', timeout: 10_000, intervals: [100] },
    )
    .toBeGreaterThanOrEqual(5);
}

/**
 * Scroll so `target` sits `gap` pixels under the app header, with the header on
 * screen. The header slides out as the page scrolls down and back in as it
 * scrolls up, by as many pixels as the page moved, so the page is taken a header
 * past the spot and brought back. The page is only scrolled once its layout has
 * stopped moving, and the result is checked (header showing, target where asked)
 * and done again if something shifted meanwhile. Where the page ends before the
 * spot, the target is simply lower than `gap`.
 */
export async function scrollUnderHeader(page: Page, target: Locator, gap = 16): Promise<void> {
  const header = page.locator('header').first();
  const settle = () =>
    page.evaluate(
      () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
    );
  const move = async (y: number) => {
    await page.evaluate((to) => window.scrollTo(0, to), y);
    await settle();
  };
  await expect(async () => {
    await layoutSettled(page, target);
    const height = await header.evaluate((el) => el.getBoundingClientRect().height);
    const top = await target.first().evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    const wanted = Math.max(0, Math.round(top - height - gap));
    const ends = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);

    await move(0);
    if (wanted > 0) {
      await move(wanted + height + 4);
      const reached = await page.evaluate(() => window.scrollY);
      await move(reached - wanted >= height ? wanted : Math.max(0, reached - height - 4));
    }
    await layoutSettled(page, target);

    const now = await target.first().evaluate((el) => ({
      headerTop: document.querySelector('header')?.getBoundingClientRect().top ?? 0,
      targetTop: el.getBoundingClientRect().top,
    }));
    expect(now.headerTop, 'the header should be on screen').toBeGreaterThanOrEqual(0);
    if (wanted + height + 4 <= ends) {
      expect(Math.abs(now.targetTop - (height + gap)), 'the target should sit under the header').toBeLessThanOrEqual(2);
    }
  }).toPass({ timeout: 30_000 });
}
