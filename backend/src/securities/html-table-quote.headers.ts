/**
 * The header row of a price table: which column is the date, the close, the
 * open, the high, the low and the volume, and which decimal separator the
 * header language implies. Split from `html-table-quote.parser.ts`, which
 * reads the rows once these are known.
 */

import { escapeRegExp } from "../common/escape-regexp.util";

export type QuoteTableField =
  "date" | "close" | "open" | "high" | "low" | "volume";

/**
 * One rank of header words. A header matches when it starts with one of the
 * `prefix` words, or with one of the `whole` words followed by no further
 * letter or digit ("Kurs" and "Kurs (EUR)", not "Kursziel"). With `qualified`,
 * a generic price noun may come first, so "Cours de clôture", "Prezzo di
 * chiusura", "Цена закрытия" and "Giá mở cửa" match like "Clôture",
 * "Chiusura", "Закрытие" and "Mở cửa".
 *
 * JavaScript's `\b` only knows ASCII letters, so it can never end a word like
 * "preço" or "дата"; the end of a word is a Unicode lookahead instead.
 */
interface HeaderWords {
  prefix?: string[];
  whole?: string[];
  qualified?: boolean;
}

/** Nouns for "price" that lead a header naming which price it is. */
const PRICE_NOUNS = [
  "price",
  "kurs",
  "cours",
  "prix",
  "koers",
  "precio",
  "prezzo",
  "preço",
  "preco",
  "cena",
  "цена",
  "ціна",
  "курс",
  "giá",
  "gia",
  "harga",
];
/**
 * What may join a price noun to its qualifier: "de", "di", "of", "d'", or a
 * French article ("Cours le plus haut", "Cours de la séance").
 */
const PRICE_JOINERS =
  "(?:(?:de|di|do|da|du|des|of)\\s+|d['\u2019]\\s*)?(?:(?:le|la|les)\\s+|l['\u2019]\\s*)?";

function alternation(words: string[]): string {
  return words.map(escapeRegExp).join("|");
}

function headerPattern({
  prefix = [],
  whole = [],
  qualified,
}: HeaderWords): RegExp {
  const options: string[] = [];
  if (prefix.length) options.push(`(?:${alternation(prefix)})`);
  if (whole.length) {
    options.push(`(?:${alternation(whole)})(?![\\p{L}\\p{N}])`);
  }
  const lead = qualified
    ? `(?:(?:${alternation(PRICE_NOUNS)})\\s*${PRICE_JOINERS})?`
    : "";
  return new RegExp(`^${lead}(?:${options.join("|")})`, "u");
}

/**
 * Header words per field, best rank first, in every language Monize is
 * translated into. A header is trimmed, lower-cased and matched from its
 * start, so "Schluss (EUR)" and "Close*" both match, while "Adj Close" and
 * "調整後終値" (adjusted close) do not. Where two columns match the same field,
 * the one matching the earlier rank wins (a "Schluss" column over a "Kurs"
 * column).
 */
const HEADER_WORDS: Record<QuoteTableField, HeaderWords[]> = {
  date: [
    {
      whole: [
        "datum",
        "date",
        "fecha",
        "дата",
        "tarih",
        "ngày",
        "ngay",
        "tanggal",
      ],
      prefix: [
        "तारीख",
        "दिनांक",
        "तिथि",
        "日付",
        "年月日",
        "날짜",
        "일자",
        "日期",
        "交易日期",
      ],
    },
    {
      whole: [
        "handelstag",
        "handelsdag",
        "trading day",
        "día",
        "dia",
        "data",
        "jour",
        "séance",
        "seance",
        "giorno",
        "dzień",
        "dzien",
        "день",
        "gün",
        "gun",
      ],
      prefix: ["交易日"],
    },
  ],
  close: [
    {
      qualified: true,
      prefix: [
        "schluss",
        "schluß",
        "close",
        "closing",
        "cierre",
        "chiusura",
        "fechamento",
        "fecho",
        "clôture",
        "cloture",
        "slot",
        "zamknię",
        "zamknie",
        "закр",
        "kapanış",
        "kapaniş",
        "kapanis",
        "đóng cửa",
        "dong cua",
        "penutupan",
        "बंद",
        "終値",
        "종가",
        "收盘",
        "收盤",
        "收市",
      ],
      whole: ["tutup"],
    },
    {
      prefix: [
        "rücknahmepreis",
        "ruecknahmepreis",
        "valor liquidativo",
        "valeur liquidative",
        "net asset value",
        "基準価額",
        "净值",
        "淨值",
      ],
      whole: ["nav"],
    },
    {
      prefix: [
        "zuletzt",
        "letzter",
        "last",
        "último",
        "ultimo",
        "akt. kurs",
        "akt.kurs",
        "akt kurs",
        "dernier",
        "laatste",
        "ostatni",
        "последн",
        "останн",
        "terakhir",
        "अंतिम",
        "現在値",
        "현재가",
        "最新价",
        "最新價",
        "成交价",
        "成交價",
      ],
      whole: ["son"],
    },
    {
      whole: [
        ...PRICE_NOUNS,
        "quote",
        "fiyat",
        "fiyatı",
        "fiyati",
        "मूल्य",
        "भाव",
      ],
      prefix: ["価格", "株価", "가격", "价格", "價格", "股价", "股價"],
    },
  ],
  open: [
    {
      qualified: true,
      prefix: [
        "erster",
        "eröffnung",
        "eroeffnung",
        "open",
        "apertura",
        "abertura",
        "ouverture",
        "otwarci",
        "откр",
        "відкр",
        "açılış",
        "açiliş",
        "acilis",
        "mở cửa",
        "mo cua",
        "pembukaan",
        "खुल",
        "始値",
        "开盘",
        "開盤",
      ],
      // "시가" (open) but not "시가총액" (market value).
      whole: ["buka", "시가"],
    },
  ],
  high: [
    {
      qualified: true,
      prefix: [
        "hoch",
        "tageshoch",
        "high",
        "máx",
        "max",
        "alto",
        "massimo",
        "plus haut",
        "haut",
        "hoog",
        "najwyższ",
        "najwyzsz",
        "макс",
        "en yüksek",
        "yüksek",
        "yuksek",
        "cao nhất",
        "cao nhat",
        "tertinggi",
        "उच्च",
        "अधिकतम",
        "高値",
        "고가",
        "最高",
      ],
      whole: ["cao"],
    },
  ],
  low: [
    {
      qualified: true,
      prefix: [
        "tief",
        "tagestief",
        "low",
        "mín",
        "min",
        "bajo",
        "plus bas",
        "laag",
        "najniższ",
        "najnizsz",
        "мин",
        "мін",
        "en düşük",
        "düşük",
        "dusuk",
        "thấp",
        "thap",
        "terendah",
        "निम्न",
        "न्यूनतम",
        "安値",
        "저가",
        "最低",
      ],
      whole: ["bas"],
    },
  ],
  volume: [
    {
      prefix: [
        "stücke",
        "stueck",
        "volume",
        "volumen",
        "umsatz",
        "vol.",
        "wolumen",
        "obrót",
        "obrot",
        "объём",
        "объем",
        "оборот",
        "обсяг",
        "об'єм",
        "об’єм",
        "hacim",
        "işlem hacmi",
        "islem hacmi",
        "khối lượng",
        "khoi luong",
        "वॉल्यूम",
        "मात्रा",
        "出来高",
        "거래량",
        "成交量",
      ],
      whole: ["vol", "kl"],
    },
  ],
};

const HEADER_PATTERNS: Record<QuoteTableField, RegExp[]> = Object.fromEntries(
  Object.entries(HEADER_WORDS).map(([field, ranks]) => [
    field,
    ranks.map(headerPattern),
  ]),
) as Record<QuoteTableField, RegExp[]>;

/**
 * Close ranks from here on are generic ("Last", "Kurs", "Цена"), so a column
 * that also names another field ("Kurs otwarcia", "Cours d'ouverture",
 * "Giá cao nhất") is that field's, not the close.
 */
const FIRST_GENERIC_CLOSE_RANK = 2;

/**
 * A header as the patterns see it: composed (a page may write "ô" as "o" plus
 * a combining circumflex), lower-cased, and without the combining dot that
 * lower-casing Turkish "İ" leaves behind ("İŞLEM" becomes "işlem").
 */
function headerKey(raw: string): string {
  return raw
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/\u0307/g, "");
}

export const FIELDS = Object.keys(HEADER_PATTERNS) as QuoteTableField[];

/** Map header texts to the column index of each field, best pattern first. */
export function mapHeader(
  texts: string[],
): Partial<Record<QuoteTableField, number>> {
  const result: Partial<Record<QuoteTableField, number>> = {};
  const taken = new Set<number>();
  for (const field of FIELDS) {
    let bestIndex: number | undefined;
    let bestRank = Infinity;
    texts.forEach((raw, index) => {
      if (taken.has(index)) return;
      const text = headerKey(raw);
      if (!text) return;
      const rank = HEADER_PATTERNS[field].findIndex((re) => re.test(text));
      if (
        field === "close" &&
        rank >= FIRST_GENERIC_CLOSE_RANK &&
        namesAnotherPrice(text)
      ) {
        return;
      }
      if (rank >= 0 && rank < bestRank) {
        bestRank = rank;
        bestIndex = index;
      }
    });
    if (bestIndex !== undefined) {
      result[field] = bestIndex;
      taken.add(bestIndex);
    }
  }
  return result;
}

/** Whether a header names the open, high, low or volume. */
function namesAnotherPrice(text: string): boolean {
  return (["open", "high", "low", "volume"] as const).some((field) =>
    HEADER_PATTERNS[field].some((re) => re.test(text)),
  );
}

/**
 * The decimal separator a table's own header language implies, or `null` when
 * the words do not settle it. English, Hindi, Chinese, Japanese and Korean
 * headers ("Close", "बंद", "收盘", "終値", "종가") mean a dot; German, French,
 * Italian, Portuguese, Dutch, Polish, Russian, Ukrainian, Turkish, Vietnamese
 * and Indonesian ones a comma. Spanish says nothing: "Fecha" / "Cierre" is
 * written by Spain with a decimal comma and by Mexico with a decimal point.
 * Nor does "Date", which is English and French. Headers that disagree say
 * nothing either.
 */
export function headerSeparatorHint(headers: string[]): "." | "," | null {
  let hint: "." | "," | null = null;
  for (const raw of headers) {
    const text = headerKey(raw);
    const said = DOT_HEADERS.test(text)
      ? "."
      : COMMA_HEADERS.test(text)
        ? ","
        : null;
    if (!said) continue;
    if (hint && hint !== said) return null;
    hint = said;
  }
  return hint;
}

const DOT_HEADERS = headerPattern({
  whole: [
    "trading day",
    "close",
    "closing",
    "last",
    "price",
    "quote",
    "nav",
    "net asset value",
  ],
  prefix: [
    "तारीख",
    "दिनांक",
    "तिथि",
    "बंद",
    "अंतिम",
    "मूल्य",
    "भाव",
    "日付",
    "年月日",
    "終値",
    "現在値",
    "価格",
    "株価",
    "基準価額",
    "날짜",
    "일자",
    "종가",
    "현재가",
    "가격",
    "日期",
    "交易日",
    "收盘",
    "收盤",
    "收市",
    "最新价",
    "最新價",
    "价格",
    "價格",
    "净值",
    "淨值",
  ],
});
const COMMA_HEADERS = headerPattern({
  prefix: [
    // German
    "datum",
    "handelstag",
    "schluss",
    "schluß",
    "zuletzt",
    "letzter",
    "kurs",
    "rücknahmepreis",
    "ruecknahmepreis",
    // Italian, Portuguese
    "giorno",
    "chiusura",
    "prezzo",
    "fechamento",
    "fecho",
    "preço",
    "preco",
    // French
    "jour",
    "séance",
    "seance",
    "clôture",
    "cloture",
    "dernier",
    "cours",
    "prix",
    "valeur liquidative",
    // Dutch
    "handelsdag",
    "slot",
    "laatste",
    "koers",
    // Polish
    "dzień",
    "dzien",
    "zamknię",
    "zamknie",
    "ostatni",
    "cena",
    // Russian, Ukrainian
    "дата",
    "день",
    "закр",
    "последн",
    "останн",
    "цена",
    "ціна",
    "курс",
    // Turkish
    "tarih",
    "kapanış",
    "kapaniş",
    "kapanis",
    "fiyat",
    // Vietnamese
    "ngày",
    "ngay",
    "đóng cửa",
    "dong cua",
    // Indonesian
    "tanggal",
    "penutupan",
    "tutup",
    "terakhir",
    "harga",
  ],
  // Short words that begin longer, unrelated ones.
  whole: ["data", "gün", "gun", "son", "giá", "gia"],
});
