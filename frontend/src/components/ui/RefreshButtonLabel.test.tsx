import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@/test/render';
import { cleanup, screen } from '@testing-library/react';
import { usePreferencesStore } from '@/store/preferencesStore';
import { RefreshButtonLabel } from './RefreshButtonLabel';

describe('RefreshButtonLabel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00.000Z'));
    usePreferencesStore.setState({ preferences: { language: 'en' } as any });
  });

  afterEach(() => {
    cleanup();
    usePreferencesStore.setState({ preferences: null });
    vi.useRealTimers();
  });

  it('puts the age on its own line under the label', () => {
    render(<RefreshButtonLabel label="Refresh Rates" updatedAt="2026-07-29T09:00:00.000Z" />);
    const label = screen.getByText('Refresh Rates');
    const age = screen.getByText('(yesterday)');
    // Siblings in a column, not one run of inline text that widens the button.
    expect(label.parentElement).toBe(age.parentElement);
    expect(label.parentElement!.className).toContain('flex-col');
  });

  it('draws only the label when there is no age', () => {
    render(<RefreshButtonLabel label="Refresh" updatedAt={null} />);
    expect(screen.getByText('Refresh').parentElement!.textContent).toBe('Refresh');
  });

  it('lets the caller collapse it below a breakpoint', () => {
    render(<RefreshButtonLabel label="Refresh" className="hidden sm:flex" />);
    const wrapper = screen.getByText('Refresh').parentElement!;
    expect(wrapper.className).toContain('hidden');
    expect(wrapper.className).toContain('sm:flex');
    expect(wrapper.className).not.toMatch(/(^| )flex( |$)/);
  });
});
