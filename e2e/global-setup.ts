import { request, type FullConfig } from '@playwright/test';
import { ADMIN_CREDS } from './helpers/admin-creds';

// The first user ever registered becomes an admin (AuthService: role is "admin"
// when userCount === 0). The e2e stack starts with a fresh DB, so registering
// the fixed admin here -- before any test runs -- yields a known admin account.
// No credentials are written to disk; the admin fixture imports ADMIN_CREDS.
async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL =
    config.projects[0]?.use?.baseURL ||
    process.env.BASE_URL ||
    'http://localhost:3001';

  const ctx = await request.newContext({ baseURL });
  const res = await ctx.post('/api/v1/auth/register', { data: ADMIN_CREDS });
  await ctx.dispose();

  // A fresh CI database makes this the first user (=> admin). On a re-used
  // local database the account may already exist, which is fine; any other
  // failure is fatal.
  if (!res.ok()) {
    const body = await res.text();
    if (res.status() !== 409 && !/already (exists|registered|in use)/i.test(body)) {
      throw new Error(`Admin registration failed (${res.status()}): ${body}`);
    }
  }
}

export default globalSetup;
