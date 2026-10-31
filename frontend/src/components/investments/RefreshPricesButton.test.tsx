import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@/test/render';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { usePreferencesStore } from '@/store/preferencesStore';
import { RefreshPricesButton } from './RefreshPricesButton';

describe('RefreshPricesButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00.000Z'));
  });

  afterEach(() => {
    cleanup();
    usePreferencesStore.setState({ preferences: null });
    vi.useRealTimers();
  });

  it('calls onClick when pressed', () => {
    const onClick = vi.fn();
    render(<RefreshPricesButton onClick={onClick} isRefreshing={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('disables itself and says it is updating while a refresh is in flight', () => {
    const onClick = vi.fn();
    render(<RefreshPricesButton onClick={onClick} isRefreshing />);
    const button = screen.getByRole('button', { name: 'Refresh' });
    expect(button).toBeDisabled();
    expect(screen.getByText('Updating...')).toBeInTheDocument();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows the age of the last refresh inline and in the tooltip', () => {
    usePreferencesStore.setState({ preferences: { language: 'en' } as any });
    render(
      <RefreshPricesButton
        onClick={vi.fn()}
        isRefreshing={false}
        lastPriceUpdate="2026-07-30T10:00:00.000Z"
      />,
    );
    const age = screen.getByText('(2 hours ago)');
    // On its own line under the label, the way Refresh Rates draws it.
    expect(age.parentElement).toBe(screen.getByText('Refresh').parentElement);
    expect(age.parentElement!.className).toContain('flex-col');
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute(
      'title',
      'Last updated: 2 hours ago',
    );
  });

  it('words the age in the reader language, not in English', () => {
    usePreferencesStore.setState({ preferences: { language: 'pl' } as any });
    render(
      <RefreshPricesButton
        onClick={vi.fn()}
        isRefreshing={false}
        lastPriceUpdate="2026-07-30T10:00:00.000Z"
      />,
    );
    expect(screen.getByText('(2 godziny temu)')).toBeInTheDocument();
    expect(screen.queryByText(/ago/)).not.toBeInTheDocument();
  });

  it('says so when the caller tracks the last refresh and there has been none', () => {
    render(
      <RefreshPricesButton
        onClick={vi.fn()}
        isRefreshing={false}
        lastPriceUpdate={null}
      />,
    );
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute(
      'title',
      'Never updated',
    );
  });

  it('falls back to the plain label when no last-refresh time is tracked', () => {
    render(<RefreshPricesButton onClick={vi.fn()} isRefreshing={false} />);
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute(
      'title',
      'Refresh',
    );
  });
});
