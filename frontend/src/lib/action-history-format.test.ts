import { describe, it, expect } from 'vitest';
import {
  renderActionDescription,
  KNOWN_DESCRIPTION_KEYS,
} from './action-history-format';

// Minimal stub mimicking next-intl's t(key, values) so the helper can be tested
// without an intl provider: echoes the key, plus any non-empty params.
const t = ((key: string, values?: Record<string, unknown>) =>
  values && Object.keys(values).length
    ? `${key}::${JSON.stringify(values)}`
    : key) as never;

describe('renderActionDescription', () => {
  it('renders a known key through the translator with its params', () => {
    expect(
      renderActionDescription(t, {
        description: 'fallback',
        descriptionKey: 'createdPayee',
        descriptionParams: { name: 'Acme' },
      }),
    ).toBe('actionHistory.descriptions.createdPayee::{"name":"Acme"}');
  });

  it('passes an empty params object for keys without params', () => {
    expect(
      renderActionDescription(t, {
        description: 'fallback',
        descriptionKey: 'transferredSecurity',
        descriptionParams: null,
      }),
    ).toBe('actionHistory.descriptions.transferredSecurity');
  });

  it('falls back to the stored description for an unknown key', () => {
    expect(
      renderActionDescription(t, {
        description: 'Legacy English',
        descriptionKey: 'notAKnownKey',
        descriptionParams: null,
      }),
    ).toBe('Legacy English');
  });

  it('falls back to the stored description when no key is present', () => {
    expect(
      renderActionDescription(t, {
        description: 'Legacy English',
        descriptionKey: null,
        descriptionParams: null,
      }),
    ).toBe('Legacy English');
  });

  it('returns an empty string for a missing item', () => {
    expect(renderActionDescription(t, null)).toBe('');
    expect(renderActionDescription(t, undefined)).toBe('');
  });

  it('covers every description key the backend can emit', () => {
    expect(KNOWN_DESCRIPTION_KEYS.has('createdTransfer')).toBe(true);
    expect(KNOWN_DESCRIPTION_KEYS.size).toBe(39);
  });
});
