import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BANK_SYNC_REMINDER_MARKS } from '@/hooks/useNotificationCopy';
import { BANK_SYNC_NOTIFY_SUCCESS_MODES } from '@/types/bank-sync';

/**
 * Two lists the bank sync notifications share with the server, mirrored by hand
 * because nothing compiles the layers against each other
 * (`docs/specs/bank-sync-notifications.md`):
 *
 *   * the consent reminder marks. The server writes the mark it reached into the
 *     row (`data.threshold`) and the client renders only a mark it knows, falling
 *     back to the stored English otherwise. A mark added on the server and not
 *     here would make every such reminder show in English.
 *   * the success modes. The select offers exactly the modes the database CHECK
 *     and the PATCH validator accept; one the server does not know is a 400, and
 *     one the select lacks is a setting nobody can choose.
 */
const BACKEND = resolve(__dirname, '../../../backend/src/bank-sync');

function listFrom(file: string, constant: string): number[] | string[] {
  const source = readFileSync(resolve(BACKEND, file), 'utf8');
  const block = new RegExp(`export const ${constant}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!block) {
    throw new Error(`${constant} not found in ${file} -- this guard has lost its subject`);
  }
  const items = block[1]
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return items.every((item) => /^\d+$/.test(item))
    ? items.map(Number)
    : items.map((item) => item.replace(/^["']|["']$/g, ''));
}

describe('bank sync notification contract with the server', () => {
  it('renders exactly the consent reminder marks the server writes, in order', () => {
    expect(listFrom('bank-sync-notifications.ts', 'CONSENT_REMINDER_THRESHOLDS')).toEqual([
      ...BANK_SYNC_REMINDER_MARKS,
    ]);
  });

  it('offers exactly the success modes the server accepts, in order', () => {
    expect(listFrom('bank-sync.constants.ts', 'BANK_SYNC_NOTIFY_SUCCESS_MODES')).toEqual([
      ...BANK_SYNC_NOTIFY_SUCCESS_MODES,
    ]);
  });

  it('finds the lists it compares', () => {
    expect(BANK_SYNC_REMINDER_MARKS.length).toBeGreaterThan(0);
    expect(BANK_SYNC_NOTIFY_SUCCESS_MODES.length).toBeGreaterThan(0);
  });
});
