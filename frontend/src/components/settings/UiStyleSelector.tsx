'use client';

import { useRef, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { userSettingsApi } from '@/lib/user-settings';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useTheme } from '@/contexts/ThemeContext';
import { getErrorMessage } from '@/lib/errors';
import { paletteAfterStyleChange, UI_STYLES, UiStyle } from '@/lib/ui-styles';
import type { ColorTheme } from '@/lib/color-themes';

interface UiStyleSelectorProps {
  value: UiStyle;
  onChange: (uiStyle: UiStyle) => void;
  /** The palette in use: a style that does not offer it switches to its companion. */
  colorTheme: ColorTheme;
  onColorThemeChange: (colorTheme: ColorTheme) => void;
}

/**
 * UI style picker (standard / classic / modern) that applies and persists the
 * choice immediately, the way `ColorThemeSelector` does: the live style is set
 * through the theme context and saved to the server by this component, so
 * `PreferencesSection` holds display state only.
 *
 * Each option carries a tiny static preview that hints at the style's shapes
 * and typography. The previews use only the gray/blue ramp so they follow the
 * active palette and light/dark mode.
 *
 * A radiogroup with roving tabindex, like `ColorThemeSelector`.
 */
export function UiStyleSelector({
  value,
  onChange,
  colorTheme,
  onColorThemeChange,
}: UiStyleSelectorProps) {
  const t = useTranslations('settings.preferences');
  const [isSaving, startTransition] = useTransition();
  const updatePreferencesStore = usePreferencesStore((state) => state.updatePreferences);
  const { setUiStyle: setAppUiStyle, setColorTheme: setAppColorTheme } = useTheme();
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleChange = (next: UiStyle) => {
    // A style offers only its own palettes (`UI_STYLE_PALETTES`); one the new
    // style does not offer gives way to its companion, saved in the same
    // request so the two never land half-applied.
    const palette = paletteAfterStyleChange(next, colorTheme);
    const paletteChanged = palette !== colorTheme;
    onChange(next);
    setAppUiStyle(next);
    if (paletteChanged) {
      onColorThemeChange(palette);
      setAppColorTheme(palette);
    }

    startTransition(async () => {
      try {
        const updated = await userSettingsApi.updatePreferences(
          paletteChanged ? { uiStyle: next, colorTheme: palette } : { uiStyle: next },
        );
        updatePreferencesStore(updated);
        toast.success(t('toasts.saved'));
      } catch (error) {
        toast.error(getErrorMessage(error, t('toasts.uiStyleSaveFailed')));
      }
    });
  };

  /** Move selection and focus together, so the arrow keys read as one control. */
  const selectAt = (index: number) => {
    const wrapped = (index + UI_STYLES.length) % UI_STYLES.length;
    optionRefs.current[wrapped]?.focus();
    handleChange(UI_STYLES[wrapped]);
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
        selectAt(UI_STYLES.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div>
      <span id="ui-style-label" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        {t('uiStyleLabel')}
      </span>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('uiStyleHint')}</p>
      <div
        role="radiogroup"
        aria-labelledby="ui-style-label"
        className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3"
      >
        {UI_STYLES.map((name, index) => {
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
              <UiStylePreview name={name} />
              <span className="mt-2 block text-xs font-medium text-gray-700 dark:text-gray-300">
                {t(`uiStyleOptions.${name}.name`)}
              </span>
              <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                {t(`uiStyleOptions.${name}.description`)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A few divs that hint at a style's shapes and type. Decorative.
 *
 * Every radius and typeface here is a literal, never `rounded-lg` or
 * `font-sans`: those are the very tokens a UI style redefines, so under
 * Classic a token-based Modern preview would render square and lie about
 * what picking it does. The specimen is "Aa" because the swapped faces are
 * Latin-script display faces, whatever the interface language.
 */
function UiStylePreview({ name }: { name: UiStyle }) {
  if (name === 'classic') {
    return (
      <span
        aria-hidden="true"
        className="flex h-16 w-full items-center rounded-[0.375rem] bg-gray-100 p-2 dark:bg-gray-900"
      >
        <span className="block w-full border border-gray-400 bg-white p-2 dark:border-gray-500 dark:bg-gray-800">
          <span
            className="block text-xs font-bold text-gray-900 dark:text-gray-100"
            style={{ fontFamily: 'var(--font-ui-classic-display, Georgia, serif)' }}
          >
            Aa
          </span>
          <span className="mt-1 block h-1 border-y border-gray-500 dark:border-gray-400" />
          <span className="mt-1.5 block h-1 w-2/3 bg-gray-300 dark:bg-gray-600" />
        </span>
      </span>
    );
  }
  if (name === 'modern') {
    return (
      <span
        aria-hidden="true"
        className="flex h-16 w-full items-center rounded-[0.375rem] bg-gray-100 p-2 dark:bg-gray-900"
      >
        <span className="block w-full rounded-[1rem] bg-blue-100 p-2 dark:bg-blue-900/60">
          <span
            className="block text-xs font-extrabold text-gray-900 dark:text-gray-100"
            style={{ fontFamily: 'var(--font-ui-modern-display, system-ui)' }}
          >
            Aa
          </span>
          <span className="mt-1.5 block h-2 w-10 rounded-[9999px] bg-blue-600 dark:bg-blue-400" />
        </span>
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-16 w-full items-center rounded-[0.375rem] bg-gray-100 p-2 dark:bg-gray-900"
    >
      <span className="block w-full rounded-[0.5rem] border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-800">
        <span
          className="block text-xs font-semibold text-gray-900 dark:text-gray-100"
          style={{ fontFamily: 'var(--font-inter, system-ui)' }}
        >
          Aa
        </span>
        <span className="mt-1.5 block h-1.5 w-2/3 rounded-[0.25rem] bg-gray-300 dark:bg-gray-600" />
      </span>
    </span>
  );
}
