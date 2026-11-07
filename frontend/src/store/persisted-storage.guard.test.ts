import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The ZAP baseline scan reports every entry it finds in localStorage on a
 * public page (rule 120000, INFO risk), and `.github/zap/rules.tsv` silences
 * that rule on a single claim: everything the app writes before login is a
 * zustand persist envelope carrying no user data, no credential and no PII.
 *
 * That claim is about the source, so it is checked here rather than left in a
 * comment. The IGNORE line would otherwise outlive the footprint it was
 * written for -- a new persisted store, or a widened `partialize`, silently
 * ships under a rule that was silenced for something else.
 */

// Every localStorage key a zustand store owns, and why it is allowed to be
// there. A new persisted store means a line here, which is the moment to ask
// whether its contents belong in storage an XSS can read.
const PERSISTED_STORE_KEYS: Record<string, string> = {
  'auth-storage':
    'pre-login: the isAuthenticated flag alone. The profile is refetched from the API, the token lives in an httpOnly cookie.',
  'monize-preferences':
    'pre-login: null until a session loads preferences; display settings only, cleared by logout().',
  'monize:ai-chat-messages':
    'authenticated only: written after login, removed by logout() so conversations do not cross accounts.',
  'monize-density':
    'authenticated only: the store is imported by the list components, none of which the login page renders. One of three row-density levels -- a fact about the screen, not the account, so it survives logout deliberately.',
  'monize-hidden-columns':
    'authenticated only: the store is imported by the list components and Settings, none of which the login page renders. Hideable column ids per table kind -- a fact about the screen, not the account, so it survives logout deliberately. It names columns, never their contents.',
  'monize-register-date-display':
    'authenticated only: imported by the transaction register, which the login page never renders. A single boolean (drop the year from register dates on phone widths) -- a fact about the screen, not the account, so it survives logout deliberately.',
  'monize-settings-sections':
    'authenticated only: imported by the Settings page, which no unauthenticated route renders. One boolean per named Settings section, saying whether the reader has folded it away -- a fact about the screen, not the account, so it survives logout deliberately. It names sections, never their contents.',
  'monize-view-mode':
    'authenticated only: the store is imported by the Transactions, Investments and Bills & Deposits pages, none of which an unauthenticated route renders. Which of the two views a screen is on and which calendar layers are switched on -- a fact about the screen, not the account, so it survives logout deliberately. It names layers, never an account, a figure or a filter.',
  'monize-scan-settings':
    'authenticated only: imported by the document scan dialog, which only the transaction attachment flow renders. The last-used scan finish and the two slider offsets (brightness, contrast) -- a capture habit, not account data -- so it survives logout deliberately. It holds no document and no pixels.',
  'monize-help-width':
    'authenticated only: written only when the reader resizes the docked help panel, which exists only in the signed-in shell, and importing the store writes nothing (checked below). A panel width in pixels -- a fact about the screen, not the account, so it survives logout deliberately. It holds no personal data.',
};

// What an unauthenticated visitor's browser holds, verbatim. These are the two
// entries ZAP reports on /login.
const PRE_LOGIN_FOOTPRINT: Record<string, string> = {
  'auth-storage': '{"state":{"isAuthenticated":false},"version":0}',
  'monize-preferences': '{"state":{"preferences":null},"version":0}',
};

const STORE_DIR = path.join(process.cwd(), 'src', 'store');

// zustand's persist config as this codebase writes it: the storage name
// immediately followed by the localStorage-backed storage engine. The name is
// a string literal in two stores and an exported constant in the third.
const LOCAL_STORAGE_PERSIST_RE =
  /name:\s*([^,\n]+),\s*\n\s*storage:\s*createJSONStorage\(\(\)\s*=>\s*localStorage\)/g;

function resolveStorageName(nameExpr: string, source: string): string {
  const literal = nameExpr.match(/^(['"])(.*)\1$/);
  if (literal) return literal[2];

  const constant = source.match(
    new RegExp(`\\b${nameExpr.trim()}\\s*=\\s*(['"])(.*?)\\1`),
  );
  // An unresolvable name is a hole in the scan, so surface the expression
  // itself and let the classification assertion fail on it.
  return constant ? constant[2] : nameExpr.trim();
}

function readStoreSources(): { file: string; source: string }[] {
  return fs
    .readdirSync(STORE_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((file) => ({
      file,
      source: fs.readFileSync(path.join(STORE_DIR, file), 'utf8'),
    }));
}

describe('persisted browser storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('has every localStorage-backed store classified', () => {
    const found = new Map<string, string>();

    for (const { file, source } of readStoreSources()) {
      const matches = [...source.matchAll(LOCAL_STORAGE_PERSIST_RE)];

      if (/\bpersist\(/.test(source)) {
        // A persisted store whose config this scan cannot read is not
        // evidence of safety -- it is a hole in the scan.
        expect(
          matches.length,
          `${file} calls persist() but no "name: ... storage: createJSONStorage(() => localStorage)" pair was found. ` +
            'Follow the existing shape, or this guard stops covering it.',
        ).toBeGreaterThan(0);
      }

      for (const match of matches) {
        found.set(resolveStorageName(match[1], source), file);
      }
    }

    expect(
      [...found.keys()].sort(),
      'A store persisting to localStorage must be listed in PERSISTED_STORE_KEYS with the reason its contents may sit in storage that any XSS can read.',
    ).toEqual(Object.keys(PERSISTED_STORE_KEYS).sort());
  });

  it('writes only the two non-identifying envelopes before login', async () => {
    vi.resetModules();
    window.localStorage.clear();

    await import('./authStore');
    await import('./preferencesStore');

    const written: Record<string, string> = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)!;
      written[key] = window.localStorage.getItem(key)!;
    }

    // Exact values, not a shape check: the claim in rules.tsv is about what a
    // scanner reads off an unauthenticated page, so anything new in either
    // envelope has to be looked at.
    expect(written).toEqual(PRE_LOGIN_FOOTPRINT);
  });

  it('writes nothing for the help panel width until the reader resizes the panel', async () => {
    vi.resetModules();
    window.localStorage.clear();

    // The store is imported by the shell, which also renders the sign-in screens,
    // so its key may not appear merely because the module loaded.
    const { useHelpWidthStore } = await import('./helpWidthStore');
    expect(window.localStorage.getItem('monize-help-width')).toBeNull();

    useHelpWidthStore.getState().setWidth(600);
    expect(JSON.parse(window.localStorage.getItem('monize-help-width')!)).toEqual({
      state: { width: 600 },
      version: 0,
    });
  });

  it('persists the auth flag alone, never the profile, token or delegation context', async () => {
    const { useAuthStore } = await import('./authStore');
    const partialize = useAuthStore.persist.getOptions().partialize!;

    const persisted = partialize({
      ...useAuthStore.getState(),
      user: {
        id: 'user-1',
        email: 'someone@example.com',
        firstName: 'Some',
        lastName: 'One',
        role: 'admin',
      } as never,
      token: 'a.jwt.token',
      isAuthenticated: true,
      actingAsUserId: 'owner-1',
      availableContexts: [{ userId: 'owner-1' }] as never,
      delegateCapabilities: { canViewTransactions: true } as never,
      delegateSections: { transactions: true } as never,
    });

    expect(persisted).toEqual({ isAuthenticated: true });
  });
});
