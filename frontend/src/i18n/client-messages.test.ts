import { describe, it, expect } from 'vitest';
import {
  PUBLIC_CLIENT_NAMESPACES,
  messageScopeFor,
  messagesForScope,
  withReportNames,
} from './client-messages';

describe('messageScopeFor', () => {
  it('scopes the public pages to the public catalog', () => {
    expect(messageScopeFor('/login')).toBe('public');
    expect(messageScopeFor('/auth/callback')).toBe('public');
  });

  it('gives every other page every catalog', () => {
    expect(messageScopeFor('/dashboard')).toBe('full');
    expect(messageScopeFor('/')).toBe('full');
  });

  it('treats a request the proxy did not see as public', () => {
    expect(messageScopeFor(null)).toBe('public');
  });
});

describe('messagesForScope', () => {
  const messages = {
    auth: { signIn: 'Sign in' },
    common: { save: 'Save' },
    investments: { selectFromAccountFirst: 'Select the From account first' },
  };

  it('keeps only the public namespaces for a public page', () => {
    expect(messagesForScope(messages, 'public')).toEqual({
      auth: messages.auth,
      common: messages.common,
    });
  });

  it('passes every namespace through for the app', () => {
    expect(messagesForScope(messages, 'full')).toBe(messages);
  });

  it('adds only the report titles to a catalog that has them', () => {
    const names = { 'net-worth': 'Net Worth' };
    const out = withReportNames({ reports: { page: { names, other: 'x' } } });
    expect(out).toHaveProperty('reportNames', names);
  });

  it('names only namespaces the loader registers', async () => {
    const { loadMessages } = await import('./messages');
    // `reportNames` is derived at the layout boundary from what the loader returns.
    const loaded = withReportNames(await loadMessages('en'));
    for (const namespace of PUBLIC_CLIENT_NAMESPACES) {
      expect(loaded, namespace).toHaveProperty([namespace]);
    }
  });
});
