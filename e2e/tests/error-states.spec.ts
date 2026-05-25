import { test, expect } from '../fixtures';

// Error-path coverage: when a backing API call fails, the page should surface a
// friendly message rather than crash or hang. We intercept the list endpoint
// and force a 500 with no body, so getErrorMessage falls back to the page's
// default copy. Interception is installed after the authedPage fixture has
// registered, so only the page-under-test's load is affected.
test.describe('Error handling', () => {
  test('shows a friendly error when tags fail to load', async ({
    authedPage: page,
  }) => {
    // Tags aren't fetched during registration/dashboard load, so the page makes
    // a live request the route can intercept. (Categories are pre-cached by the
    // dashboard, so a /categories intercept would never fire.)
    await page.route('**/api/v1/tags**', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    );

    await page.goto('/tags');

    await expect(page.getByText('Failed to load tags')).toBeVisible();
  });

  test('shows a friendly error when securities fail to load', async ({
    authedPage: page,
  }) => {
    await page.route('**/api/v1/securities**', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    );

    await page.goto('/securities');

    await expect(page.getByText('Failed to load securities')).toBeVisible();
  });
});
