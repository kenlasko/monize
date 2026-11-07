import {
  DEFAULT_MATCH_BY,
  DEFAULT_MATCH_DAYS_AFTER,
  DEFAULT_MATCH_DAYS_BEFORE,
  RECEIPT_DISCARD_MODES,
  RECEIPT_LINES_SOURCES,
  RECEIPT_MATCH_STRATEGIES,
  RECEIPT_MATCH_TEXT_FIELDS,
  RECEIPT_PARSER_LIMITS,
  type CreateEmailReceiptParserPayload,
  type EmailReceiptParser,
  type ReceiptDiscardMode,
  type ReceiptLinesSource,
  type ReceiptMatchDefinition,
  type ReceiptMatchStrategy,
  type ReceiptMatchTextField,
  type ReceiptParserDefinition,
  type ReceiptParserValidationError,
  type ReceiptTradeAccountRule,
  type ReceiptTradeCurrencyMarker,
  type ReceiptTradeDefinition,
} from '@/types/email-receipts';
import { isRecord } from '@/lib/helpers/is-record';
import { newClientId } from '@/lib/client-id';

/**
 * The parser editor's form state and its conversion to and from the stored
 * definition (design section 5.1). Pure, so the JSON the editor sends is
 * tested without rendering it. Patterns are one per line in a textarea; the
 * server's validator is the authority on what a pattern may hold, so nothing
 * here rejects a pattern, it only builds the structure.
 */

/** The only definition version the server reads; the form always writes it. */
export const PARSER_DEFINITION_VERSION = 2;

/** What a profile reads: an order confirmation (matched to a bank transaction) or a brokerage trade confirmation. */
export type ParserKind = 'receipt' | 'trade';

/** One account rule of a trade profile as the form edits it; `id` keys the row and is never sent. */
export interface TradeAccountRuleRow {
  id: string;
  match: string;
  /** A 3-letter code, `''` for any currency. */
  currency: string;
  /** `''` until an account is picked. */
  accountId: string;
}

/** One currency marker of a trade profile as the form edits it; `id` keys the row and is never sent. */
export interface TradeCurrencyMarkerRow {
  id: string;
  match: string;
  /** `''` until a currency is picked. */
  currency: string;
}

/** The trade section's pattern lists, each with the form field holding it (one pattern per line). */
export const TRADE_PATTERN_FIELDS = [
  ['action', 'tradeAction'],
  ['symbol', 'tradeSymbol'],
  ['quantity', 'tradeQuantity'],
  ['total', 'tradeTotal'],
  ['price', 'tradePrice'],
  ['commission', 'tradeCommission'],
  ['date', 'tradeDate'],
  ['account', 'tradeAccount'],
] as const;
export type TradePatternFormField = (typeof TRADE_PATTERN_FIELDS)[number][1];

/** The line guards, one pattern per line. The form edits them on a trade profile only. */
export const GUARD_FIELDS = ['requireLine', 'skipIfLine', 'waitIfLine'] as const;

export interface ParserFormState {
  /** Set by the definition (a `trade` section); a new profile picks it. */
  kind: ParserKind;
  name: string;
  payeeId: string;
  /** Comma, semicolon, space or line separated. */
  fromDomains: string;
  /** Comma or line separated (a word may hold spaces). */
  subjectContains: string;
  /** The lines the patterns read: the email's text (the default) or its HTML part. */
  source: ReceiptLinesSource;
  /** One pattern per line, for each of the four fields below. */
  orderId: string;
  total: string;
  shipping: string;
  discount: string;
  startAfter: string;
  stopAt: string;
  itemPatterns: string;
  /** One pattern per line, for the fees of the order (a payment or handling charge). */
  fees: string;
  /** Categories are named: the full name as the category list shows it, `''` for none. */
  defaultCategory: string;
  shippingCategory: string;
  feesCategory: string;
  /** One pattern per line: an identifier the shop or gateway puts into the bank operation. */
  reference: string;
  /** The strategies that are on, in the order they are tried. Never empty. */
  matchBy: ReceiptMatchStrategy[];
  /** The transaction fields `reference` and `orderId` are looked for in; never empty. */
  matchReferenceIn: ReceiptMatchTextField[];
  /** Days before the purchase date to look; `null` is the default (3). */
  matchDaysBefore: number | null;
  /** Days after the purchase date to look; `null` is the default (14). */
  matchDaysAfter: number | null;
  /** How far the bank amount may differ, in currency units (0 to 5); `null` is exact. */
  matchTolerance: number | null;
  /** Whether the profile adds a tag to the transactions it categorises. */
  tagEnabled: boolean;
  tagName: string;
  /** Ask the user's AI for the category of an item no rule matched. */
  aiCategories: boolean;
  /** What the profile does with the emails it matches instead of reading them; `''` reads them. */
  discard: ReceiptDiscardMode | '';
  /** The line guards (trade profile): one pattern per line. */
  requireLine: string;
  skipIfLine: string;
  waitIfLine: string;
  /** The trade section's pattern lists (trade profile): one pattern per line. */
  tradeAction: string;
  tradeSymbol: string;
  tradeQuantity: string;
  tradeTotal: string;
  tradePrice: string;
  tradeCommission: string;
  tradeDate: string;
  tradeAccount: string;
  /** Tried in order; the first that applies decides the account. */
  tradeAccountRules: TradeAccountRuleRow[];
  /** The account when no rule applies; `''` for none. */
  tradeDefaultAccountId: string;
  /** Tried in order; the first whose glob matches a line names the currency. */
  tradeCurrencyMarkers: TradeCurrencyMarkerRow[];
}

/**
 * A change to the form: the fields that moved, or a function of the form as it
 * is when the change is applied. A list edited from the previous render's copy
 * (append a rule, remove a rule) loses a change made in the same batch, so the
 * list fields use the function.
 */
export type ParserFormChange = (
  changes: Partial<ParserFormState> | ((current: ParserFormState) => Partial<ParserFormState>),
) => void;

export const emptyParserForm = (overrides: Partial<ParserFormState> = {}): ParserFormState => ({
  kind: 'receipt',
  name: '',
  payeeId: '',
  fromDomains: '',
  subjectContains: '',
  source: 'text',
  orderId: '',
  total: '',
  shipping: '',
  discount: '',
  startAfter: '',
  stopAt: '',
  itemPatterns: '',
  fees: '',
  defaultCategory: '',
  shippingCategory: '',
  feesCategory: '',
  reference: '',
  matchBy: [...DEFAULT_MATCH_BY],
  matchReferenceIn: [...RECEIPT_MATCH_TEXT_FIELDS],
  matchDaysBefore: null,
  matchDaysAfter: null,
  matchTolerance: null,
  tagEnabled: false,
  tagName: '',
  aiCategories: false,
  discard: '',
  requireLine: '',
  skipIfLine: '',
  waitIfLine: '',
  tradeAction: '',
  tradeSymbol: '',
  tradeQuantity: '',
  tradeTotal: '',
  tradePrice: '',
  tradeCommission: '',
  tradeDate: '',
  tradeAccount: '',
  tradeAccountRules: [],
  tradeDefaultAccountId: '',
  tradeCurrencyMarkers: [],
  ...overrides,
});

/** A new, empty account rule row (any currency, no account yet). */
export const newTradeAccountRule = (): TradeAccountRuleRow => ({
  id: newClientId(),
  match: '',
  currency: '',
  accountId: '',
});

/** A new, empty currency marker row. */
export const newTradeCurrencyMarker = (): TradeCurrencyMarkerRow => ({ id: newClientId(), match: '', currency: '' });

/**
 * The currencies a trade profile's pickers offer, in order: the user's base
 * currency, their other active currencies A-Z, then any code the profile already
 * holds that is neither (an inactive currency, a hand-written code), so a stored
 * value is shown as it is rather than as blank.
 */
export function tradeCurrencyChoices(
  baseCurrency: string,
  activeCodes: readonly string[],
  heldCodes: readonly string[],
): string[] {
  const others = [...new Set(activeCodes)].filter((code) => code !== baseCurrency).sort();
  const listed = [baseCurrency, ...others];
  const held = [...new Set(heldCodes)].filter((code) => code !== '' && !listed.includes(code));
  return [...listed, ...held];
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * A tolerance in whole currency units as the server's decimal string, in integer
 * cents (no float is formatted): `0.5` is `"0.50"`. `null` and zero are "exact" and
 * leave the key out.
 */
export function toleranceToString(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  const cents = Math.round(value * 100);
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * A tolerance string as currency units, or `null` when the form cannot hold it
 * (more than two decimals, a sign, text): such a profile is edited as JSON. Read
 * digit by digit, never with `parseFloat`.
 */
export function toleranceFromString(text: string): number | null {
  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? '' : text.slice(dot + 1);
  if (!/^\d{1,3}$/.test(whole) || (dot !== -1 && !/^\d{1,2}$/.test(fraction))) return null;
  return (Number(whole) * 100 + Number(fraction.padEnd(2, '0'))) / 100;
}

/**
 * The strategies a profile tries when it names none: the reference first when
 * the profile reads one from the bank operation, then the order number, then the
 * amount with the payee, then the amount with the date. Mirrors the server's default.
 */
export function defaultMatchBy(hasReference: boolean): ReceiptMatchStrategy[] {
  return hasReference ? ['reference', ...DEFAULT_MATCH_BY] : [...DEFAULT_MATCH_BY];
}

/**
 * The form's `matchBy` after `reference` changed: a profile that gains its first
 * reference pattern and still has the plain default order gets the reference
 * strategy first, and one that loses its last pattern while on that default
 * drops it. A list the person arranged is left alone.
 */
export function matchByAfterReferenceChange(
  matchBy: readonly ReceiptMatchStrategy[],
  hadReference: boolean,
  hasReference: boolean,
): ReceiptMatchStrategy[] {
  if (hadReference === hasReference) return [...matchBy];
  if (sameList(matchBy, defaultMatchBy(hadReference))) return defaultMatchBy(hasReference);
  return [...matchBy];
}

/** The `match` section the form describes: only what differs from the defaults, so a form that changes nothing sends nothing. */
export function buildMatchDefinition(form: ParserFormState): ReceiptMatchDefinition | null {
  const match: ReceiptMatchDefinition = {};
  if (!sameList(form.matchBy, defaultMatchBy(splitLines(form.reference).length > 0))) match.by = [...form.matchBy];
  if (!sameList(form.matchReferenceIn, RECEIPT_MATCH_TEXT_FIELDS)) match.referenceIn = [...form.matchReferenceIn];
  // The server answers the effective window, so a value that is the default is no change.
  if (form.matchDaysBefore !== null && form.matchDaysBefore !== DEFAULT_MATCH_DAYS_BEFORE) {
    match.daysBefore = form.matchDaysBefore;
  }
  if (form.matchDaysAfter !== null && form.matchDaysAfter !== DEFAULT_MATCH_DAYS_AFTER) {
    match.daysAfter = form.matchDaysAfter;
  }
  const tolerance = toleranceToString(form.matchTolerance);
  if (tolerance !== null) match.amountTolerance = tolerance;
  return Object.keys(match).length > 0 ? match : null;
}

/** Non-blank lines, trimmed. A pattern may hold a comma, so lines are the only separator. */
export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Non-blank entries separated by a line break or a comma, trimmed. */
export function splitWords(text: string): string[] {
  return text
    .split(/[\r\n,]+/)
    .map((word) => word.trim())
    .filter((word) => word !== '');
}

/** Domains separated by whitespace, commas or semicolons; a leading `@` is what a pasted address leaves. */
export function splitDomains(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((domain) => domain.trim().replace(/^@+/, ''))
    .filter((domain) => domain !== '');
}

/**
 * The definition the form describes. An empty field is left out (an absent
 * field reads nothing), but `items` is sent whenever any of its three parts is
 * filled, so a section marker with no pattern is reported by the server as
 * `items.patterns: empty` instead of being dropped without a word.
 */
export function buildParserDefinition(form: ParserFormState): ReceiptParserDefinition {
  if (form.kind === 'trade') return buildTradeDefinition(form);
  const definition: ReceiptParserDefinition = { version: PARSER_DEFINITION_VERSION };
  // The text source is the default, so it is left out (reading it back gives the same form).
  if (form.source === 'html') definition.source = 'html';

  const orderId = splitLines(form.orderId);
  const total = splitLines(form.total);
  const shipping = splitLines(form.shipping);
  const discount = splitLines(form.discount);
  if (orderId.length > 0) definition.orderId = orderId;
  if (total.length > 0) definition.total = total;
  if (shipping.length > 0) definition.shipping = shipping;
  if (discount.length > 0) definition.discount = discount;

  const patterns = splitLines(form.itemPatterns);
  const startAfter = form.startAfter.trim();
  const stopAt = form.stopAt.trim();
  if (patterns.length > 0 || startAfter !== '' || stopAt !== '') {
    definition.items = {
      ...(startAfter !== '' ? { startAfter } : {}),
      ...(stopAt !== '' ? { stopAt } : {}),
      patterns,
    };
  }

  const fees = splitLines(form.fees);
  if (fees.length > 0) definition.fees = fees;

  if (form.defaultCategory.trim() !== '') definition.defaultCategory = form.defaultCategory.trim();
  if (form.shippingCategory.trim() !== '') definition.shippingCategory = form.shippingCategory.trim();
  if (form.feesCategory.trim() !== '') definition.feesCategory = form.feesCategory.trim();

  const reference = splitLines(form.reference);
  if (reference.length > 0) definition.reference = reference;
  const match = buildMatchDefinition(form);
  if (match !== null) definition.match = match;
  // A tag switched on with no name takes the profile's own name (the default the form offers).
  const tag = form.tagName.trim() !== '' ? form.tagName.trim() : form.name.trim();
  if (form.tagEnabled && tag !== '') definition.tag = tag;
  if (form.aiCategories) definition.aiCategories = true;
  if (form.discard !== '') definition.discard = form.discard;
  return definition;
}

const isBlankRule = (rule: TradeAccountRuleRow): boolean =>
  rule.match.trim() === '' && rule.currency === '' && rule.accountId === '';
const isBlankMarker = (marker: TradeCurrencyMarkerRow): boolean => marker.match.trim() === '' && marker.currency === '';

/**
 * A trade profile's definition: the `trade` section, the lines source and the
 * line guards, nothing else (the server refuses any receipt key beside `trade`).
 * The section is always sent, so an empty required list is reported by the
 * server (`trade.action: empty`) rather than the profile turning into a receipt
 * one. An empty optional list (`quantity` among them: a cash dividend states no
 * share count) is left out and simply not read. A row left wholly blank is
 * dropped; a row half filled is sent as it is, so the server names what is
 * missing.
 */
function buildTradeDefinition(form: ParserFormState): ReceiptParserDefinition {
  const definition: ReceiptParserDefinition = { version: PARSER_DEFINITION_VERSION };
  if (form.source === 'html') definition.source = 'html';

  const trade: Partial<ReceiptTradeDefinition> = {};
  for (const [key, field] of TRADE_PATTERN_FIELDS) {
    const patterns = splitLines(form[field]);
    if (patterns.length > 0) trade[key] = patterns;
  }
  const rules = form.tradeAccountRules
    .filter((rule) => !isBlankRule(rule))
    .map(
      (rule): ReceiptTradeAccountRule => ({
        match: rule.match.trim(),
        accountId: rule.accountId,
        ...(rule.currency !== '' ? { currency: rule.currency } : {}),
      }),
    );
  if (rules.length > 0) trade.accountRules = rules;
  if (form.tradeDefaultAccountId !== '') trade.defaultAccountId = form.tradeDefaultAccountId;
  const markers = form.tradeCurrencyMarkers
    .filter((marker) => !isBlankMarker(marker))
    .map((marker): ReceiptTradeCurrencyMarker => ({ match: marker.match.trim(), currency: marker.currency }));
  if (markers.length > 0) trade.currencyMarkers = markers;
  definition.trade = trade as ReceiptTradeDefinition;

  for (const field of GUARD_FIELDS) {
    const patterns = splitLines(form[field]);
    if (patterns.length > 0) definition[field] = patterns;
  }
  if (form.discard !== '') definition.discard = form.discard;
  return definition;
}

/** What a stored definition does with the emails it matches instead of reading them (`discard`); null when it reads them. */
export function discardModeOf(value: unknown): ReceiptDiscardMode | null {
  if (!isRecord(value)) return null;
  return RECEIPT_DISCARD_MODES.includes(value.discard as ReceiptDiscardMode) ? (value.discard as ReceiptDiscardMode) : null;
}

/** Does this stored definition read brokerage trade confirmations (it has a `trade` section)? */
export function isTradeDefinition(value: unknown): boolean {
  return isRecord(value) && value.trade !== undefined;
}

/**
 * The create payload; update sends the same fields plus the revision it was
 * read at. The definition is the form's unless the JSON editor supplies one.
 */
export function buildParserPayload(
  form: ParserFormState,
  definition: ReceiptParserDefinition = buildParserDefinition(form),
): CreateEmailReceiptParserPayload {
  return {
    name: form.name.trim(),
    // A trade creates an investment transaction, which has no payee: the editor shows no payee picker for it.
    payeeId: form.payeeId === '' || definition.trade !== undefined ? null : form.payeeId,
    fromDomains: splitDomains(form.fromDomains),
    subjectContains: splitWords(form.subjectContains),
    definition,
  };
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

type DefinitionFields = Pick<
  ParserFormState,
  | 'kind'
  | 'source'
  | 'orderId'
  | 'total'
  | 'shipping'
  | 'discount'
  | 'startAfter'
  | 'stopAt'
  | 'itemPatterns'
  | 'fees'
  | 'defaultCategory'
  | 'shippingCategory'
  | 'feesCategory'
  | 'reference'
  | 'matchBy'
  | 'matchReferenceIn'
  | 'matchDaysBefore'
  | 'matchDaysAfter'
  | 'matchTolerance'
  | 'tagEnabled'
  | 'tagName'
  | 'aiCategories'
  | 'discard'
  | (typeof GUARD_FIELDS)[number]
  | TradePatternFormField
  | 'tradeAccountRules'
  | 'tradeDefaultAccountId'
  | 'tradeCurrencyMarkers'
>;

const choiceList = <T extends string>(value: unknown, allowed: readonly T[], fallback: readonly T[]): T[] => {
  if (!Array.isArray(value)) return [...fallback];
  const picked = value.filter((entry): entry is T => allowed.includes(entry as T));
  return picked.length > 0 ? [...new Set(picked)] : [...fallback];
};

const wholeDays = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

/**
 * The form fields a definition fills. The definition comes off the wire as a
 * bare record (a draft restored from a backup can be `{}`), so each part is
 * read defensively and a missing part is an empty field, never a crash. What
 * the form has no field for is not read: `formCanRepresent` says when that
 * would lose something.
 */
export function definitionToFormFields(value: unknown): DefinitionFields {
  const definition = isRecord(value) ? value : {};
  const items = isRecord(definition.items) ? definition.items : {};
  const match = isRecord(definition.match) ? definition.match : {};
  const reference = stringList(definition.reference);
  const trade = isRecord(definition.trade) ? definition.trade : {};
  return {
    kind: definition.trade !== undefined ? 'trade' : 'receipt',
    source: definition.source === 'html' ? 'html' : 'text',
    orderId: stringList(definition.orderId).join('\n'),
    total: stringList(definition.total).join('\n'),
    shipping: stringList(definition.shipping).join('\n'),
    discount: stringList(definition.discount).join('\n'),
    startAfter: text(items.startAfter),
    stopAt: text(items.stopAt),
    itemPatterns: stringList(items.patterns).join('\n'),
    fees: stringList(definition.fees).join('\n'),
    defaultCategory: text(definition.defaultCategory),
    shippingCategory: text(definition.shippingCategory),
    feesCategory: text(definition.feesCategory),
    reference: reference.join('\n'),
    matchBy: choiceList(match.by, RECEIPT_MATCH_STRATEGIES, defaultMatchBy(reference.length > 0)),
    matchReferenceIn: choiceList(match.referenceIn, RECEIPT_MATCH_TEXT_FIELDS, RECEIPT_MATCH_TEXT_FIELDS),
    matchDaysBefore: wholeDays(match.daysBefore),
    matchDaysAfter: wholeDays(match.daysAfter),
    matchTolerance: typeof match.amountTolerance === 'string' ? toleranceFromString(match.amountTolerance) : null,
    tagEnabled: text(definition.tag).trim() !== '',
    tagName: text(definition.tag).trim(),
    aiCategories: definition.aiCategories === true,
    discard: RECEIPT_DISCARD_MODES.includes(definition.discard as ReceiptDiscardMode)
      ? (definition.discard as ReceiptDiscardMode)
      : '',
    requireLine: stringList(definition.requireLine).join('\n'),
    skipIfLine: stringList(definition.skipIfLine).join('\n'),
    waitIfLine: stringList(definition.waitIfLine).join('\n'),
    ...tradePatternFields(trade),
    tradeAccountRules: records(trade.accountRules).map((rule) => ({
      id: newClientId(),
      match: text(rule.match),
      currency: text(rule.currency),
      accountId: text(rule.accountId),
    })),
    tradeDefaultAccountId: text(trade.defaultAccountId),
    tradeCurrencyMarkers: records(trade.currencyMarkers).map((marker) => ({
      id: newClientId(),
      match: text(marker.match),
      currency: text(marker.currency),
    })),
  };
}

const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);

const tradePatternFields = (trade: Record<string, unknown>): Record<TradePatternFormField, string> =>
  Object.fromEntries(
    TRADE_PATTERN_FIELDS.map(([key, field]) => [field, stringList(trade[key]).join('\n')]),
  ) as Record<TradePatternFormField, string>;

/** A stored parser as form state. */
export function parserToForm(parser: EmailReceiptParser): ParserFormState {
  return {
    name: parser.name,
    payeeId: parser.payeeId ?? '',
    fromDomains: parser.fromDomains.join('\n'),
    subjectContains: parser.subjectContains.join('\n'),
    ...definitionToFormFields(parser.definition),
  };
}

const FORM_TOP_LEVEL_KEYS = [
  'version',
  'source',
  'orderId',
  'total',
  'shipping',
  'discount',
  'items',
  'fees',
  'defaultCategory',
  'shippingCategory',
  'feesCategory',
  'reference',
  'match',
  'tag',
  'aiCategories',
  'discard',
];
const FORM_ITEMS_KEYS = ['startAfter', 'stopAt', 'patterns'];
const FORM_TRADE_TOP_LEVEL_KEYS = ['version', 'source', 'trade', 'discard', ...GUARD_FIELDS];

/** The discard mode the form's select can show: one of the two, or none. */
const discardFits = (value: unknown): boolean =>
  value === undefined || RECEIPT_DISCARD_MODES.includes(value as ReceiptDiscardMode);
const FORM_TRADE_KEYS = [...TRADE_PATTERN_FIELDS.map(([key]) => key), 'accountRules', 'defaultAccountId', 'currencyMarkers'];
const FORM_TRADE_RULE_KEYS = ['match', 'accountId', 'currency'];
const FORM_TRADE_MARKER_KEYS = ['match', 'currency'];
const FORM_MATCH_KEYS = ['by', 'referenceIn', 'daysBefore', 'daysAfter', 'amountTolerance'];

/** A list of distinct values from a closed set, as the form's checkboxes hold them. */
const distinctFrom = (value: unknown, allowed: readonly string[]): boolean =>
  value === undefined ||
  (Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every((entry) => typeof entry === 'string' && allowed.includes(entry)));

/** Whole days within the server's bound, or absent. */
const daysWithin = (value: unknown, max: number): boolean =>
  value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max);

/** Can the form hold this `match` section? Its keys, lists and numbers all fit its controls. */
function formCanRepresentMatch(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !onlyKeys(value, FORM_MATCH_KEYS)) return false;
  if (!distinctFrom(value.by, RECEIPT_MATCH_STRATEGIES) || !distinctFrom(value.referenceIn, RECEIPT_MATCH_TEXT_FIELDS)) {
    return false;
  }
  if (!daysWithin(value.daysBefore, RECEIPT_PARSER_LIMITS.maxDaysBefore)) return false;
  if (!daysWithin(value.daysAfter, RECEIPT_PARSER_LIMITS.maxDaysAfter)) return false;
  if (value.amountTolerance !== undefined) {
    if (typeof value.amountTolerance !== 'string') return false;
    const tolerance = toleranceFromString(value.amountTolerance);
    if (tolerance === null || tolerance > RECEIPT_PARSER_LIMITS.maxAmountTolerance) return false;
  }
  return true;
}

const onlyStrings = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));

const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

/**
 * Can the form show this definition without losing any of it? Only a
 * definition of plain line patterns, one item per line, with nothing the form
 * has no field for: a labelled entry, a multi-line `record`, `skipLines`, an
 * unknown key or a value of the wrong kind would be dropped by the next
 * `buildParserDefinition`, so such a definition is edited as JSON. The version
 * does not matter: an old definition the form can show is shown, and saving it
 * writes the current version.
 */
export function formCanRepresent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.trade !== undefined) return formCanRepresentTrade(value);
  if (!onlyKeys(value, FORM_TOP_LEVEL_KEYS)) return false;
  if (!discardFits(value.discard)) return false;
  if (value.source !== undefined && !RECEIPT_LINES_SOURCES.includes(value.source as ReceiptLinesSource)) return false;
  for (const field of ['orderId', 'total', 'shipping', 'discount', 'fees', 'reference']) {
    if (!onlyStrings(value[field])) return false;
  }
  if (!formCanRepresentMatch(value.match)) return false;
  if (value.tag !== undefined && typeof value.tag !== 'string') return false;
  if (value.aiCategories !== undefined && typeof value.aiCategories !== 'boolean') return false;
  if (value.items !== undefined) {
    if (!isRecord(value.items) || !onlyKeys(value.items, FORM_ITEMS_KEYS)) return false;
    if (!onlyStrings(value.items.patterns)) return false;
    for (const marker of [value.items.startAfter, value.items.stopAt]) {
      if (marker !== undefined && typeof marker !== 'string') return false;
    }
  }
  // `categoryRules` and `balanceTolerance` have no field: such a definition is edited as JSON.
  for (const name of [value.defaultCategory, value.shippingCategory, value.feesCategory]) {
    if (name !== undefined && typeof name !== 'string') return false;
  }
  return true;
}

/** A list of objects with only these keys, each a string, as the rows of the form hold them. */
const rowsOf = (value: unknown, keys: readonly string[], required: readonly string[]): boolean =>
  value === undefined ||
  (Array.isArray(value) &&
    value.every(
      (row) =>
        isRecord(row) &&
        onlyKeys(row, keys) &&
        required.every((key) => typeof row[key] === 'string') &&
        // An optional key the form writes only when filled: an empty one would be dropped.
        keys.every((key) => required.includes(key) || row[key] === undefined || (typeof row[key] === 'string' && row[key] !== '')),
    ));

/**
 * Can the form show this trade profile without losing any of it? The same
 * rule as a receipt profile: plain line patterns only (a labelled entry is
 * edited as JSON), no key the form has no field for, and no receipt key beside
 * the `trade` section (the server refuses that mix, so the JSON shows it as it is).
 */
function formCanRepresentTrade(value: Record<string, unknown>): boolean {
  if (!onlyKeys(value, FORM_TRADE_TOP_LEVEL_KEYS)) return false;
  if (!discardFits(value.discard)) return false;
  if (value.source !== undefined && !RECEIPT_LINES_SOURCES.includes(value.source as ReceiptLinesSource)) return false;
  if (!GUARD_FIELDS.every((field) => onlyStrings(value[field]))) return false;
  const trade = value.trade;
  if (!isRecord(trade) || !onlyKeys(trade, FORM_TRADE_KEYS)) return false;
  if (!TRADE_PATTERN_FIELDS.every(([key]) => onlyStrings(trade[key]))) return false;
  if (!rowsOf(trade.accountRules, FORM_TRADE_RULE_KEYS, ['match', 'accountId'])) return false;
  if (!rowsOf(trade.currencyMarkers, FORM_TRADE_MARKER_KEYS, ['match', 'currency'])) return false;
  // A row the form would drop as blank is something the form cannot hold.
  if (records(trade.accountRules).some((rule) => rule.match === '' && rule.accountId === '' && rule.currency === undefined)) {
    return false;
  }
  if (records(trade.currencyMarkers).some((marker) => marker.match === '' && marker.currency === '')) return false;
  return (
    trade.defaultAccountId === undefined || (typeof trade.defaultAccountId === 'string' && trade.defaultAccountId !== '')
  );
}

/** The definition as the JSON editor shows it: indented, so a person can read and edit it. */
export function formatDefinitionJson(definition: unknown): string {
  return JSON.stringify(definition ?? {}, null, 2);
}

export type DefinitionJsonResult = { ok: true; definition: Record<string, unknown> } | { ok: false };

/**
 * The text of the JSON editor as a definition. Only the shape is checked here
 * (a JSON object); what the object may hold is the server's validator's call,
 * reported with the same codes as the form's.
 */
export function parseDefinitionJson(source: string): DefinitionJsonResult {
  try {
    const parsed: unknown = JSON.parse(source);
    return isRecord(parsed) ? { ok: true, definition: parsed } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Every code the server's validator reports (`ReceiptParserValidationError.code`). */
export const PARSER_VALIDATION_CODES = [
  'not_object',
  'unknown_key',
  'unsupported_version',
  'invalid_type',
  'empty',
  'too_many',
  'too_long',
  'control_character',
  'malformed_capture',
  'too_many_captures',
  'duplicate_capture',
  'capture_not_allowed',
  'capture_missing',
  'capture_conflict',
  'invalid_uuid',
  'out_of_range',
  'items_patterns_and_record',
  'items_shape_missing',
  'skip_lines_need_record',
  'record_name_missing',
  'items_single_conflict',
  'join_wrapped_needs_patterns',
  'invalid_value',
  'duplicate_entry',
  'reference_field_missing',
  'trade_conflict',
  'trade_amount_missing',
  'trade_account_missing',
  'invalid_currency',
  'too_many_lines',
  'line_break_not_allowed',
  'role_invalid',
  'link_key_requires_component',
  'link_key_missing',
  'link_capture_requires_settlement',
  'link_requires_settlement',
  'link_domain_invalid',
  'link_days_invalid',
  'role_trade_conflict',
] as const;

const PROBLEM = new RegExp(
  `(\\(definition\\)|[A-Za-z][A-Za-z.]*(?:\\[\\d+\\])?(?:\\.[A-Za-z]+(?:\\[\\d+\\])?)*): (${PARSER_VALIDATION_CODES.join('|')})\\b`,
  'g',
);

/**
 * The `path: code` problems in a 400's message ("The parser definition is not
 * valid: total[0]: capture_missing; ..."). The 400 carries them only inside its
 * text, in the server's language, so the codes are matched against the known
 * list rather than by splitting on the prose around them. Empty when the
 * message lists none (a payee or category refusal, say): the caller then shows
 * the message as it is.
 */
export function parseValidationProblems(message: string): ReceiptParserValidationError[] {
  return [...message.matchAll(PROBLEM)].map((match) => ({
    path: match[1] === '(definition)' ? '' : match[1],
    code: match[2],
  }));
}
