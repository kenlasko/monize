import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { apiFor, scrollUnderHeader, waitForReady } from '../readme/session';
import { STATE_FILE } from '../readme/settings';
import { docShot, openDocsSession } from './capture';

// website/docs/tags.md. The tags, the tagged transactions and the rules are
// the showcase data readme/01-seed.spec.ts adds (readme/seed-tags-rules.ts).
// The New Tag dialog is filled in and closed without saving.

// A first visit to a route compiles it on the development server: minutes, not seconds.
test.describe.configure({ timeout: 360_000 });

let context: BrowserContext;
let page: Page;
let lisbonTag: string;
let coffeeRule: string;

interface Named {
  id: string;
  name: string;
}

test.beforeAll(async ({ browser }) => {
  context = await openDocsSession(browser);
  page = await context.newPage();
  await page.goto('/dashboard');
  const api = apiFor(page);
  const [tags, rules] = await Promise.all([
    api.get<Named[]>('/tags'),
    api.get<Named[]>('/transaction-rules'),
  ]);
  const tag = tags.find((t) => t.name === 'trip:Lisbon');
  const rule = rules.find((r) => r.name === 'Coffee runs');
  if (!tag || !rule)
    throw new Error('The showcase tags and rules are missing: run readme/01-seed.spec.ts.');
  lisbonTag = tag.id;
  coffeeRule = rule.id;
});

/**
 * Keep the shared session file current. The server rotates the sign-in cookies
 * as a context refreshes them, so a later context (the next file, or a worker
 * restarted after a failure) would otherwise start from cookies that no longer
 * work.
 */
const saveSession = () => context.storageState({ path: STATE_FILE }).catch(() => undefined);

test.afterEach(saveSession);

test.afterAll(async () => {
  await saveSession();
  await context.close();
});

/**
 * Open `path` and wait for it to settle. The development server compiles a
 * route on its first visit, and the service worker answers a navigation that
 * takes too long with its offline page, so a first attempt can land there.
 * `ready`, when given, is what the page shows once its data has loaded.
 */
async function go(p: Page, path: string, ready?: Locator): Promise<void> {
  await expect(async () => {
    await p.goto(path);
    await expect(p.getByRole('main').first()).toBeVisible({ timeout: 20_000 });
    // A request the busy server dropped shows an error card: load the page again.
    if (ready) await expect(ready).toBeVisible({ timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
  await waitForReady(p);
}

test('tags-page', async () => {
  await go(page, '/tags');
  await expect(page.getByText('trip:Lisbon')).toBeVisible();
  await docShot(page, 'tags-page');
});

test('tags-form', async () => {
  await go(page, '/tags');
  await page.getByRole('button', { name: '+ New Tag' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New Tag' })).toBeVisible();
  await dialog.getByLabel('Tag Name').fill('trip:Banff');
  await dialog.getByRole('button', { name: 'Teal' }).click();
  await docShot(page, 'tags-form', dialog);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('tags-rule-editor', async () => {
  await go(page, `/rules/${coffeeRule}`);
  await expect(page.getByText('Coffee run').first()).toBeVisible({ timeout: 30_000 });
  await waitForReady(page);
  // The If and Then sections: the payees it matches and the tag it adds.
  await scrollUnderHeader(page, page.getByRole('heading', { name: 'If', exact: true }));
  await docShot(page, 'tags-rule-editor');
});

test('tags-filtered-transactions', async () => {
  await go(page, `/transactions?tagIds=${lisbonTag}`);
  await expect(page.getByRole('main').getByText('Hotel Avenida Palace').first()).toBeVisible({
    timeout: 30_000,
  });
  await waitForReady(page);
  // The filter chip and the rows, below the monthly chart.
  await scrollUnderHeader(page, page.getByText('Favourites:'));
  await docShot(page, 'tags-filtered-transactions');
});
