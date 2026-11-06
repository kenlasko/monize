import { test, expect } from '../fixtures';

// The page header's "?" opens the user guide in a panel beside the page instead
// of in a new browser tab. The guide ships in the backend (the e2e stack builds
// the development image, which copies website/docs), so this runs offline.
test.describe('Help panel', () => {
  test('the Budgets "?" opens the Budgets guide in place, with no new tab', async ({
    authedPage: page,
    context,
  }) => {
    await page.goto('/budgets');
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
    await page.goto('/budgets');
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
    await page.goto('/budgets');
    const help = page.getByRole('link', { name: 'Help for this page' });

    // The icon is still a link to the same page on monize.net.
    await expect(help).toHaveAttribute('href', 'https://www.monize.net/docs/budgets');

    await help.click();
    const panel = page.getByRole('complementary', { name: 'Help' });
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  });
});
