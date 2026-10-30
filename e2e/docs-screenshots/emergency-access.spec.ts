import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { apiFor, open } from '../readme/session';
import { SHOTS_PASSWORD } from '../readme/settings';
import { cardOf, docShot, openDocsSession } from './capture';

// website/docs/emergency-access.md.
//
// The stack the pictures are taken from has no SMTP server, and the page
// disables everything that needs email when the server says so. Except for the
// first picture (which shows exactly that warning), the server's answer is
// passed through with `emailConfigured` switched on, so the page is drawn as it
// is on a server that can send email. Nothing else in the answer is changed.
//
// Showcase data: two emergency contacts on the demo user, added through the API
// on the first run (the API accepts contacts without email; only the button is
// disabled). Settings are never saved, the message is never saved, and the
// dialogs are closed with Cancel.

const CONTACTS = [
  { firstName: 'Jordan', email: 'jordan.lee@monize.example' },
  { firstName: 'Riley', email: 'riley.morgan@monize.example' },
];

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await openDocsSession(browser);
  page = await context.newPage();
  await page.goto('/dashboard');
  const api = apiFor(page);
  const view = await api.get<{ contacts: { email: string }[] }>('/emergency-access');
  for (const contact of CONTACTS) {
    if (!view.contacts.some((c) => c.email.toLowerCase() === contact.email)) {
      await api.post('/emergency-access/contacts', contact);
    }
  }
});

test.afterAll(async () => {
  await context.close();
});

/** Draw the page as a server with email configured would. */
async function withEmailConfigured(): Promise<void> {
  await page.route(/\/api\/v1\/emergency-access$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, emailConfigured: true } });
  });
}

async function openEmergencyAccess(): Promise<void> {
  await open(page, '/settings/emergency-access');
  await expect(page.getByRole('heading', { name: 'Emergency Contacts' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(CONTACTS[0].email)).toBeVisible();
}

test('emergency-access-email-warning', async () => {
  await page.unrouteAll({ behavior: 'wait' });
  await openEmergencyAccess();
  const warning = cardOf(page.getByRole('heading', { name: 'Email is not configured' }));
  await expect(warning).toBeVisible();
  await docShot(page, 'emergency-access-email-warning', warning);
});

test.describe('on a server that can send email', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await withEmailConfigured();
  });

  test.afterAll(async () => {
    await page.unrouteAll({ behavior: 'wait' });
  });

  test('emergency-access-settings', async () => {
    await openEmergencyAccess();
    await expect(page.getByRole('switch', { name: 'Enable emergency access' })).toBeEnabled();
    await docShot(page, 'emergency-access-settings');
  });

  test('emergency-access-add-contact', async () => {
    await openEmergencyAccess();
    await page.getByRole('button', { name: 'Add contact' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add emergency contact' })).toBeVisible();
    await dialog.getByLabel('First name').fill('Alex');
    await dialog.getByLabel('Email').fill('alex.kim@monize.example');
    await docShot(page, 'emergency-access-add-contact', dialog);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  test('emergency-access-verify', async () => {
    await openEmergencyAccess();
    await page.getByRole('button', { name: /^(Add|Edit) message$/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText("Confirm it's you")).toBeVisible();
    await docShot(page, 'emergency-access-verify', dialog);
  });

  test('emergency-access-message', async () => {
    // Verified with the demo user's own password; the message is typed into
    // the editor and never saved.
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Password').fill(SHOTS_PASSWORD);
    await dialog.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(dialog).toBeHidden();
    const editor = page.getByPlaceholder(
      'Notes, instructions, locations of important documents...',
    );
    await expect(editor).toBeVisible();
    await editor.fill(
      'The paper files are in the grey cabinet in the study, top drawer.\n' +
        'The password manager emergency kit is in the safe-deposit box at the Main Street branch.\n' +
        'Call Morgan at the accounting firm before filing anything with the tax office.',
    );
    const card = cardOf(page.getByRole('heading', { name: 'Message to your contacts' }));
    await expect(card.getByText(/Unlocked for/)).toBeVisible();
    await docShot(page, 'emergency-access-message', card);
    await card.getByRole('button', { name: 'Lock now' }).click();
    await expect(editor).toBeHidden();
  });
});
