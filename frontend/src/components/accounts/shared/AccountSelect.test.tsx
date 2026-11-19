import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { AccountSelect } from './AccountSelect';
import type { AccountSelectOption } from '@/lib/account-utils';

const { getAllInstitutions } = vi.hoisted(() => ({ getAllInstitutions: vi.fn() }));
vi.mock('@/lib/institutions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/institutions')>()),
  institutionsApi: { getAll: getAllInstitutions },
}));

const options: AccountSelectOption[] = [
  { value: '', label: 'Select account...' },
  { value: 'a-1', label: 'Everyday (CAD)', accountType: 'CHEQUING', institutionId: 'inst-1' },
  { value: 'a-2', label: 'Wallet (CAD)', accountType: 'CASH', institutionId: null },
];

describe('AccountSelect', () => {
  it("marks each account with its institution's logo, else its type icon, and the placeholder with neither", async () => {
    getAllInstitutions.mockResolvedValue([{ id: 'inst-1', name: 'Big Bank', hasLogo: true }]);
    render(<AccountSelect label="Account" options={options} value="" onChange={vi.fn()} />);
    await waitFor(() => expect(getAllInstitutions).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(screen.getByRole('combobox', { name: 'Account' }));
    const [placeholder, banked, loose] = screen.getAllByRole('option');
    expect(placeholder.querySelector('img, svg')).toBeNull();
    await waitFor(() =>
      expect(banked.querySelector('img')?.getAttribute('src')).toBe('/api/v1/institutions/inst-1/logo'),
    );
    expect(loose.querySelector('img')).toBeNull();
    expect(loose.querySelector('svg')).not.toBeNull();
  });

  it("shows the picked account's mark in the closed field", async () => {
    getAllInstitutions.mockResolvedValue([]);
    render(<AccountSelect label="Account" options={options} value="a-2" onChange={vi.fn()} />);
    await act(async () => {});
    const trigger = screen.getByRole('combobox', { name: 'Account' });
    expect(trigger).toHaveTextContent('Wallet (CAD)');
    // The mark leads the field, before the label; the chevron trails it.
    const mark = trigger.firstElementChild as HTMLElement;
    expect(mark).not.toHaveTextContent('Wallet');
    expect(mark.querySelector('svg')).not.toBeNull();
  });
});
