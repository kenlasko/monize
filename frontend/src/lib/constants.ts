import { formatDate } from './utils';

export const PAGE_SIZE = 50;

type DateFormatOption = { value: string; label: string };

/**
 * Date-format picker options. The pattern labels (YYYY-MM-DD, etc.) are format
 * codes shown verbatim; only the descriptive "browser" entry is translated.
 * `t` is the `common` namespace translator.
 */
export function getDateFormatOptions(
  t: (key: string, values?: Record<string, string | number>) => string,
  browserLocale?: string,
): DateFormatOption[] {
  // Preview the format 'browser' mode actually produces, using the same date
  // the pattern options show (2024-12-31) formatted with the effective locale
  // (e.g. "12/31/2024"). Mirrors formatDate's 'browser' branch.
  const sample = formatDate('2024-12-31', 'browser', browserLocale);
  return [
    { value: 'browser', label: t('dateFormat.browserAuto', { sample }) },
    { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD (2024-12-31)' },
    { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY (12/31/2024)' },
    { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY (31/12/2024)' },
    { value: 'DD-MMM-YYYY', label: 'DD-MMM-YYYY (31-Dec-2024)' },
  ];
}

/** Export picker options: the date formats plus a "Custom..." entry. */
export function getExportDateFormatOptions(
  t: (key: string, values?: Record<string, string | number>) => string,
  browserLocale?: string,
): DateFormatOption[] {
  return [
    ...getDateFormatOptions(t, browserLocale),
    { value: 'custom', label: t('dateFormat.custom') },
  ];
}

export const EXCHANGE_OPTIONS = [
  // North America
  { value: 'NYSE', label: 'NYSE', subtitle: 'New York Stock Exchange (US)' },
  { value: 'NASDAQ', label: 'NASDAQ', subtitle: 'NASDAQ (US)' },
  { value: 'AMEX', label: 'AMEX', subtitle: 'American Stock Exchange (US)' },
  { value: 'ARCA', label: 'ARCA', subtitle: 'NYSE Arca (US)' },
  { value: 'BATS', label: 'BATS', subtitle: 'BATS Global Markets (US)' },
  { value: 'TSX', label: 'TSX', subtitle: 'Toronto Stock Exchange (Canada)' },
  { value: 'TSX-V', label: 'TSX-V', subtitle: 'TSX Venture Exchange (Canada)' },
  { value: 'CSE', label: 'CSE', subtitle: 'Canadian Securities Exchange (Canada)' },
  { value: 'NEO', label: 'NEO', subtitle: 'NEO Exchange (Canada)' },
  // Europe
  { value: 'LSE', label: 'LSE', subtitle: 'London Stock Exchange (UK)' },
  { value: 'XETRA', label: 'XETRA', subtitle: 'XETRA (Germany)' },
  { value: 'Frankfurt', label: 'Frankfurt', subtitle: 'Frankfurt Stock Exchange (Germany)' },
  { value: 'Paris', label: 'Paris', subtitle: 'Euronext Paris (France)' },
  { value: 'AMS', label: 'AMS', subtitle: 'Euronext Amsterdam (Netherlands)' },
  { value: 'MIL', label: 'MIL', subtitle: 'Borsa Italiana (Italy)' },
  { value: 'STO', label: 'STO', subtitle: 'Stockholm Stock Exchange (Sweden)' },
  // Asia-Pacific
  { value: 'Tokyo', label: 'Tokyo', subtitle: 'Tokyo Stock Exchange (Japan)' },
  { value: 'HKEX', label: 'HKEX', subtitle: 'Hong Kong Stock Exchange (Hong Kong)' },
  { value: 'SHA', label: 'SHA', subtitle: 'Shanghai Stock Exchange (China)' },
  { value: 'SHE', label: 'SHE', subtitle: 'Shenzhen Stock Exchange (China)' },
  { value: 'ASX', label: 'ASX', subtitle: 'Australian Securities Exchange (Australia)' },
  { value: 'KRX', label: 'KRX', subtitle: 'Korea Exchange (South Korea)' },
  { value: 'TAI', label: 'TAI', subtitle: 'Taiwan Stock Exchange (Taiwan)' },
  { value: 'SGX', label: 'SGX', subtitle: 'Singapore Exchange (Singapore)' },
  { value: 'BSE', label: 'BSE', subtitle: 'Bombay Stock Exchange (India)' },
  { value: 'NSE', label: 'NSE', subtitle: 'National Stock Exchange (India)' },
];
