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
});
