import { describe, it, expect } from 'vitest';
import { ACCOUNT_ACTION_LABELS_MIN_WIDTH, accountActionDensity } from './account-list-columns';

describe('accountActionDensity', () => {
  it('swaps Normal text actions for icons on a table narrower than their labels need', () => {
    expect(accountActionDensity('normal', ACCOUNT_ACTION_LABELS_MIN_WIDTH - 1)).toBe('compact');
    expect(accountActionDensity('normal', ACCOUNT_ACTION_LABELS_MIN_WIDTH)).toBe('normal');
  });

  it('keeps Normal text actions until the table has been measured', () => {
    expect(accountActionDensity('normal', null)).toBe('normal');
  });

  it('leaves Compact and Dense, already icon-only, as they are', () => {
    expect(accountActionDensity('compact', 500)).toBe('compact');
    expect(accountActionDensity('dense', 500)).toBe('dense');
  });
});
