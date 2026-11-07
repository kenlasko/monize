import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures';

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

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
// the development image, which copies website/docs and its screenshots), so this
// runs offline.
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

  test('a screenshot loads in the panel from the backend, as WebP', async ({
    authedPage: page,
  }) => {
    await gotoWithGuideKnown(page, '/budgets');
    // The development image the e2e stack runs bundles the screenshots as WebP,
    // the format production ships; the request stays on the app's own origin.
    const picture = page.waitForResponse(
      (r) => new URL(r.url()).pathname.startsWith('/api/v1/help/images/budgets-page') && r.ok(),
    );
    await page.getByRole('link', { name: 'Help for this page' }).click();

    const panel = page.getByRole('complementary', { name: 'Help' });
    const img = panel.getByRole('img', { name: /^The Budgets page, listing each budget/ });
    await img.scrollIntoViewIfNeeded();

    const response = await picture;
    expect(new URL(response.url()).origin).toBe(new URL(page.url()).origin);
    expect(response.headers()['content-type']).toBe('image/webp');
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)))
      .toBeGreaterThan(0);
    // The way to the same picture on monize.net stays with it.
    await expect(panel.getByRole('link', { name: 'View screenshot on monize.net' }).first()).toBeVisible();
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

// Classic scrollbars, which take layout width and are what a Windows desktop
// draws: headless Chromium hides them unless told not to (a launch option, so
// it applies to the whole file). Firefox in the Playwright image draws overlay
// scrollbars, the other case the panel has to work in, so the scrollbar test
// measures which kind it got and asserts the layout that kind needs.
test.describe('Help panel on a desktop', () => {
  test.use({ viewport: { width: 1440, height: 800 } });

  // Settings is a long page, so the page has a scrollbar of its own.
  async function openSettingsHelp(page: Page) {
    await gotoWithGuideKnown(page, '/settings');
    await page.getByRole('link', { name: 'Help for this page' }).click();
    const panel = page.getByRole('complementary', { name: 'Help' });
    await expect(panel.getByRole('heading', { level: 2, name: 'Settings and Security', exact: true })).toBeVisible();
    return panel;
  }

  const panelWidth = (panel: Locator) =>
    panel.evaluate((el) => Math.round(el.getBoundingClientRect().width));

  test('the panel scrollbar sits clear of the page scrollbar, and both scroll', async ({
    authedPage: page,
    browserName,
  }) => {
    const panel = await openSettingsHelp(page);
    const scroller = panel.getByLabel('Settings and Security', { exact: true }).last();

    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const sc = document.querySelector<HTMLElement>('[role="complementary"] [tabindex="0"][aria-label="Settings and Security"]')!;
      const r = sc.getBoundingClientRect();
      const hit = document.elementFromPoint(r.right - 2, r.top + 200);
      return {
        pageScrollbar: window.innerWidth - de.clientWidth,
        clientWidth: de.clientWidth,
        scrollerRight: r.right,
        scrollerBarWidth: sc.offsetWidth - sc.clientWidth,
        hitIsScroller: hit === sc,
        pageScrolls: de.scrollHeight > de.clientHeight,
        panelScrolls: sc.scrollHeight > sc.clientHeight,
      };
    });
    // The measurement means something only if there is a page scrollbar to
    // collide with and a panel to scroll.
    expect(m.pageScrolls).toBe(true);
    expect(m.panelScrolls).toBe(true);
    // Which kind of scrollbar each browser really drew is asserted, not assumed,
    // so a project cannot pass the branch below that its scrollbars never reach:
    // Chromium launched without --hide-scrollbars draws classic ones, and Firefox
    // in the Playwright image draws overlay ones (the page scrollbar takes no
    // layout width, the case the 16px inset exists for).
    if (browserName === 'chromium') expect(m.pageScrollbar).toBeGreaterThan(0);
    if (browserName === 'firefox') expect(m.pageScrollbar).toBe(0);

    if (m.pageScrollbar > 0) {
      // Classic: the panel ends where the page's scrollbar begins, and its own
      // scrollbar is inside that.
      expect(m.scrollerRight).toBeLessThanOrEqual(m.clientWidth);
      expect(m.scrollerBarWidth).toBeGreaterThan(0);
    } else {
      // Overlay: the page's scrollbar floats over the window's right edge, so
      // the panel's scroller must stop short of it.
      expect(m.scrollerRight).toBeLessThanOrEqual(m.clientWidth - 16);
    }
    // The pointer at the scroller's scrollbar reaches the scroller, not the page.
    expect(m.hitIsScroller).toBe(true);

    // Each scrolls on its own: the wheel over the panel moves the panel, over
    // the page moves the page.
    const box = (await scroller.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    await page.mouse.move(300, 400);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  test('the panel is resized by dragging its left edge, and the page makes room', async ({
    authedPage: page,
  }) => {
    const panel = await openSettingsHelp(page);
    expect(await panelWidth(panel)).toBe(420);

    const handle = panel.getByRole('separator', { name: 'Resize the help panel' });
    await expect(handle).toHaveAttribute('aria-valuenow', '420');
    const box = (await handle.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    // Past the panel's own strip: the pointer is captured, so it keeps steering.
    await page.mouse.move(box.x + box.width / 2 - 60, y, { steps: 4 });
    await page.mouse.move(box.x + box.width / 2 - 100, y, { steps: 4 });
    await page.mouse.up();

    await expect.poll(() => panelWidth(panel)).toBe(520);
    await expect(handle).toHaveAttribute('aria-valuenow', '520');
    // The shell reserves the same room beside the page (xl).
    const reserved = await panel.evaluate((el) =>
      parseFloat(getComputedStyle(el.parentElement!).paddingRight),
    );
    expect(reserved).toBe(520);

    // It is remembered in this browser: reload and open again.
    // The wait is registered before the reload, so a fast answer is not missed.
    const manifest = page.waitForResponse(
      (r) => new URL(r.url()).pathname.endsWith('/help') && r.ok(),
    );
    await page.reload();
    await (await manifest).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await page.getByRole('link', { name: 'Help for this page' }).click();
    await expect.poll(() => panelWidth(panel)).toBe(520);
  });

  test('the edge works from the keyboard, and the width is held to the window', async ({
    authedPage: page,
  }) => {
    const panel = await openSettingsHelp(page);
    const handle = panel.getByRole('separator', { name: 'Resize the help panel' });
    await handle.focus();

    await page.keyboard.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', '444');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '396');
    await page.keyboard.press('Home');
    await expect(handle).toHaveAttribute('aria-valuenow', '320');
    await page.keyboard.press('End');
    // Beside the page (xl) the page keeps 640px of its own: the widest is the
    // smaller of 960, 70% of the document and the document minus 640.
    const wide = await page.evaluate(() => {
      const c = document.documentElement.clientWidth;
      return Math.min(960, Math.floor(c * 0.7), c - 640);
    });
    expect(wide).toBeGreaterThan(700);
    await expect(handle).toHaveAttribute('aria-valuenow', String(wide));
    expect(await panelWidth(panel)).toBe(wide);

    // A narrower window (below xl, where the panel overlays the page) takes the
    // panel down with it (70%), and a wider one
    // gives the width back, because the reader's choice was never overwritten.
    await page.setViewportSize({ width: 1000, height: 800 });
    // 70% of the document's width, which a classic page scrollbar narrows.
    const max = await page.evaluate(() => Math.floor(document.documentElement.clientWidth * 0.7));
    expect(max).toBeGreaterThanOrEqual(680);
    expect(max).toBeLessThanOrEqual(700);
    await expect(handle).toHaveAttribute('aria-valuemax', String(max));
    await expect.poll(() => panelWidth(panel)).toBe(max);
    await page.setViewportSize({ width: 1440, height: 800 });
    await expect.poll(() => panelWidth(panel)).toBe(wide);
  });
});
