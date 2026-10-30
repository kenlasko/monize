import type { Locator, Page } from '@playwright/test';
import { shoot } from '../readme/session';
import { DOCS_IMAGE_DIR } from '../readme/settings';

// What the documentation captures share. Each test in this folder is titled
// with the PNG it writes, so `npm run docs:screenshots -- -g <name>` retakes one
// picture; the Markdown references it as `images/<name>.png`.

/**
 * Save `website/docs/images/<name>.png`: the viewport, or just `element`.
 * The e2e stack serves the development build, whose Next.js indicator would
 * otherwise sit in the corner of every picture.
 */
export async function docShot(page: Page, name: string, element?: Locator): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await shoot(page, name, { dir: DOCS_IMAGE_DIR, element });
}

/** The card (`Card`, a dashboard widget, a page section) that holds `inner`. */
export function cardOf(inner: Locator): Locator {
  return inner.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " rounded-lg ")][1]',
  );
}
