import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, screen, waitFor, render } from '@/test/render';
import { ColorThemeSelector } from './ColorThemeSelector';
import { COLOR_THEMES } from '@/lib/color-themes';
import { THEME_SWATCHES } from '@/lib/theme-swatches';

const { mockSetAppColorTheme, mockResolvedTheme } = vi.hoisted(() => ({
  mockSetAppColorTheme: vi.fn(),
  mockResolvedTheme: { current: 'light' as 'light' | 'dark' },
}));

// Mock the theme context so we can assert the live colour theme is updated,
// and drive `resolvedTheme` so the mode-following previews can be tested.
// A pass-through ThemeProvider keeps the custom test render wrapper working.
vi.mock('@/contexts/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
  useTheme: () => ({
    theme: 'system',
    resolvedTheme: mockResolvedTheme.current,
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

/** rgb() as the DOM reports an inline hex background. */
function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

describe('ColorThemeSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvedTheme.current = 'light';
  });

  it('renders every colour theme as a radio option', () => {
    render(<ColorThemeSelector value="default" onChange={() => {}} />);
    expect(screen.getAllByRole('radio')).toHaveLength(COLOR_THEMES.length);
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
  });

  it('marks only the selected theme as checked, and gives it the one tab stop', () => {
    render(<ColorThemeSelector value="nord" onChange={() => {}} />);
    const checked = screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveAttribute('tabindex', '0');
    // Every other option is skipped by Tab and reached with the arrows.
    const others = screen.getAllByRole('radio').filter((r) => r !== checked[0]);
    expect(others.every((r) => r.getAttribute('tabindex') === '-1')).toBe(true);
  });

  it('applies and persists the colour theme immediately on click', async () => {
    const onChange = vi.fn();
    render(<ColorThemeSelector value="default" onChange={onChange} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /latte/i }));
    });

    // Parent state and the live colour theme update right away, no save step.
    expect(onChange).toHaveBeenCalledWith('latte');
    expect(mockSetAppColorTheme).toHaveBeenCalledWith('latte');

    await waitFor(() =>
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({ colorTheme: 'latte' }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('moves the selection with the arrow keys', async () => {
    const onChange = vi.fn();
    render(<ColorThemeSelector value="default" onChange={onChange} />);

    await act(async () => {
      fireEvent.keyDown(screen.getAllByRole('radio')[0], { key: 'ArrowRight' });
    });

    expect(onChange).toHaveBeenCalledWith(COLOR_THEMES[1]);
  });

  it('wraps from the first option back to the last', async () => {
    const onChange = vi.fn();
    render(<ColorThemeSelector value="default" onChange={onChange} />);

    await act(async () => {
      fireEvent.keyDown(screen.getAllByRole('radio')[0], { key: 'ArrowLeft' });
    });

    expect(onChange).toHaveBeenCalledWith(COLOR_THEMES[COLOR_THEMES.length - 1]);
  });

  it('previews the palette for the mode the user is actually in', () => {
    // The same palette is a cream page in light mode and a taupe one in dark,
    // so a preview locked to one mode would describe a screen the user is not
    // looking at.
    const { unmount } = render(<ColorThemeSelector value="default" onChange={() => {}} />);
    const lightOption = screen.getByRole('radio', { name: /latte/i });
    expect(lightOption.innerHTML).toContain(rgb(THEME_SWATCHES.latte.light.page));
    unmount();

    mockResolvedTheme.current = 'dark';
    render(<ColorThemeSelector value="default" onChange={() => {}} />);
    const darkOption = screen.getByRole('radio', { name: /latte/i });
    expect(darkOption.innerHTML).toContain(rgb(THEME_SWATCHES.latte.dark.page));
  });

  it('still applies the colour theme locally and surfaces an error when saving fails', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('network'),
    );
    render(<ColorThemeSelector value="default" onChange={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /nord/i }));
    });

    expect(mockSetAppColorTheme).toHaveBeenCalledWith('nord');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to save colour theme'));
  });
});
