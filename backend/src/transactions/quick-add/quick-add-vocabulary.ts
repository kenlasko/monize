/**
 * The words the Quick Add reader understands besides names, numbers and
 * dates, one entry per base language of `SUPPORTED_LOCALE_CODES`
 * (`docs/future-plans/quick-add.md`, "Vocabulary").
 *
 * This is grammar, not display copy: nobody reads these words back, so they
 * are a constant checked by `quick-add-vocabulary.spec.ts`, not a translation
 * catalog. Month and weekday names and the yesterday / today / tomorrow words
 * come from `Intl` (`quick-add-dates.util.ts`), so they are not listed here.
 *
 * Roles:
 * - `deposit`, `payment`, `transfer` set the entry's kind.
 * - `to`, `from` give a named account its side of a transfer.
 * - `on` names the account a payment is made with, without a direction.
 * - `filler` is dropped.
 *
 * A word is listed in one role per language (the spec holds it). Words are
 * written in lower case; the reader folds case and Latin, Greek and Cyrillic
 * diacritics before it compares, so `pagué` also finds `pague`.
 */

export const QUICK_ADD_VOCABULARY_ROLES = [
  "deposit",
  "payment",
  "transfer",
  "to",
  "from",
  "on",
  "filler",
] as const;

export type QuickAddVocabularyRole =
  (typeof QUICK_ADD_VOCABULARY_ROLES)[number];

/** Where a connector (`to`, `from`, `on`) stands relative to the account it governs. */
export type QuickAddConnectorPosition = "before" | "after";

export interface QuickAddLanguageVocabulary {
  /**
   * `after` for a language whose connectors follow the noun (Japanese
   * `貯金へ`, Korean `저축으로`, Hindi `बचत में`, Turkish `hesabına`);
   * `before` for prepositions.
   */
  readonly connectorPosition: QuickAddConnectorPosition;
  readonly words: Readonly<Record<QuickAddVocabularyRole, readonly string[]>>;
}

export const QUICK_ADD_VOCABULARY_LANGUAGES = [
  "en",
  "de",
  "es",
  "fr",
  "hi",
  "id",
  "it",
  "ja",
  "ko",
  "nl",
  "pl",
  "pt",
  "ru",
  "tr",
  "uk",
  "vi",
  "zh-CN",
  "zh-TW",
] as const;

export type QuickAddVocabularyLanguage =
  (typeof QUICK_ADD_VOCABULARY_LANGUAGES)[number];

export const QUICK_ADD_VOCABULARY: Readonly<
  Record<QuickAddVocabularyLanguage, QuickAddLanguageVocabulary>
> = {
  en: {
    connectorPosition: "before",
    words: {
      deposit: [
        "refund",
        "refunded",
        "deposit",
        "deposited",
        "received",
        "income",
        "salary",
        "paycheck",
        "paycheque",
        "reimbursed",
        "reimbursement",
        "earned",
      ],
      payment: [
        "paid",
        "pay",
        "spent",
        "spend",
        "bought",
        "purchase",
        "purchased",
        "payment",
        "charged",
      ],
      transfer: ["transfer", "transferred", "moved", "xfer"],
      to: ["to", "into"],
      from: ["from"],
      on: ["on", "at", "with", "via", "using"],
      filler: ["for", "the", "a", "an", "of", "my"],
    },
  },
  de: {
    connectorPosition: "before",
    words: {
      deposit: [
        "erstattung",
        "rückerstattung",
        "gutschrift",
        "einzahlung",
        "eingang",
        "erhalten",
        "bekommen",
        "einnahme",
        "gehalt",
        "lohn",
      ],
      payment: [
        "bezahlt",
        "gezahlt",
        "zahlung",
        "ausgabe",
        "ausgegeben",
        "gekauft",
        "kauf",
        "abbuchung",
      ],
      transfer: [
        "überweisung",
        "überwiesen",
        "übertrag",
        "umbuchung",
        "umgebucht",
      ],
      to: ["an", "auf", "nach", "zu", "zum", "zur", "ins"],
      from: ["von", "vom", "aus"],
      on: ["mit", "per", "bei", "beim", "über", "via"],
      filler: [
        "für",
        "der",
        "die",
        "das",
        "den",
        "dem",
        "ein",
        "eine",
        "einen",
      ],
    },
  },
  es: {
    connectorPosition: "before",
    words: {
      deposit: [
        "reembolso",
        "devolución",
        "depósito",
        "ingreso",
        "recibido",
        "recibí",
        "cobrado",
        "cobré",
        "sueldo",
        "salario",
        "nómina",
      ],
      payment: [
        "pagado",
        "pagué",
        "pago",
        "gasto",
        "gasté",
        "gastado",
        "compra",
        "compré",
        "comprado",
      ],
      transfer: [
        "transferencia",
        "transferido",
        "transferí",
        "traspaso",
        "movido",
      ],
      to: ["a", "al", "hacia"],
      from: ["de", "del", "desde"],
      on: ["en", "con", "por", "vía", "mediante"],
      filler: ["para", "el", "la", "los", "las", "un", "una"],
    },
  },
  fr: {
    connectorPosition: "before",
    words: {
      deposit: [
        "remboursement",
        "remboursé",
        "dépôt",
        "déposé",
        "reçu",
        "encaissé",
        "revenu",
        "salaire",
        "paie",
      ],
      payment: ["payé", "paiement", "dépense", "acheté", "achat", "réglé"],
      transfer: ["virement", "transfert", "transféré", "viré"],
      to: ["à", "au", "aux", "vers"],
      from: ["de", "du", "des", "depuis"],
      on: ["sur", "chez", "avec", "via", "par", "en"],
      filler: ["pour", "le", "la", "les", "un", "une"],
    },
  },
  hi: {
    connectorPosition: "after",
    words: {
      deposit: ["रिफंड", "वापसी", "जमा", "प्राप्त", "मिला", "आय", "वेतन", "तनख्वाह"],
      payment: ["भुगतान", "खर्च", "दिया", "खरीदा", "खरीदी", "चुकाया"],
      transfer: ["ट्रांसफर", "स्थानांतरण", "अंतरण", "भेजा"],
      to: ["को", "में", "तक"],
      from: ["से"],
      on: ["पर", "द्वारा", "साथ"],
      filler: ["के", "का", "की", "लिए", "एक"],
    },
  },
  id: {
    connectorPosition: "before",
    words: {
      deposit: [
        "refund",
        "pengembalian",
        "setoran",
        "setor",
        "diterima",
        "terima",
        "pemasukan",
        "pendapatan",
        "gaji",
      ],
      payment: [
        "bayar",
        "dibayar",
        "membayar",
        "pembayaran",
        "beli",
        "membeli",
        "dibeli",
        "belanja",
        "pengeluaran",
      ],
      transfer: ["transfer", "pindah", "dipindahkan", "kirim"],
      to: ["ke", "kepada"],
      from: ["dari"],
      on: ["di", "dengan", "pakai", "via", "lewat"],
      filler: ["untuk", "buat", "yang"],
    },
  },
  it: {
    connectorPosition: "before",
    words: {
      deposit: [
        "rimborso",
        "rimborsato",
        "deposito",
        "versamento",
        "versato",
        "ricevuto",
        "incassato",
        "entrata",
        "stipendio",
      ],
      payment: [
        "pagato",
        "pagamento",
        "speso",
        "spesa",
        "comprato",
        "acquisto",
        "acquistato",
      ],
      transfer: [
        "bonifico",
        "trasferimento",
        "trasferito",
        "giroconto",
        "spostato",
      ],
      to: ["a", "al", "alla", "allo", "ai", "verso"],
      from: ["da", "dal", "dalla", "dallo", "dai"],
      on: ["con", "su", "presso", "tramite", "via"],
      filler: ["per", "il", "lo", "la", "i", "gli", "le", "un", "uno", "una"],
    },
  },
  ja: {
    connectorPosition: "after",
    words: {
      deposit: ["返金", "払い戻し", "入金", "受け取り", "収入", "給料", "給与"],
      payment: ["支払い", "支払", "払った", "購入", "買った", "出費", "支出"],
      transfer: ["振替", "振り替え", "移動", "送金"],
      to: ["へ", "に", "まで"],
      from: ["から", "より"],
      on: ["で"],
      filler: ["の", "を", "は", "が"],
    },
  },
  ko: {
    connectorPosition: "after",
    words: {
      deposit: ["환불", "입금", "수입", "월급", "급여", "받음"],
      payment: ["결제", "지불", "지출", "구매", "샀음"],
      transfer: ["이체", "송금", "이동"],
      to: ["으로", "로", "에게", "에"],
      from: ["에서", "부터"],
      on: ["통해", "이용"],
      filler: ["의", "을", "를", "은", "는", "이", "가"],
    },
  },
  nl: {
    connectorPosition: "before",
    words: {
      deposit: [
        "terugbetaling",
        "teruggave",
        "storting",
        "gestort",
        "ontvangen",
        "inkomsten",
        "salaris",
        "loon",
      ],
      payment: [
        "betaald",
        "betaling",
        "uitgegeven",
        "uitgave",
        "gekocht",
        "aankoop",
      ],
      transfer: [
        "overboeking",
        "overgeboekt",
        "overschrijving",
        "overgemaakt",
        "verplaatst",
      ],
      to: ["naar", "aan"],
      from: ["van", "vanaf", "uit"],
      on: ["op", "bij", "met", "via"],
      filler: ["voor", "de", "het", "een"],
    },
  },
  pl: {
    connectorPosition: "before",
    words: {
      deposit: [
        "zwrot",
        "wpłata",
        "wpłacono",
        "otrzymano",
        "przychód",
        "pensja",
        "wynagrodzenie",
      ],
      payment: [
        "zapłacono",
        "zapłaciłem",
        "płatność",
        "wydano",
        "wydatek",
        "kupiono",
        "kupiłem",
        "zakup",
      ],
      transfer: ["przelew", "przelano", "przeniesiono"],
      to: ["na", "do"],
      from: ["z", "ze", "od"],
      on: ["w", "przez", "przy"],
      filler: ["za", "dla"],
    },
  },
  pt: {
    connectorPosition: "before",
    words: {
      deposit: [
        "reembolso",
        "estorno",
        "depósito",
        "depositado",
        "recebido",
        "recebi",
        "receita",
        "salário",
        "rendimento",
      ],
      payment: [
        "pago",
        "paguei",
        "pagamento",
        "gasto",
        "gastei",
        "compra",
        "comprei",
        "comprado",
        "despesa",
      ],
      transfer: ["transferência", "transferido", "transferi", "movido"],
      to: ["para", "pra", "ao", "aos"],
      from: ["de", "do", "da", "dos", "das", "desde"],
      on: ["em", "no", "na", "com", "via", "pelo", "pela"],
      filler: ["o", "a", "os", "as", "um", "uma"],
    },
  },
  ru: {
    connectorPosition: "before",
    words: {
      deposit: [
        "возврат",
        "пополнение",
        "зачисление",
        "получено",
        "получил",
        "получила",
        "доход",
        "зарплата",
      ],
      payment: [
        "оплата",
        "оплатил",
        "оплатила",
        "заплатил",
        "заплатила",
        "потратил",
        "потратила",
        "покупка",
        "купил",
        "купила",
        "расход",
      ],
      transfer: ["перевод", "перевел", "перевела", "перемещение"],
      to: ["на", "в", "во", "к"],
      from: ["с", "со", "из", "от"],
      on: ["через", "у", "при"],
      filler: ["за", "для"],
    },
  },
  tr: {
    connectorPosition: "after",
    words: {
      deposit: ["iade", "yatırma", "yatırıldı", "alındı", "gelir", "maaş"],
      payment: [
        "ödeme",
        "ödendi",
        "ödedim",
        "harcama",
        "harcadım",
        "satın",
        "alışveriş",
      ],
      transfer: ["transfer", "havale", "eft", "aktarım", "aktarıldı"],
      to: ["hesabına"],
      from: ["hesabından"],
      on: ["ile", "üzerinden", "kartla"],
      filler: ["için", "bir"],
    },
  },
  uk: {
    connectorPosition: "before",
    words: {
      deposit: [
        "повернення",
        "поповнення",
        "зарахування",
        "отримано",
        "отримав",
        "отримала",
        "дохід",
        "зарплата",
      ],
      payment: [
        "оплата",
        "оплатив",
        "оплатила",
        "заплатив",
        "заплатила",
        "витратив",
        "витратила",
        "покупка",
        "купив",
        "купила",
        "витрата",
      ],
      transfer: ["переказ", "переказав", "переказала", "переміщення"],
      to: ["на", "в", "до"],
      from: ["з", "із", "зі", "від"],
      on: ["через", "при", "у"],
      filler: ["за", "для"],
    },
  },
  vi: {
    connectorPosition: "before",
    words: {
      deposit: ["hoàn tiền", "nạp tiền", "nhận tiền", "thu nhập", "lương"],
      payment: ["trả tiền", "thanh toán", "chi tiêu", "mua", "đã mua"],
      transfer: ["chuyển khoản", "chuyển tiền", "chuyển"],
      to: ["sang", "đến", "vào", "tới"],
      from: ["từ"],
      on: ["tại", "ở", "bằng", "qua"],
      filler: ["cho", "một", "các"],
    },
  },
  "zh-CN": {
    connectorPosition: "before",
    words: {
      deposit: ["退款", "存入", "存款", "收入", "收到", "工资", "报销"],
      payment: ["支付", "付款", "付了", "花了", "消费", "购买", "买了"],
      transfer: ["转账", "转帐", "划转"],
      to: ["到", "给", "至"],
      from: ["从", "自"],
      on: ["在", "用", "通过"],
      filler: ["的", "了"],
    },
  },
  "zh-TW": {
    connectorPosition: "before",
    words: {
      deposit: ["退款", "存入", "存款", "收入", "收到", "薪水", "報銷"],
      payment: ["支付", "付款", "付了", "花了", "消費", "購買", "買了"],
      transfer: ["轉帳", "轉賬", "匯款"],
      to: ["到", "給", "至"],
      from: ["從", "自"],
      on: ["在", "用", "透過"],
      filler: ["的", "了"],
    },
  },
};

/** Chinese tags that are written in Traditional characters. */
const TRADITIONAL_CHINESE = /^zh-(?:tw|hk|mo|hant)\b/i;

/**
 * The vocabulary entry a locale code reads: its own entry, else its base
 * language's (`pt-BR` reads `pt`, `en-CA` reads `en`), with Chinese split by
 * script (`zh-TW` and the other Traditional tags read `zh-TW`, every other
 * `zh` tag `zh-CN`). Anything else, the `xx` pseudo-locale included, reads
 * English.
 */
export function quickAddVocabularyLanguage(
  locale: string | null | undefined,
): QuickAddVocabularyLanguage {
  const code = (locale ?? "").trim();
  if (code === "") return "en";
  const lower = code.toLowerCase();
  if (lower === "zh" || lower.startsWith("zh-")) {
    return TRADITIONAL_CHINESE.test(lower) ? "zh-TW" : "zh-CN";
  }
  const base = lower.split("-")[0];
  return (QUICK_ADD_VOCABULARY_LANGUAGES as readonly string[]).includes(base)
    ? (base as QuickAddVocabularyLanguage)
    : "en";
}

/** One word of a resolved vocabulary, with the position rule of its own language. */
export interface QuickAddVocabularyWord {
  readonly word: string;
  readonly role: QuickAddVocabularyRole;
  readonly position: QuickAddConnectorPosition;
}

/**
 * The words a reader in `locale` is understood in: their language's words
 * first, then English's (always understood as well). A word both lists hold
 * appears twice here; the reader keeps the first, so the reader's own
 * language decides its role (Spanish `a` is "to", not the English article).
 */
export function resolveQuickAddVocabulary(
  locale: string | null | undefined,
): readonly QuickAddVocabularyWord[] {
  const language = quickAddVocabularyLanguage(locale);
  const languages: QuickAddVocabularyLanguage[] =
    language === "en" ? ["en"] : [language, "en"];
  return languages.flatMap((lang) => {
    const entry = QUICK_ADD_VOCABULARY[lang];
    return QUICK_ADD_VOCABULARY_ROLES.flatMap((role) =>
      entry.words[role].map((word) => ({
        word,
        role,
        position: entry.connectorPosition,
      })),
    );
  });
}
