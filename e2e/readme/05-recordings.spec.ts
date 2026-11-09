import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { waitForReady } from './session';
import { MOBILE_CONTEXT, MOBILE_VIEWPORT, RAW_DIR, VIDEO_VIEWPORT, showcaseMonth } from './settings';
import {
  finishRecording,
  glideClick,
  markReady,
  pause,
  scrollToTarget,
  startRecording,
  swipe,
  typeInto,
} from './video';

// Three screen recordings, each of a flow that is already on screen when the
// video starts. `readme/make-gifs.mjs` turns them into the GIFs.

test.beforeAll(() => {
  // Playwright names raw videos at random; only the `<name>.webm` kept by
  // `finishRecording` matters, so earlier runs' leftovers go.
  rmSync(RAW_DIR, { recursive: true, force: true });
});

const DESKTOP_RECORDING = {
  viewport: VIDEO_VIEWPORT,
  size: VIDEO_VIEWPORT,
  deviceScaleFactor: 1,
  locale: 'en',
  timezoneId: 'UTC',
  colorScheme: 'dark' as const,
};

test('tour: dashboard, transactions, calendar, investments', async ({ browser }) => {
  const recording = await startRecording(browser, 'tour', DESKTOP_RECORDING);
  const { page } = recording;

  await page.goto('/dashboard');
  await waitForReady(page);
  await expect(page.getByText('Car Insurance').first()).toBeVisible();
  await page.mouse.move(700, 420);
  markReady(recording);
  await pause(page, 1500);

  await glideClick(page, page.locator('header').getByText('Transactions', { exact: true }), 200);
  await expect(page.getByRole('table')).toBeVisible();
  await waitForReady(page);
  await pause(page, 700);
  await scrollToTarget(page, page.getByText(/Showing 1 - \d+ of/), 100, 10);
  await pause(page, 1500);

  await glideClick(page, page.getByRole('button', { name: 'Calendar', exact: true }), 300);
  const grid = page.getByRole('grid');
  await expect(grid).toBeVisible();
  for (let i = 0; i < showcaseMonth().monthsBack; i++) {
    await glideClick(page, page.getByRole('button', { name: 'Previous month' }), 300);
  }
  await expect(grid.getByText('Parents visiting').first()).toBeVisible();
  await waitForReady(page);
  await pause(page, 1900);

  await glideClick(page, page.locator('header').getByText('Investments', { exact: true }), 200);
  await expect(page.getByRole('heading', { name: /Portfolio Summary/ })).toBeVisible();
  await waitForReady(page);
  await pause(page, 1900);

  await finishRecording(recording);
});

test('rules: build a rule and test it on existing transactions', async ({ browser }) => {
  const recording = await startRecording(browser, 'rules', DESKTOP_RECORDING);
  const { page } = recording;

  await page.goto('/rules');
  await waitForReady(page);
  await expect(page.getByText('Costco receipts')).toBeVisible();
  await page.mouse.move(700, 300);
  markReady(recording);
  await pause(page, 1000);

  await glideClick(page, page.getByRole('link', { name: 'Create rule' }).first(), 200);
  await expect(page.getByRole('heading', { name: 'New rule' })).toBeVisible();
  await typeInto(page, page.getByLabel('Name'), 'Restaurant meals over $50', 30);
  await pause(page, 250);

  await scrollToTarget(page, page.getByRole('heading', { name: 'If', exact: true }), 120, 10);
  await glideClick(page, page.getByRole('button', { name: '+ Add condition' }), 200);
  await page.getByLabel('Field').first().selectOption({ label: 'Category' });
  await pause(page, 350);
  const category = page.getByPlaceholder('Choose a category');
  await typeInto(page, category, 'Restau', 55);
  await glideClick(page, page.getByText('Food: Restaurants', { exact: true }), 250);

  await glideClick(page, page.getByRole('button', { name: '+ Add condition' }), 200);
  await page.getByLabel('Field').nth(1).selectOption({ label: 'Amount (ignoring sign)' });
  await page.getByLabel('Operator').nth(1).selectOption({ label: 'is at least' });
  await typeInto(page, page.getByLabel('Amount'), '50', 70);
  await pause(page, 300);

  await scrollToTarget(page, page.getByRole('heading', { name: 'Then', exact: true }), 120, 10);
  await glideClick(page, page.getByRole('button', { name: '+ Add action' }), 200);
  await page.getByLabel('Action type').selectOption({ label: 'Add tags' });
  await glideClick(page, page.getByText('Choose tags'), 200);
  await glideClick(page, page.getByRole('checkbox', { name: 'Date night' }), 300);
  await page.keyboard.press('Escape');
  await pause(page, 300);

  await scrollToTarget(page, page.getByRole('heading', { name: 'Test', exact: true }), 90, 10);
  await glideClick(page, page.getByRole('button', { name: 'Test rule', exact: true }), 200);
  await expect(page.getByText(/transactions? would change/)).toBeVisible();
  await waitForReady(page);
  await pause(page, 600);
  await scrollToTarget(page, page.getByText(/transactions? would change/), 140, 10);
  await pause(page, 2200);

  await glideClick(page, page.getByText('Cancel', { exact: true }), 200);
  await expect(page.getByRole('heading', { name: 'Rules', exact: true })).toBeVisible();
  await expect(page.getByText('Restaurant meals over $50')).toHaveCount(0);
  await pause(page, 800);

  await finishRecording(recording);
});

test('mobile: the drawer, a page of the register, swipes between views', async ({ browser }) => {
  const recording = await startRecording(browser, 'mobile', {
    ...MOBILE_CONTEXT,
    // The video is the viewport in CSS pixels: a larger size, even at a device
    // scale factor of 2, leaves the page in one corner of a grey frame.
    size: MOBILE_VIEWPORT,
    touch: true,
  });
  const { page } = recording;
  const { width, height } = MOBILE_VIEWPORT;

  await page.goto('/dashboard');
  await waitForReady(page);
  await expect(page.getByText('Car Insurance').first()).toBeVisible();
  markReady(recording);
  await pause(page, 1200);

  await page.getByRole('navigation', { name: 'Tab bar' }).getByRole('button', { name: 'More', exact: true }).tap();
  await expect(page.getByRole('button', { name: 'Investments', exact: true })).toBeVisible();
  await pause(page, 1000);
  await page.getByRole('navigation', { name: 'Main menu' }).getByRole('button', { name: 'Transactions', exact: true }).tap();
  await expect(page.getByText('Coffee run').first()).toBeVisible();
  await waitForReady(page);
  await pause(page, 700);

  // The register pages itself: a swipe inside it turns the page.
  await scrollToTarget(page, page.getByText('2026-09-28').first(), 60, 10);
  await pause(page, 700);
  await swipe(page, { x: width - 40, y: height * 0.55 }, { x: 40, y: height * 0.55 });
  await expect(page.getByText(/Showing 51 - 100 of/).first()).toBeVisible();
  await pause(page, 1100);

  // Outside the register a swipe moves to the next view.
  await waitForReady(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await pause(page, 500);
  // A swipe that does not carry far enough snaps back; try once more if it did.
  await expect(async () => {
    await swipe(page, { x: width - 40, y: 140 }, { x: 40, y: 140 });
    await expect(page.getByRole('heading', { name: 'Bills & Deposits' })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20_000 });
  await waitForReady(page);
  await pause(page, 1300);

  await finishRecording(recording);
});
