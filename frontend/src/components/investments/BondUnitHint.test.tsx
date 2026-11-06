import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { BondUnitHint } from './BondUnitHint';
import { investmentsApi } from '@/lib/investments';

vi.mock('@/lib/investments', () => ({
  investmentsApi: { listBondPrograms: vi.fn() },
}));

const list = vi.mocked(investmentsApi.listBondPrograms);
const note = {
  id: 'p-note',
  issuerCountryCode: 'US',
  issuerCode: 'US_TREASURY',
  programCode: 'NOTE',
  currency: 'USD',
  seriesCount: 0,
  newestSeriesCode: null,
  faceValue: '100',
};

async function mount(programId: string | null | undefined) {
  await act(async () => {
    render(<BondUnitHint programId={programId} />);
  });
}

describe('BondUnitHint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue([note]);
  });

  it("says what one unit of the program's face value is", async () => {
    await mount('p-note');
    expect(screen.getByTestId('bond-unit-hint')).toHaveTextContent(
      'One unit = 100 USD face value',
    );
  });

  it('asks and shows nothing for a security that is not linked to a program', async () => {
    await mount(null);
    expect(list).not.toHaveBeenCalled();
    expect(screen.queryByTestId('bond-unit-hint')).toBeNull();
  });

  it('shows nothing when the catalog states no face value or lacks the program', async () => {
    list.mockResolvedValue([{ ...note, faceValue: null }]);
    await mount('p-note');
    expect(screen.queryByTestId('bond-unit-hint')).toBeNull();
    list.mockResolvedValue([note]);
    await mount('p-other');
    expect(screen.queryByTestId('bond-unit-hint')).toBeNull();
  });

  it('shows nothing when the catalog cannot be read', async () => {
    list.mockRejectedValue(new Error('offline'));
    await mount('p-note');
    expect(screen.queryByTestId('bond-unit-hint')).toBeNull();
  });

  it('says what a price is for a program whose securities trade: the cash price of one unit, without accrued interest', async () => {
    list.mockResolvedValue([{ ...note, cashPriced: true, indexedPrincipal: false }]);
    await mount('p-note');
    expect(screen.getByTestId('bond-unit-hint')).toHaveTextContent(
      'One unit = 100 USD face value The price is the cash price of one unit (100 USD face value), without accrued interest.',
    );
  });

  it('names the inflation adjustment for an indexed principal: quoted price x index ratio', async () => {
    list.mockResolvedValue([{ ...note, cashPriced: true, indexedPrincipal: true }]);
    await mount('p-note');
    expect(screen.getByTestId('bond-unit-hint')).toHaveTextContent(
      'including the inflation adjustment (quoted price x index ratio)',
    );
  });

  it('leaves the unit sentence out where only the price is entered', async () => {
    list.mockResolvedValue([{ ...note, cashPriced: true, indexedPrincipal: true }]);
    await act(async () => {
      render(<BondUnitHint programId="p-note" showUnit={false} />);
    });
    const text = screen.getByTestId('bond-unit-hint').textContent ?? '';
    expect(text.startsWith('The price is the cash price of one unit (100 USD face value)')).toBe(true);
    expect(text).not.toContain('One unit =');
  });

  it('says nothing about a price for a program that is not cash-priced, and nothing at all without the unit', async () => {
    await act(async () => {
      render(<BondUnitHint programId="p-note" showUnit={false} />);
    });
    expect(screen.queryByTestId('bond-unit-hint')).toBeNull();
  });
});
