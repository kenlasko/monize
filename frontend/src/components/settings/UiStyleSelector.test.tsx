import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, screen, waitFor, render } from '@/test/render';
import { UiStyleSelector } from './UiStyleSelector';
import { UI_STYLES } from '@/lib/ui-styles';

const { mockSetAppUiStyle, mockSetAppColorTheme } = vi.hoisted(() => ({
  mockSetAppUiStyle: vi.fn(),
  mockSetAppColorTheme: vi.fn(),
}));

// Pass-through ThemeProvider keeps the custom test render wrapper working.
vi.mock('@/contexts/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
  useTheme: () => ({
    theme: 'system',
    resolvedTheme: 'light',
    setTheme: vi.fn(),
    colorTheme: 'default',
    setColorTheme: mockSetAppColorTheme,
    uiStyle: 'standard',
    setUiStyle: mockSetAppUiStyle,
  }),
}));

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    updatePreferences: vi.fn().mockResolvedValue({ uiStyle: 'pebble', defaultCurrency: 'USD' }),
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
import { usePreferencesStore } from '@/store/preferencesStore';

describe('UiStyleSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders every UI style as a radio option with a description', () => {
    render(<UiStyleSelector value="standard" onChange={() => {}} colorTheme="default" onColorThemeChange={() => {}} />);
    expect(screen.getAllByRole('radio')).toHaveLength(UI_STYLES.length);
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    expect(screen.getByText('The familiar Monize look.')).toBeInTheDocument();
    expect(screen.getByText(/Ledger-inspired/)).toBeInTheDocument();
    expect(screen.getByText(/Bold type, rounded colour blocks/)).toBeInTheDocument();
  });

  it('shows the helper line', () => {
    render(<UiStyleSelector value="standard" onChange={() => {}} colorTheme="default" onColorThemeChange={() => {}} />);
    expect(
      screen.getByText('Changes typography, shapes and table styling. Works with any colour theme.'),
    ).toBeInTheDocument();
  });

  it('marks only the selected style as checked, and gives it the one tab stop', () => {
    render(<UiStyleSelector value="folio" onChange={() => {}} colorTheme="default" onColorThemeChange={() => {}} />);
    const radios = screen.getAllByRole('radio');
    const checked = radios.filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveAttribute('tabindex', '0');
    expect(radios.filter((r) => r !== checked[0]).every((r) => r.getAttribute('tabindex') === '-1')).toBe(true);
  });

  it('applies and persists the style immediately on click', async () => {
    const onChange = vi.fn();
    render(<UiStyleSelector value="standard" onChange={onChange} colorTheme="default" onColorThemeChange={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /pebble/i }));
    });

    expect(onChange).toHaveBeenCalledWith('pebble');
    expect(mockSetAppUiStyle).toHaveBeenCalledWith('pebble');
    await waitFor(() =>
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({ uiStyle: 'pebble' }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('moves the selection with the arrow keys and wraps', async () => {
    const onChange = vi.fn();
    render(<UiStyleSelector value="standard" onChange={onChange} colorTheme="default" onColorThemeChange={() => {}} />);

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
    render(<UiStyleSelector value="standard" onChange={() => {}} colorTheme="default" onColorThemeChange={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /folio/i }));
    });

    expect(mockSetAppUiStyle).toHaveBeenCalledWith('folio');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to save UI style'));
  });

  it('adopts only the latest save when an earlier reply lands after it', async () => {
    const replies: Array<(value: unknown) => void> = [];
    const pending = () => new Promise((resolve) => replies.push(resolve));
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(pending)
      .mockImplementationOnce(pending);
    const updateSpy = vi.spyOn(usePreferencesStore.getState(), 'updatePreferences');
    render(<UiStyleSelector value="standard" onChange={() => {}} colorTheme="default" onColorThemeChange={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /folio/i }));
      fireEvent.click(screen.getByRole('radio', { name: /pebble/i }));
    });
    expect(replies).toHaveLength(2);
    await act(async () => {
      replies[1]({ uiStyle: 'pebble' });
      replies[0]({ uiStyle: 'folio' });
    });

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith({ uiStyle: 'pebble' });
    updateSpy.mockRestore();
  });

  describe('palettes follow the style', () => {
    it('switches to the companion when the palette in use is not one the style offers', async () => {
      const onColorThemeChange = vi.fn();
      render(
        <UiStyleSelector
          value="standard"
          onChange={() => {}}
          colorTheme="nord"
          onColorThemeChange={onColorThemeChange}
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('radio', { name: /folio/i }));
      });

      expect(onColorThemeChange).toHaveBeenCalledWith('ledger');
      expect(mockSetAppColorTheme).toHaveBeenCalledWith('ledger');
      // One request, so the style and its palette never land half-applied.
      await waitFor(() =>
        expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({
          uiStyle: 'folio',
          colorTheme: 'ledger',
        }),
      );
    });

    it('keeps a palette the new style offers', async () => {
      const onColorThemeChange = vi.fn();
      render(
        <UiStyleSelector
          value="standard"
          onChange={() => {}}
          colorTheme="nord"
          onColorThemeChange={onColorThemeChange}
        />,
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('radio', { name: /pebble/i }));
      });

      expect(onColorThemeChange).not.toHaveBeenCalled();
      expect(mockSetAppColorTheme).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({ uiStyle: 'pebble' }),
      );
    });
  });
});
