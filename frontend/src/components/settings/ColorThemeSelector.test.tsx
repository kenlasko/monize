import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, screen, waitFor, render } from '@/test/render';
import { ColorThemeSelector } from './ColorThemeSelector';
import { COLOR_THEMES } from '@/lib/color-themes';

const { mockSetAppColorTheme } = vi.hoisted(() => ({ mockSetAppColorTheme: vi.fn() }));

// Mock the theme context so we can assert the live colour theme is updated.
// A pass-through ThemeProvider keeps the custom test render wrapper working.
vi.mock('@/contexts/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
  useTheme: () => ({
    theme: 'system',
    resolvedTheme: 'light',
    setTheme: vi.fn(),
    colorTheme: 'default',
    setColorTheme: mockSetAppColorTheme,
  }),
}));

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    updatePreferences: vi.fn().mockResolvedValue({ colorTheme: 'latte', defaultCurrency: 'USD' }),
  },
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

import toast from 'react-hot-toast';
import { userSettingsApi } from '@/lib/user-settings';

describe('ColorThemeSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders every colour theme option', () => {
    render(<ColorThemeSelector value="default" onChange={() => {}} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toEqual([...COLOR_THEMES]);
  });

  it('applies and persists the colour theme immediately on change', async () => {
    const onChange = vi.fn();
    render(<ColorThemeSelector value="default" onChange={onChange} />);

    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'latte' } });
    });

    // Parent state and the live colour theme update right away, no save step.
    expect(onChange).toHaveBeenCalledWith('latte');
    expect(mockSetAppColorTheme).toHaveBeenCalledWith('latte');

    await waitFor(() =>
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({ colorTheme: 'latte' }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('still applies the colour theme locally and surfaces an error when saving fails', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('network'),
    );
    render(<ColorThemeSelector value="default" onChange={() => {}} />);

    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'nord' } });
    });

    expect(mockSetAppColorTheme).toHaveBeenCalledWith('nord');
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to save colour theme'),
    );
  });
});
