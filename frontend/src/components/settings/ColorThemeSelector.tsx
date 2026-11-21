'use client';

import { useRef, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { userSettingsApi } from '@/lib/user-settings';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useTheme } from '@/contexts/ThemeContext';
import { getErrorMessage } from '@/lib/errors';
import { ColorTheme } from '@/lib/color-themes';
import { UI_STYLE_PALETTES, type UiStyle } from '@/lib/ui-styles';
import { THEME_SWATCHES } from '@/lib/theme-swatches';

interface ColorThemeSelectorProps {
  value: ColorTheme;
  onChange: (colorTheme: ColorTheme) => void;
  /** Offer only this UI style's palettes (`UI_STYLE_PALETTES`). */
  uiStyle?: UiStyle;
}

/**
 * Colour theme (palette) picker that applies and persists the choice
 * immediately, mirroring the ThemeSelector. The change is reflected in the
 * app right away (via the theme context) and saved to the server by this
 * component itself, which is why `PreferencesSection` leaves this field out of
 * its own save-on-change plumbing rather than saving it twice.
 *
 * Each option draws its own palette rather than naming it, because the names
 * do not say what the themes look like and a list of fifteen of them asks the
 * user to pick blind. The preview follows the current light/dark mode: the
 * same palette is a cream page in one and a taupe one in the other, so
 * previewing the mode the user is not in would be a preview of the wrong
 * thing. Values come from `THEME_SWATCHES`, which a guard test holds against
 * `themes.css`.
 *
 * A radiogroup with roving tabindex, the way `Tabs` moves between tabs: one
 * tab stop for the set, arrows to move within it.
 *
 * Only the palettes the UI style offers are listed, companion first. A
 * stored palette the style does not offer (one dropped from its list since)
 * stays listed while it is in use, so the picker never shows nothing chosen.
 */
export function ColorThemeSelector({ value, onChange, uiStyle = 'standard' }: ColorThemeSelectorProps) {
  const t = useTranslations('settings.preferences');
  const [isSaving, startTransition] = useTransition();
  const updatePreferencesStore = usePreferencesStore((state) => state.updatePreferences);
  const { setColorTheme: setAppColorTheme, resolvedTheme } = useTheme();
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const offered = UI_STYLE_PALETTES[uiStyle];
  const palettes = offered.includes(value) ? offered : [value, ...offered];

  const handleChange = (next: ColorTheme) => {
    onChange(next);
    setAppColorTheme(next);

    startTransition(async () => {
      try {
        const updated = await userSettingsApi.updatePreferences({ colorTheme: next });
        updatePreferencesStore(updated);
        toast.success(t('toasts.saved'));
      } catch (error) {
        toast.error(getErrorMessage(error, t('toasts.colorThemeSaveFailed')));
      }
    });
  };

  /** Move selection and focus together, so the arrow keys read as one control. */
  const selectAt = (index: number) => {
    const wrapped = (index + palettes.length) % palettes.length;
    optionRefs.current[wrapped]?.focus();
    handleChange(palettes[wrapped]);
  };

  const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        selectAt(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        selectAt(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        selectAt(0);
        break;
      case 'End':
        event.preventDefault();
        selectAt(palettes.length - 1);
        break;
      default:
        break;
    }
  };

  const mode = resolvedTheme === 'dark' ? 'dark' : 'light';

  return (
    <div>
      <span id="color-theme-label" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        {t('colorThemeLabel')}
      </span>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('colorThemeHint')}</p>
      {uiStyle !== 'standard' && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('colorThemeStyleHint', { style: t(`uiStyleOptions.${uiStyle}.name`) })}
        </p>
      )}
      <div
        role="radiogroup"
        aria-labelledby="color-theme-label"
        className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
      >
        {palettes.map((name, index) => {
          const swatch = THEME_SWATCHES[name][mode];
          const isSelected = name === value;
          return (
            <button
              key={name}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              role="radio"
              aria-checked={isSelected}
              tabIndex={isSelected ? 0 : -1}
              disabled={isSaving}
              onClick={() => handleChange(name)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={`rounded-lg border p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50 dark:focus-visible:ring-offset-gray-900 ${
                isSelected
                  ? 'border-blue-600 ring-2 ring-blue-600 dark:border-blue-400 dark:ring-blue-400'
                  : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
              }`}
            >
              {/* A miniature of the app: page, a card on it, the accent bar and
                  two chart series. Decorative -- the name below is the label. */}
              <span
                aria-hidden="true"
                className="flex h-12 w-full items-end gap-1 rounded-md p-1.5"
                style={{ backgroundColor: swatch.page }}
              >
                <span
                  className="flex h-full flex-1 flex-col justify-end gap-1 rounded-sm p-1"
                  style={{ backgroundColor: swatch.card }}
                >
                  <span
                    className="block h-1.5 w-full rounded-full"
                    style={{ backgroundColor: swatch.accent }}
                  />
                  <span className="flex gap-1">
                    <span
                      className="block h-1.5 flex-1 rounded-full"
                      style={{ backgroundColor: swatch.chart2 }}
                    />
                    <span
                      className="block h-1.5 flex-1 rounded-full"
                      style={{ backgroundColor: swatch.chart4 }}
                    />
                  </span>
                </span>
              </span>
              <span className="mt-2 block truncate text-xs font-medium text-gray-700 dark:text-gray-300">
                {t(`colorThemeOptions.${name}`)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
