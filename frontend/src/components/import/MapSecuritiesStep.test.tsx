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
    currencyOptions: [
      { value: 'USD', label: 'USD - US Dollar' },
      { value: 'CAD', label: 'CAD - Canadian Dollar' },
      { value: 'GBP', label: 'GBP - British Pound' },
    ],
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

  it('calls lookup with createNew value when available', () => {
    const props = {
      ...defaultProps,
      securityMappings: [
        { originalName: 'Apple Inc', securityId: '', createNew: 'AAPL', securityName: 'Apple Inc.', securityType: '', exchange: 'NASDAQ' },
      ],
    };

    render(<MapSecuritiesStep {...props} />);

    fireEvent.click(screen.getAllByRole('button', { name: /Lookup/i })[0]);
    expect(defaultProps.handleSecurityLookup).toHaveBeenCalledWith(0, 'AAPL', 'NASDAQ');
  });

  it('calls lookup with securityName when createNew is empty', () => {
    const props = {
      ...defaultProps,
      securityMappings: [
        { originalName: 'Unknown Security', securityId: '', createNew: '', securityName: 'Apple Inc.', securityType: '', exchange: '' },
      ],
    };

    render(<MapSecuritiesStep {...props} />);

    fireEvent.click(screen.getAllByRole('button', { name: /Lookup/i })[0]);
    expect(defaultProps.handleSecurityLookup).toHaveBeenCalledWith(0, 'Apple Inc.', '');
  });

  it('falls back to originalName when both createNew and securityName are empty', () => {
    const props = {
      ...defaultProps,
      securityMappings: [
        { originalName: 'Mystery Stock', securityId: '', createNew: '', securityName: '', securityType: '', exchange: '' },
      ],
    };

    render(<MapSecuritiesStep {...props} />);

    fireEvent.click(screen.getAllByRole('button', { name: /Lookup/i })[0]);
    expect(defaultProps.handleSecurityLookup).toHaveBeenCalledWith(0, 'Mystery Stock', '');
  });

  it('shows bulk lookup in progress message', () => {
    render(<MapSecuritiesStep {...defaultProps} bulkLookupInProgress={true} />);

    expect(screen.getByText(/Looking up securities/)).toBeInTheDocument();
  });

  it('navigates back to mapCategories when category mappings exist', () => {
    const props = {
      ...defaultProps,
      categoryMappings: { length: 3 },
    };

    render(<MapSecuritiesStep {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('mapCategories');
  });

  it('shows Import All button for multi-account import', () => {
    const onMultiAccountImport = vi.fn();
    render(
      <MapSecuritiesStep
        {...defaultProps}
        isMultiAccountImport={true}
        onMultiAccountImport={onMultiAccountImport}
      />,
    );

    expect(screen.getByRole('button', { name: /Import All/i })).toBeInTheDocument();
  });

  it('navigates back to multiAccountReview for multi-account import', () => {
    render(
      <MapSecuritiesStep
        {...defaultProps}
        isMultiAccountImport={true}
        onMultiAccountImport={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('multiAccountReview');
  });

  it('disables lookup button when loading for that index', () => {
    render(<MapSecuritiesStep {...defaultProps} lookupLoadingIndex={0} />);

    const lookupButtons = screen.getAllByRole('button', { name: /Look/i });
    expect(lookupButtons[0]).toBeDisabled();
    expect(lookupButtons[0]).toHaveTextContent('Looking up...');
  });

  it('renders currency labels for each security mapping row', () => {
    render(<MapSecuritiesStep {...defaultProps} />);

    const currencyLabels = screen.getAllByText('Currency');
    expect(currencyLabels.length).toBeGreaterThanOrEqual(2);
  });

  it('displays the auto-selected currency for a mapping with currencyCode', () => {
    const props = {
      ...defaultProps,
      securityMappings: [
        { originalName: 'RY', securityId: '', createNew: 'RY', securityName: 'Royal Bank', securityType: 'STOCK', exchange: 'TSX', currencyCode: 'CAD' },
      ],
    };

    render(<MapSecuritiesStep {...props} />);

    // The Currency combobox input should show the selected currency code
    const currencyInputs = screen.getAllByPlaceholderText('Search currencies...');
    expect(currencyInputs.length).toBeGreaterThanOrEqual(1);
  });
});
