import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { MapSecuritiesStep } from './MapSecuritiesStep';

describe('MapSecuritiesStep', () => {
  const defaultProps = {
    securityMappings: [
      { originalName: 'AAPL', securityId: '', createNew: '', securityName: '', securityType: '' },
      { originalName: 'GOOG', securityId: 'sec-1', createNew: '', securityName: '', securityType: '' },
    ],
    handleSecurityMappingChange: vi.fn(),
    handleSecurityLookup: vi.fn(),
    lookupLoadingIndex: null,
    bulkLookupInProgress: false,
    securityOptions: [{ value: 'sec-1', label: 'Alphabet Inc' }],
    securityTypeOptions: [{ value: 'STOCK', label: 'Stock' }],
    categoryMappings: { length: 0 },
    shouldShowMapAccounts: false,
    setStep: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the heading', () => {
    render(<MapSecuritiesStep {...defaultProps} />);

    expect(screen.getByText('Map Securities')).toBeInTheDocument();
  });

  it('shows needs attention and ready counts', () => {
    render(<MapSecuritiesStep {...defaultProps} />);

    expect(screen.getByText(/1 need/)).toBeInTheDocument();
    expect(screen.getByText(/1 ready/)).toBeInTheDocument();
  });

  it('renders security mapping rows', () => {
    render(<MapSecuritiesStep {...defaultProps} />);

    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('GOOG')).toBeInTheDocument();
  });

  it('navigates to review when Next is clicked and no accounts to map', () => {
    render(<MapSecuritiesStep {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('review');
  });

  it('navigates to mapAccounts when shouldShowMapAccounts is true', () => {
    render(<MapSecuritiesStep {...defaultProps} shouldShowMapAccounts={true} />);

    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('mapAccounts');
  });

  it('navigates back to selectAccount when no category mappings', () => {
    render(<MapSecuritiesStep {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('selectAccount');
  });
});
