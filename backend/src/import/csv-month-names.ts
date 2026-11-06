/**
 * Month names for the CSV importer's month-name date tokens (MMM).
 *
 * A bank that writes "15-Jan-2026", "15 janv. 2026" or "15.Mär.2026" names the
 * month in its own language, so the table holds every app locale's month
 * names, long and short, in both the standalone and the in-a-date form (Polish
 * and Russian decline the month inside a date). Each name is also accepted by
 * any prefix of three letters or more ("Sept", "Mär", "juil"), and Latin
 * diacritics are folded on both sides ("aout", "Marz").
 *
 * A key that names two different months in any two languages, or two months
 * in one (French "jui" for juin and juillet), is left out: an ambiguous month
 * is an unreadable date the import reports, never a guess.
 */

import { SUPPORTED_LOCALE_CODES } from "../i18n/config";

/** The shortest prefix of a month name that is read as that month. */
const MIN_PREFIX_LENGTH = 3;

/**
 * Lower-case a month token, fold Latin diacritics (U+0300-U+036F only, so a
 * Devanagari vowel sign survives) and the Turkish dotless i (an upper-case
 * "KASIM" lower-cases to a dotted "kasim", never to "kasım"), and drop a
 * trailing abbreviation mark.
 */
function foldMonthToken(token: string): string {
  return token
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\u0131/g, "i")
    .replace(/[.\u0970]+$/, "")
    .normalize("NFC");
}

/** Every spelling Intl gives for one month in one locale. */
function monthSpellings(locale: string, monthIndex: number): string[] {
  const date = new Date(Date.UTC(2026, monthIndex, 15));
  return (["long", "short"] as const).flatMap((month) => {
    const standalone = new Intl.DateTimeFormat(locale, {
      month,
      timeZone: "UTC",
    }).format(date);
    const inDate = new Intl.DateTimeFormat(locale, {
      month,
      day: "numeric",
      timeZone: "UTC",
    })
      .formatToParts(date)
      .find((part) => part.type === "month")?.value;
    return inDate ? [standalone, inDate] : [standalone];
  });
}

function buildMonthLookup(): ReadonlyMap<string, number> {
  const candidates = new Map<string, Set<number>>();
  const add = (key: string, month: number) => {
    const months = candidates.get(key) ?? new Set<number>();
    months.add(month);
    candidates.set(key, months);
  };

  // The pseudo-locale has no month names of its own.
  const locales = SUPPORTED_LOCALE_CODES.filter((code) => code !== "xx");
  for (const locale of locales) {
    for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
      for (const spelling of monthSpellings(locale, monthIndex)) {
        const name = foldMonthToken(spelling);
        // "1月" or "thg 1" carries the month as a number: MM reads it.
        if (!name || /[\d\s]/.test(name)) continue;
        add(name, monthIndex + 1);
        for (let length = MIN_PREFIX_LENGTH; length < name.length; length++) {
          add(name.slice(0, length), monthIndex + 1);
        }
      }
    }
  }

  const lookup = new Map<string, number>();
  for (const [key, months] of candidates) {
    if (months.size === 1) lookup.set(key, [...months][0]);
  }
  return lookup;
}

let monthLookup: ReadonlyMap<string, number> | null = null;

/**
 * The month (1-12) a month name or abbreviation names, or null when it names
 * none or more than one.
 */
export function monthFromName(token: string): number | null {
  monthLookup ??= buildMonthLookup();
  // Most tokens are plain ASCII ("Jan", "OCT", "KASIM"), whose fold is a
  // lower-casing.
  const plain = token.toLowerCase().replace(/[.\u0970]+$/, "");
  return (
    monthLookup.get(plain) ?? monthLookup.get(foldMonthToken(token)) ?? null
  );
}
