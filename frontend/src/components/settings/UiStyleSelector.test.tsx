import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, screen, waitFor, render } from '@/test/render';
import { UiStyleSelector } from './UiStyleSelector';
import { UI_STYLES } from '@/lib/ui-styles';

const { mockSetAppUiStyle } = vi.hoisted(() => ({
  mockSetAppUiStyle: vi.fn(),
}));

// Pass-through ThemeProvider keeps the custom test render wrapper working.
vi.mock('@/contexts/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
  useTheme: () => ({
    theme: 'system',
    resolvedTheme: 'light',
    setTheme: vi.fn(),
    colorTheme: 'default',
    setColorTheme: vi.fn(),
    uiStyle: 'standard',
    setUiStyle: mockSetAppUiStyle,
  }),
}));

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    updatePreferences: vi.fn().mockResolvedValue({ uiStyle: 'modern', defaultCurrency: 'USD' }),
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

describe('UiStyleSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders every UI style as a radio option with a description', () => {
    render(<UiStyleSelector value="standard" onChange={() => {}} />);
    expect(screen.getAllByRole('radio')).toHaveLength(UI_STYLES.length);
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    expect(screen.getByText('The familiar Monize look.')).toBeInTheDocument();
    expect(screen.getByText(/Ledger-inspired/)).toBeInTheDocument();
    expect(screen.getByText(/Bold type, rounded colour blocks/)).toBeInTheDocument();
  });

  it('shows the helper line', () => {
    render(<UiStyleSelector value="standard" onChange={() => {}} />);
    expect(
      screen.getByText('Changes typography, shapes and table styling. Works with any colour theme.'),
    ).toBeInTheDocument();
  });

  it('marks only the selected style as checked, and gives it the one tab stop', () => {
    render(<UiStyleSelector value="classic" onChange={() => {}} />);
    const radios = screen.getAllByRole('radio');
    const checked = radios.filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveAttribute('tabindex', '0');
    expect(radios.filter((r) => r !== checked[0]).every((r) => r.getAttribute('tabindex') === '-1')).toBe(true);
  });

  it('applies and persists the style immediately on click', async () => {
    const onChange = vi.fn();
    render(<UiStyleSelector value="standard" onChange={onChange} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /modern/i }));
    });

    expect(onChange).toHaveBeenCalledWith('modern');
    expect(mockSetAppUiStyle).toHaveBeenCalledWith('modern');
    await waitFor(() =>
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({ uiStyle: 'modern' }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('moves the selection with the arrow keys and wraps', async () => {
    const onChange = vi.fn();
    render(<UiStyleSelector value="standard" onChange={onChange} />);

    await act(async () => {
      fireEvent.keyDown(screen.getAllByRole('radio')[0], { key: 'ArrowRight' });
    });
    expect(onChange).toHaveBeenLastCalledWith(UI_STYLES[1]);

    await act(async () => {
      fireEvent.keyDown(screen.getAllByRole('radio')[0], { key: 'ArrowLeft' });
    });
    expect(onChange).toHaveBeenLastCalledWith(UI_STYLES[UI_STYLES.length - 1]);
  });

  it('still applies the style locally and surfaces an error when saving fails', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('network'),
    );
    render(<UiStyleSelector value="standard" onChange={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /classic/i }));
    });

    expect(mockSetAppUiStyle).toHaveBeenCalledWith('classic');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to save UI style'));
  });
});
