import { test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { apiFor, openSession, shoot } from '../readme/session';
import { DESKTOP_CONTEXT, DOCS_IMAGE_DIR, MOBILE_CONTEXT } from '../readme/settings';
import { loginUser } from '../helpers/auth';
import { E2E_DEFAULT_PASSWORD } from '../helpers/credentials';

// What the documentation captures share. Each test in this folder is titled
// with the picture it writes, and runs once per theme (the `dark` and `light`
// projects in playwright.docs.config.ts): `images/<name>.png` and
// `images/<name>.light.png`. The Markdown references only `images/<name>.png`;
// the docs build shows the light one to a reader in light mode.

/** The theme of the project running the current test. */
export function theme(): 'dark' | 'light' {
  return test.info().project.name === 'light' ? 'light' : 'dark';
}

/**
 * A signed-in context in the current project's theme: the desktop viewport
 * (1600x1000), or the phone (390x844 at 2x, with touch). The app follows the
 * browser's colour scheme until a user picks a theme, so this is all it takes.
 */
export async function openDocsSession(
  browser: Browser,
  device: 'desktop' | 'phone' = 'desktop',
): Promise<BrowserContext> {
  const base = device === 'phone' ? MOBILE_CONTEXT : DESKTOP_CONTEXT;
  const context = await openSession(browser, { ...base, colorScheme: theme() });
  // The demo data saves the demo user's theme as dark; "system" hands the
  // choice back to the browser, where each project sets it.
  const page = await context.newPage();
  await page.goto('/dashboard');
  await apiFor(page).patch('/users/preferences', { theme: 'system' });
  await page.evaluate(() => window.localStorage.removeItem('monize-theme'));
  await page.close();
  return context;
}

/**
 * Save the picture for the current theme: the viewport, or just `element`.
 * The e2e stack serves the development build, whose Next.js indicator would
 * otherwise sit in the corner of every picture.
 */
export async function docShot(page: Page, name: string, element?: Locator): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  const file = theme() === 'light' ? `${name}.light` : name;
  await shoot(page, file, { dir: DOCS_IMAGE_DIR, element });
}

/** The card (`Card`, a dashboard widget, a page section) that holds `inner`. */
export function cardOf(inner: Locator): Locator {
  return inner.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " rounded-lg ")][1]',
  );
}

/**
 * The instance administrator, for the admin screens. The first account ever
 * registered becomes the admin, so it is registered before the demo seed runs
 * (website/README.md, "Screenshots"); the demo user itself is not an admin.
 */
export const DOCS_ADMIN = {
  email: 'sam.taylor@monize.example',
  password: E2E_DEFAULT_PASSWORD,
  firstName: 'Sam',
  lastName: 'Taylor',
};

/** A context signed in as DOCS_ADMIN, in the current project's theme. */
export async function openAdminSession(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ ...DESKTOP_CONTEXT, colorScheme: theme() });
  const page = await context.newPage();
  await loginUser(page, DOCS_ADMIN.email, DOCS_ADMIN.password);
  await page.close();
  return context;
}
