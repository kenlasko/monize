import { describe, it, expect } from 'vitest';
import { render } from '@/test/render';
import {
  ACCOUNT_TYPE_META,
  accountTypePillClass,
  AccountTypeIcon,
  AccountTypePill,
} from './account-type-meta';
import type { AccountType } from '@/types/account';

const ALL_TYPES = Object.keys(ACCOUNT_TYPE_META) as AccountType[];

describe('account-type-meta', () => {
  it('gives every account type a pill class and an icon', () => {
    for (const type of ALL_TYPES) {
      expect(ACCOUNT_TYPE_META[type].pillClass).toMatch(/bg-\w+-100 text-\w+-800/);
      expect(ACCOUNT_TYPE_META[type].Icon).toBeTruthy();
    }
  });

  it('gives a crypto wallet its own amber pill and icon', () => {
    expect(ACCOUNT_TYPE_META.CRYPTO.pillClass).toBe(
      'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
    );
    const others = ALL_TYPES.filter((type) => type !== 'CRYPTO');
    for (const type of others) {
      expect(ACCOUNT_TYPE_META[type].pillClass).not.toBe(ACCOUNT_TYPE_META.CRYPTO.pillClass);
      expect(ACCOUNT_TYPE_META[type].Icon).not.toBe(ACCOUNT_TYPE_META.CRYPTO.Icon);
    }
  });

  it('falls back to the OTHER treatment for an unknown type', () => {
    expect(accountTypePillClass('SOMETHING_NEW' as AccountType)).toBe(
      ACCOUNT_TYPE_META.OTHER.pillClass,
    );
  });

  it('renders the pill with its icon and label', () => {
    const { getByText, container } = render(
      <AccountTypePill type="CHEQUING">Chequing</AccountTypePill>,
    );
    expect(getByText('Chequing')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeTruthy();
    expect((container.firstElementChild as HTMLElement).className).toContain('bg-blue-100');
  });

  it('renders the bare icon as decoration', () => {
    const { container } = render(<AccountTypeIcon type="SAVINGS" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });
});
