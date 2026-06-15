import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  SUPPORTED_LOCALE_CODES,
  detectBrowserLocale,
  getLocaleDir,
  getLocaleLabel,
  isSupportedLocale,
  localeBase,
  matchAcceptLanguage,
  resolveLocale,
} from './config';

describe('i18n config', () => {
  describe('SUPPORTED_LOCALES', () => {
    it('includes the default locale', () => {
      expect(SUPPORTED_LOCALE_CODES).toContain(DEFAULT_LOCALE);
    });

    it('exposes a label and direction for each locale', () => {
      for (const locale of SUPPORTED_LOCALES) {
        expect(locale.label.length).toBeGreaterThan(0);
        expect(['ltr', 'rtl']).toContain(locale.dir);
      }
    });
  });

  describe('isSupportedLocale', () => {
    it('returns true for supported codes', () => {
      expect(isSupportedLocale('en')).toBe(true);
    });

    it('returns false for unknown codes and falsy input', () => {
      expect(isSupportedLocale('zz')).toBe(false);
      expect(isSupportedLocale('')).toBe(false);
      expect(isSupportedLocale(null)).toBe(false);
      expect(isSupportedLocale(undefined)).toBe(false);
    });
  });

  describe('resolveLocale', () => {
    it('returns the candidate when supported', () => {
      expect(resolveLocale('en')).toBe('en');
    });

    it('falls back to the default when unsupported', () => {
      expect(resolveLocale('zz')).toBe(DEFAULT_LOCALE);
      expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
    });
  });

  describe('getLocaleDir', () => {
    it('returns ltr for English', () => {
      expect(getLocaleDir('en')).toBe('ltr');
    });

    it('returns ltr for unknown codes', () => {
      expect(getLocaleDir('zz')).toBe('ltr');
    });
  });

  describe('matchAcceptLanguage', () => {
    it('returns the default for an empty header', () => {
      expect(matchAcceptLanguage(null)).toBe(DEFAULT_LOCALE);
      expect(matchAcceptLanguage('')).toBe(DEFAULT_LOCALE);
    });

    it('matches a supported tag verbatim', () => {
      expect(matchAcceptLanguage('en')).toBe('en');
    });

    it('prefers a supported region tag over the primary subtag', () => {
      expect(matchAcceptLanguage('en-US,en;q=0.9')).toBe('en-US');
    });

    it('strips an unsupported region tag to the primary subtag', () => {
      expect(matchAcceptLanguage('en-AU,en;q=0.9')).toBe('en');
    });

    it('falls back when no supported tag is present', () => {
      expect(matchAcceptLanguage('zz-ZZ,qq;q=0.5')).toBe(DEFAULT_LOCALE);
    });
  });

  describe('localeBase', () => {
    it('maps regional English variants to en', () => {
      expect(localeBase('en-US')).toBe('en');
      expect(localeBase('en-CA')).toBe('en');
      expect(localeBase('en-GB')).toBe('en');
    });

    it('returns undefined for full locales and nullish input', () => {
      expect(localeBase('en')).toBeUndefined();
      expect(localeBase('pt-BR')).toBeUndefined();
      expect(localeBase(undefined)).toBeUndefined();
      expect(localeBase(null)).toBeUndefined();
    });
  });

  describe('getLocaleLabel', () => {
    it('returns the native label for a known locale', () => {
      expect(getLocaleLabel('de')).toBe('Deutsch');
      expect(getLocaleLabel('en-GB')).toBe('English (UK)');
    });

    it('falls back to the code for an unknown locale', () => {
      expect(getLocaleLabel('zz')).toBe('zz');
    });
  });

  describe('detectBrowserLocale', () => {
    const setLanguages = (languages: string[]) =>
      Object.defineProperty(navigator, 'languages', {
        configurable: true,
        get: () => languages,
      });

    afterEach(() => {
      // Drop the per-test own property so the jsdom prototype getter returns.
      delete (navigator as { languages?: readonly string[] }).languages;
    });

    it('matches the browser languages against supported locales', () => {
      setLanguages(['fr-FR', 'fr']);
      expect(detectBrowserLocale()).toBe('fr');
    });

    it('prefers an exact supported regional match', () => {
      setLanguages(['en-GB', 'en']);
      expect(detectBrowserLocale()).toBe('en-GB');
    });

    it('always resolves to a supported locale', () => {
      setLanguages(['zz-ZZ']);
      expect(isSupportedLocale(detectBrowserLocale())).toBe(true);
    });
  });
});
