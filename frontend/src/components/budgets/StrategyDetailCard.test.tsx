import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { StrategyDetailCard } from './StrategyDetailCard';

describe('StrategyDetailCard', () => {
  it('renders FIXED strategy', () => {
    render(<StrategyDetailCard strategy="FIXED" />);
    expect(screen.getByText('Fixed Budget')).toBeInTheDocument();
    expect(screen.getByText(/Simple to set up/)).toBeInTheDocument();
    expect(screen.getByText(/straightforward budgeting/)).toBeInTheDocument();
  });

  it('renders ROLLOVER strategy', () => {
    render(<StrategyDetailCard strategy="ROLLOVER" />);
    expect(screen.getByText('Rollover Budget')).toBeInTheDocument();
    expect(screen.getByText(/Builds savings/)).toBeInTheDocument();
  });

  it('renders ZERO_BASED strategy', () => {
    render(<StrategyDetailCard strategy="ZERO_BASED" />);
    expect(screen.getByText('Zero-Based Budget')).toBeInTheDocument();
    expect(screen.getByText(/Maximum control/)).toBeInTheDocument();
  });

  it('renders FIFTY_THIRTY_TWENTY strategy', () => {
    render(<StrategyDetailCard strategy="FIFTY_THIRTY_TWENTY" />);
    expect(screen.getByText('50/30/20 Budget')).toBeInTheDocument();
    expect(screen.getByText(/balanced approach/)).toBeInTheDocument();
  });
});
