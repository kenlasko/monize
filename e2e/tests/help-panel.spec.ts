import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';

// A page prefetches the guide's manifest when its header mounts, and a click
// before the answer arrives is left to the link (monize.net), by design: the
// choice is made synchronously at click time. Go to the page and wait for the
// manifest, so the click that follows is the one a reader makes a moment later.
async function gotoWithGuideKnown(page: Page, path: string) {
  const manifest = page.waitForResponse(
    (r) => new URL(r.url()).pathname.endsWith('/help') && r.ok(),
  );
  await page.goto(path);
  await (await manifest).finished();
  // The app stores the answer a tick after the body is read; one frame covers it.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

// The page header's "?" opens the user guide in a panel beside the page instead
// of in a new browser tab. The guide ships in the backend (the e2e stack builds
// the development image, which copies website/docs), so this runs offline.
test.describe('Help panel', () => {
  test('the Budgets "?" opens the Budgets guide in place, with no new tab', async ({
    authedPage: page,
    context,
  }) => {
    await gotoWithGuideKnown(page, '/budgets');
    await expect(page.getByRole('heading', { level: 1, name: 'Budgets' })).toBeVisible();

    // Any page the click opens, whatever it is, is a regression.
    const opened: string[] = [];
    context.on('page', (p) => opened.push(p.url()));

    await page.getByRole('link', { name: 'Help for this page' }).click();

    const panel = page.getByRole('complementary', { name: 'Help' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { level: 2, name: 'Budgets', exact: true })).toBeVisible();
    await expect(panel.getByText('Creating a Budget').first()).toBeVisible();

    // The budgets list is still on screen beside it.
    await expect(page.getByRole('heading', { level: 1, name: 'Budgets' })).toBeVisible();
    expect(opened).toEqual([]);
    expect(page.url()).toMatch(/\/budgets$/);
  });

  test('an internal link navigates inside the panel, and Back returns', async ({
    authedPage: page,
  }) => {
    await gotoWithGuideKnown(page, '/budgets');
    await page.getByRole('link', { name: 'Help for this page' }).click();

    const panel = page.getByRole('complementary', { name: 'Help' });
    await expect(panel.getByRole('heading', { level: 2, name: 'Budgets', exact: true })).toBeVisible();

    // budgets.md links to the Budget reports section of the Reports page.
    await panel.getByRole('link', { name: 'Reports', exact: true }).first().click();
    await expect(panel.getByRole('heading', { level: 2, name: 'Reports', exact: true })).toBeVisible();
    expect(page.url()).toMatch(/\/budgets$/);

    await panel.getByRole('button', { name: 'Back' }).click();
    await expect(panel.getByRole('heading', { level: 2, name: 'Budgets', exact: true })).toBeVisible();
  });

  test('Escape closes the panel, and the icon is still a link to monize.net', async ({
    authedPage: page,
  }) => {
    await gotoWithGuideKnown(page, '/budgets');
    const help = page.getByRole('link', { name: 'Help for this page' });

    // The icon is still a link to the same page on monize.net.
    await expect(help).toHaveAttribute('href', 'https://www.monize.net/docs/budgets');

    await help.click();
    const panel = page.getByRole('complementary', { name: 'Help' });
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  });

  test('a key that names a section opens the panel at that section', async ({
    authedPage: page,
  }) => {
    // `institutions` is { page: 'accounts', section: 'financial-institutions' }.
    await gotoWithGuideKnown(page, '/institutions');
    await expect(page.getByRole('heading', { level: 1, name: 'Institutions' })).toBeVisible();

    await page.getByRole('link', { name: 'Help for this page' }).click();

    const panel = page.getByRole('complementary', { name: 'Help' });
    await expect(panel.getByRole('heading', { level: 2, name: 'Accounts', exact: true })).toBeVisible();
    const section = panel.getByRole('heading', { name: 'Financial Institutions', exact: true });
    await expect(section).toBeVisible();
    // Focus lands on the section, not the top of the page.
    await expect(section).toBeFocused();
    expect(page.url()).toMatch(/\/institutions$/);
  });

  test('a Ctrl-click goes to monize.net in a new tab and leaves the panel closed', async ({
    authedPage: page,
    context,
  }) => {
    // Nothing may reach the network: record the request the new tab makes and
    // refuse it.
    const requested: string[] = [];
    await context.route('https://www.monize.net/**', (route) => {
      requested.push(route.request().url());
      return route.abort();
    });

    await gotoWithGuideKnown(page, '/budgets');
    await expect(page.getByRole('heading', { level: 1, name: 'Budgets' })).toBeVisible();

    const popup = context.waitForEvent('page');
    await page.getByRole('link', { name: 'Help for this page' }).click({ modifiers: ['Control'] });
    await popup;

    await expect.poll(() => requested).toContain('https://www.monize.net/docs/budgets');
    await expect(page.getByRole('complementary', { name: 'Help' })).toBeHidden();
    expect(page.url()).toMatch(/\/budgets$/);
  });

  test('Back and Forward follow every section the reader visits, and are disabled at the ends', async ({
    authedPage: page,
  }) => {
    await gotoWithGuideKnown(page, '/budgets');
    await page.getByRole('link', { name: 'Help for this page' }).click();
    const panel = page.getByRole('complementary', { name: 'Help' });
    await expect(panel.getByRole('heading', { level: 2, name: 'Budgets', exact: true })).toBeVisible();

    const back = panel.getByRole('button', { name: 'Back' });
    const forward = panel.getByRole('button', { name: 'Forward' });
    await expect(back).toBeDisabled();
    await expect(forward).toBeDisabled();

    // Two table-of-contents jumps inside the one page.
    await panel.getByRole('button', { name: 'On this page' }).click();
    const toc = panel.getByRole('navigation', { name: 'Sections on this page' });
    await toc.getByRole('button').nth(1).click();
    await toc.getByRole('button').nth(2).click();
    await expect(back).toBeEnabled();
    await expect(forward).toBeDisabled();

    await back.click();
    await expect(back).toBeEnabled();
    await expect(forward).toBeEnabled();
    await back.click();
    await expect(back).toBeDisabled();
    await expect(forward).toBeEnabled();
    await expect(panel.getByRole('heading', { level: 2, name: 'Budgets', exact: true })).toBeVisible();

    await forward.click();
    await forward.click();
    await expect(forward).toBeDisabled();
    await expect(back).toBeEnabled();
  });

  test('a pinned panel keeps its history when another page\'s "?" opens a different section', async ({
    authedPage: page,
  }) => {
    // `institutions` is { page: 'accounts', section: 'financial-institutions' };
    // `accounts` is the same page from the top.
    await gotoWithGuideKnown(page, '/institutions');
    await page.getByRole('link', { name: 'Help for this page' }).click();
    const panel = page.getByRole('complementary', { name: 'Help' });
    const section = panel.getByRole('heading', { name: 'Financial Institutions', exact: true });
    await expect(section).toBeFocused();
    await panel.getByRole('button', { name: /^Pin the help panel/ }).click();

    // A client-side move to Accounts, so the store survives it.
    await page.getByRole('navigation').getByRole('button', { name: 'Accounts', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Accounts', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Help for this page' }).click();

    await expect(panel.getByRole('button', { name: 'Back' })).toBeEnabled();
    await expect(panel.getByRole('button', { name: 'Forward' })).toBeDisabled();
    await panel.getByRole('button', { name: 'Back' }).click();
    await expect(section).toBeFocused();
    await expect(panel.getByRole('button', { name: 'Back' })).toBeDisabled();
    await expect(panel.getByRole('button', { name: 'Forward' })).toBeEnabled();
  });
});
