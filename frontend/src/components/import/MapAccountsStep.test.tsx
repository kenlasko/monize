import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { MapAccountsStep } from './MapAccountsStep';
import { createRef } from 'react';

describe('MapAccountsStep', () => {
  const defaultProps = {
    accountMappings: [
      { originalName: 'Brokerage Cash', accountId: '', createNew: false, newAccountName: '', accountType: 'CHEQUING', currencyCode: 'CAD' },
    ],
    handleAccountMappingChange: vi.fn(),
    accountOptions: [{ value: 'acc-1', label: 'Main Chequing' }],
    accountTypeOptions: [{ value: 'CHEQUING', label: 'Chequing' }, { value: 'SAVINGS', label: 'Savings' }],
    currencyOptions: [{ value: 'CAD', label: 'CAD' }, { value: 'USD', label: 'USD' }],
    defaultCurrency: 'CAD',
    scrollContainerRef: createRef<HTMLDivElement>(),
    categoryMappings: { length: 0 },
    securityMappings: { length: 0 },
    setStep: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the heading', () => {
    render(<MapAccountsStep {...defaultProps} />);

    expect(screen.getByText('Map Transfer Accounts')).toBeInTheDocument();
  });

  it('renders account mapping rows', () => {
    render(<MapAccountsStep {...defaultProps} />);

    expect(screen.getByText('Brokerage Cash')).toBeInTheDocument();
  });

  it('navigates to review when Next is clicked', () => {
    render(<MapAccountsStep {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('review');
  });

  it('navigates back correctly when no security mappings', () => {
    render(<MapAccountsStep {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('selectAccount');
  });

  it('navigates back to mapSecurities when security mappings exist', () => {
    render(<MapAccountsStep {...defaultProps} securityMappings={{ length: 2 }} />);

    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('mapSecurities');
  });
});
