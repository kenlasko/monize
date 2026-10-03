import type {
  CreateEmailReceiptParserPayload,
  EmailReceiptParser,
  ReceiptCategoryRule,
  ReceiptParserDefinition,
  ReceiptParserValidationError,
} from '@/types/email-receipts';

/**
 * The parser editor's form state and its conversion to and from the stored
 * definition (design section 5.1). Pure, so the JSON the editor sends is
 * tested without rendering it. Patterns are one per line in a textarea; the
 * server's validator is the authority on what a pattern may hold, so nothing
 * here rejects a pattern, it only builds the structure.
 */

export interface CategoryRuleRow {
  /** A list key, never sent. */
  uid: string;
  match: string;
  categoryId: string;
}

export interface ParserFormState {
  name: string;
  payeeId: string;
  /** Comma, semicolon, space or line separated. */
  fromDomains: string;
  /** Comma or line separated (a word may hold spaces). */
  subjectContains: string;
  /** One pattern per line, for each of the four fields below. */
  orderId: string;
  total: string;
  shipping: string;
  discount: string;
  startAfter: string;
  stopAt: string;
  itemPatterns: string;
  categoryRules: CategoryRuleRow[];
  defaultCategoryId: string;
  shippingCategoryId: string;
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
  name: '',
  payeeId: '',
  fromDomains: '',
  subjectContains: '',
  orderId: '',
  total: '',
  shipping: '',
  discount: '',
  startAfter: '',
  stopAt: '',
  itemPatterns: '',
  categoryRules: [],
  defaultCategoryId: '',
  shippingCategoryId: '',
  ...overrides,
});

const newRow = (match: string, categoryId: string): CategoryRuleRow => ({
  uid: crypto.randomUUID(),
  match,
  categoryId,
});

export const blankCategoryRule = (): CategoryRuleRow => newRow('', '');

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
  const definition: ReceiptParserDefinition = { version: 1 };

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

  const rules: ReceiptCategoryRule[] = form.categoryRules
    .filter((row) => row.match.trim() !== '' || row.categoryId !== '')
    .map((row) => ({ match: row.match.trim(), categoryId: row.categoryId }));
  if (rules.length > 0) definition.categoryRules = rules;

  if (form.defaultCategoryId !== '') definition.defaultCategoryId = form.defaultCategoryId;
  if (form.shippingCategoryId !== '') definition.shippingCategoryId = form.shippingCategoryId;
  return definition;
}

/** The create payload; update sends the same fields plus the revision it was read at. */
export function buildParserPayload(form: ParserFormState): CreateEmailReceiptParserPayload {
  return {
    name: form.name.trim(),
    payeeId: form.payeeId === '' ? null : form.payeeId,
    fromDomains: splitDomains(form.fromDomains),
    subjectContains: splitWords(form.subjectContains),
    definition: buildParserDefinition(form),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * A stored parser as form state. The definition comes off the wire as a bare
 * record (a draft restored from a backup can be `{}`), so each part is read
 * defensively and a missing part is an empty field, never a crash.
 */
export function parserToForm(parser: EmailReceiptParser): ParserFormState {
  const definition = isRecord(parser.definition) ? parser.definition : {};
  const items = isRecord(definition.items) ? definition.items : {};
  const rules = Array.isArray(definition.categoryRules) ? definition.categoryRules : [];
  return {
    name: parser.name,
    payeeId: parser.payeeId ?? '',
    fromDomains: parser.fromDomains.join('\n'),
    subjectContains: parser.subjectContains.join('\n'),
    orderId: stringList(definition.orderId).join('\n'),
    total: stringList(definition.total).join('\n'),
    shipping: stringList(definition.shipping).join('\n'),
    discount: stringList(definition.discount).join('\n'),
    startAfter: text(items.startAfter),
    stopAt: text(items.stopAt),
    itemPatterns: stringList(items.patterns).join('\n'),
    categoryRules: rules
      .filter(isRecord)
      .map((rule) => newRow(text(rule.match), text(rule.categoryId))),
    defaultCategoryId: text(definition.defaultCategoryId),
    shippingCategoryId: text(definition.shippingCategoryId),
  };
}

/** Every code the server's validator reports (`ReceiptParserValidationError.code`). */
export const PARSER_VALIDATION_CODES = [
  'not_object',
  'unknown_key',
  'invalid_version',
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
