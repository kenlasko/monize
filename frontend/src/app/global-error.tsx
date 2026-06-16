'use client';

import { useSyncExternalStore } from 'react';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  getLocaleDir,
  resolveLocale,
} from '@/i18n/config';
import deCommon from '@/i18n/messages/de/common.json';
import enCommon from '@/i18n/messages/en/common.json';
import esCommon from '@/i18n/messages/es/common.json';
import frCommon from '@/i18n/messages/fr/common.json';
import hiCommon from '@/i18n/messages/hi/common.json';
import idCommon from '@/i18n/messages/id/common.json';
import itCommon from '@/i18n/messages/it/common.json';
import jaCommon from '@/i18n/messages/ja/common.json';
import koCommon from '@/i18n/messages/ko/common.json';
import nlCommon from '@/i18n/messages/nl/common.json';
import plCommon from '@/i18n/messages/pl/common.json';
import ptCommon from '@/i18n/messages/pt/common.json';
import ptBrCommon from '@/i18n/messages/pt-BR/common.json';
import ruCommon from '@/i18n/messages/ru/common.json';
import trCommon from '@/i18n/messages/tr/common.json';
import ukCommon from '@/i18n/messages/uk/common.json';
import viCommon from '@/i18n/messages/vi/common.json';
import zhCnCommon from '@/i18n/messages/zh-CN/common.json';
import zhTwCommon from '@/i18n/messages/zh-TW/common.json';

// global-error replaces the root layout, so the NextIntlClientProvider that
// normally supplies translations is gone. We bundle the `common` catalogs
// statically and resolve the locale from the cookie ourselves.
const COMMON_MESSAGES: Record<string, typeof enCommon> = {
  de: deCommon,
  en: enCommon,
  es: esCommon,
  fr: frCommon,
  hi: hiCommon,
  id: idCommon,
  it: itCommon,
  ja: jaCommon,
  ko: koCommon,
  nl: nlCommon,
  pl: plCommon,
  pt: ptCommon,
  'pt-BR': ptBrCommon,
  ru: ruCommon,
  tr: trCommon,
  uk: ukCommon,
  vi: viCommon,
  'zh-CN': zhCnCommon,
  'zh-TW': zhTwCommon,
};

const subscribeNoop = () => () => {};

function getClientLocale(): string {
  const match = document.cookie
    .split('; ')
    .find((part) => part.startsWith(`${LOCALE_COOKIE}=`));
  const value = match
    ? decodeURIComponent(match.slice(LOCALE_COOKIE.length + 1))
    : '';
  return resolveLocale(value);
}

function getServerLocale(): string {
  return DEFAULT_LOCALE;
}

function GlobalErrorContent({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('common.errorPage');

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '1rem',
      backgroundColor: '#f9fafb',
    }}>
      <div style={{ maxWidth: '28rem', width: '100%', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', marginBottom: '1rem' }}>
          {t('title')}
        </h1>
        <p style={{ color: '#6b7280', marginBottom: '2rem' }}>
          {t('description')}
        </p>
        {error.digest && (
          <p style={{ fontSize: '0.875rem', color: '#9ca3af', marginBottom: '1rem' }}>
            {t('errorId', { digest: error.digest })}
          </p>
        )}
        <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
          <button
            onClick={reset}
            style={{
              padding: '0.75rem 1.5rem',
              border: 'none',
              borderRadius: '0.375rem',
              backgroundColor: '#2563eb',
              color: '#fff',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {t('tryAgain')}
          </button>
          <a
            href="/dashboard"
            style={{
              padding: '0.75rem 1.5rem',
              border: '1px solid #d1d5db',
              borderRadius: '0.375rem',
              backgroundColor: '#fff',
              color: '#374151',
              fontWeight: 500,
              textDecoration: 'none',
            }}
          >
            {t('goToDashboard')}
          </a>
        </div>
      </div>
    </div>
  );
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const locale = useSyncExternalStore(subscribeNoop, getClientLocale, getServerLocale);
  const messages = COMMON_MESSAGES[locale] ?? COMMON_MESSAGES[DEFAULT_LOCALE];

  return (
    <html lang={locale} dir={getLocaleDir(locale)}>
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        <NextIntlClientProvider locale={locale} messages={{ common: messages }}>
          <GlobalErrorContent error={error} reset={reset} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
