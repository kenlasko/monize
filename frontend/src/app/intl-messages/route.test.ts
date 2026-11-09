import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { loadMessages } from '@/i18n/messages';

function get(query: string) {
  return GET(new NextRequest(`https://monize.example/intl-messages${query}`));
}

describe('GET /intl-messages', () => {
  it('returns every namespace for the requested locale', async () => {
    const response = await get('?locale=fr');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(await loadMessages('fr'));
  });

  it('keeps the report titles the app shell reads after a sign-in', async () => {
    const body = await (await get('?locale=en')).json();
    expect(body.reportNames['spending-by-payee']).toBe('Spending by Payee');
  });

  it('falls back to the default locale for an unsupported one', async () => {
    const response = await get('?locale=not-a-locale');
    expect(await response.json()).toEqual(await loadMessages('en'));
  });

  it('is never stored by a shared cache', async () => {
    const response = await get('?locale=en');
    expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
  });
});
