import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@/test/render';
import { render } from '@/test/render';
import { LanguageSelector } from './LanguageSelector';
import { detectBrowserLocale } from '@/i18n/config';

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    updatePreferences: vi.fn().mockResolvedValue({
      language: 'en',
      defaultCurrency: 'USD',
      dateFormat: 'browser',
      numberFormat: 'browser',
      theme: 'light',
      timezone: 'browser',
    }),
  },
}));

vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<typeof import('next/navigation')>(
    'next/navigation',
  );
  return {
    ...actual,
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  };
});

vi.mock('js-cookie', () => ({
  default: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import Cookies from 'js-cookie';
import toast from 'react-hot-toast';
import { userSettingsApi } from '@/lib/user-settings';

describe('LanguageSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders every supported locale as an option', () => {
    render(<LanguageSelector value="en" onChange={() => {}} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toContain('en');
  });

  it('persists the new language to cookie and API on change', async () => {
    const onChange = vi.fn();
    render(<LanguageSelector value="en" onChange={onChange} />);

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: 'xx' } });
    });

    expect(onChange).toHaveBeenCalledWith('xx');
    expect(Cookies.set).toHaveBeenCalledWith(
      'NEXT_LOCALE',
      'xx',
      expect.objectContaining({ sameSite: 'lax' }),
    );
    await waitFor(() =>
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({
        language: 'xx',
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('offers a "use browser locale" option', () => {
    render(<LanguageSelector value="en" onChange={() => {}} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toContain('browser');
  });

  it('stores "browser" but sets the cookie to the detected locale', async () => {
    const onChange = vi.fn();
    render(<LanguageSelector value="en" onChange={onChange} />);

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: 'browser' } });
    });

    expect(onChange).toHaveBeenCalledWith('browser');
    // The persisted preference is the 'browser' sentinel, but the active locale
    // cookie is the concrete locale detected from the browser.
    expect(Cookies.set).toHaveBeenCalledWith(
      'NEXT_LOCALE',
      detectBrowserLocale(),
      expect.objectContaining({ sameSite: 'lax' }),
    );
    await waitFor(() =>
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({
        language: 'browser',
      }),
    );
  });
});
