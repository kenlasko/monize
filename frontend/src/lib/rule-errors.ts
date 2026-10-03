/**
 * Errors of the rule editor: reading the API's 400 and 409 answers, checking a
 * draft for the parts the reader has not filled in yet, and placing each
 * `{ path, code }` entry on the card at that path.
 *
 * The server's paths look like `condition.all[0].any[1].value` and
 * `actions[2].tagIds`. A card owns everything under its own node, so the tail
 * after the node is dropped and the entry lands on the card.
 */
import { AxiosError } from 'axios';
import { draftToPayload, type RuleDraft } from '@/lib/rule-draft';
import {
  MAX_RULE_DESCRIPTION_TEMPLATE_LENGTH,
  MAX_RULE_PAYEE_TEMPLATE_LENGTH,
  MAX_RULE_SPLIT_DESCRIPTION_LENGTH,
  MAX_RULE_TAG_IDS,
  MAX_RULE_VALUE_LIST,
  RULE_CONDITION_FIELDS,
  RULE_OPERATOR_SHAPES,
  RULE_VALIDATION_CODES,
  type RuleErrorCode,
} from '@/lib/rule-fields';
import {
  SPLIT_REST,
  actionKey,
  captureOfAmount,
  isStructuralActionType,
  type EditorAction,
} from '@/lib/rule-actions';
import { checkTemplate, scanCaptures } from '@/lib/rule-captures';
import { conditionKey, type EditorGroup, type EditorNode } from '@/lib/rule-tree';

export interface RuleErrorEntry {
  path: string;
  code: string;
}

/** Codes the editor can name in the catalog; anything else reads as unknown. */
export type KnownRuleErrorCode = RuleErrorCode | 'NAME_REQUIRED';

export const KNOWN_RULE_ERROR_CODES: readonly string[] = [
  ...RULE_VALIDATION_CODES,
  'REFERENCE_NOT_FOUND',
  'NAME_REQUIRED',
];

export const isKnownRuleErrorCode = (code: string): code is KnownRuleErrorCode =>
  KNOWN_RULE_ERROR_CODES.includes(code);

// ---- the API's answers ---------------------------------------------------

export interface RuleApiError {
  status: number | undefined;
  errorCode: string | undefined;
  message: string | undefined;
  entries: RuleErrorEntry[];
}

const isEntry = (v: unknown): v is RuleErrorEntry =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as RuleErrorEntry).path === 'string' &&
  typeof (v as RuleErrorEntry).code === 'string';

/** What a failed save said: the status, the machine code and the per-card entries. */
export function readRuleApiError(error: unknown): RuleApiError {
  const response = error instanceof AxiosError ? error.response : undefined;
  const data: unknown = response?.data;
  const body = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const message = body.message;
  return {
    status: response?.status,
    errorCode: typeof body.errorCode === 'string' ? body.errorCode : undefined,
    // A DTO refusal answers `message` as a list of sentences.
    message: typeof message === 'string' ? message : Array.isArray(message) ? message.join('. ') : undefined,
    entries: Array.isArray(body.errors) ? body.errors.filter(isEntry) : [],
  };
}

export const isRevisionConflict = (error: RuleApiError): boolean =>
  error.status === 409 && error.errorCode === 'REVISION_CONFLICT';

// ---- placing entries on cards --------------------------------------------

/** Error keys: `c:0.1` (a condition node), `a:2` (an action), `actions`, `name`. */
export const ACTIONS_LIST_KEY = 'actions';
export const NAME_KEY = 'name';

export interface PlacedErrors {
  /** Codes per card key, each once, in the order reported. */
  readonly byKey: Readonly<Record<string, readonly string[]>>;
  /**
   * Codes per full server path (`actions[0].parts[1].amount`), each once: the
   * structural actions show an error at the field it names
   * (`structuralFieldErrors`), where `byKey` only knows the card.
   */
  readonly byPath: Readonly<Record<string, readonly string[]>>;
  /** Entries whose path names no card; shown at the top. */
  readonly unplaced: readonly RuleErrorEntry[];
}

const CONDITION_PATH = /^condition((?:\.(?:all|any)\[\d+\])*)(?:[.[].*)?$/;
const ACTION_PATH = /^actions\[(\d+)\](?:[.[].*)?$/;

/** The key of the card a server path belongs to, or null when it names none. */
export function keyForPath(path: string): string | null {
  if (path === ACTIONS_LIST_KEY) return ACTIONS_LIST_KEY;
  if (path === NAME_KEY) return NAME_KEY;
  const condition = CONDITION_PATH.exec(path);
  if (condition) {
    const indices = [...condition[1].matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    return conditionKey(indices);
  }
  const action = ACTION_PATH.exec(path);
  return action ? actionKey(Number(action[1])) : null;
}

export function placeErrors(entries: readonly RuleErrorEntry[]): PlacedErrors {
  const byKey: Record<string, string[]> = {};
  const byPath: Record<string, string[]> = {};
  const unplaced: RuleErrorEntry[] = [];
  for (const entry of entries) {
    const atPath = byPath[entry.path] ?? [];
    if (!atPath.includes(entry.code)) atPath.push(entry.code);
    byPath[entry.path] = atPath;
    const key = keyForPath(entry.path);
    if (key === null) {
      unplaced.push(entry);
      continue;
    }
    const codes = byKey[key] ?? [];
    if (!codes.includes(entry.code)) codes.push(entry.code);
    byKey[key] = codes;
  }
  return { byKey, byPath, unplaced };
}

export const NO_ERRORS: PlacedErrors = { byKey: {}, byPath: {}, unplaced: [] };

/**
 * What a structural action card shows where: `shell` is for the card as a
 * whole (the codes at `actions[i]` itself and any path the card has no field
 * for), `fields` is keyed by the path under the action (`toAccountId`,
 * `parts`, `parts[1]`, `parts[1].amount`).
 */
export interface StructuralFieldErrors {
  readonly shell: readonly string[];
  readonly fields: Readonly<Record<string, readonly string[]>>;
}

const FIELD_PATH = /^(?:toAccountId|fromAccountId|payeeId|parts|parts\[\d+\](?:\.(?:amount|categoryId|transferAccountId|payeeId|description))?)$/;

/** The entries under `actions[index]`, split into the card's own list and its fields. */
export function structuralFieldErrors(placed: PlacedErrors, index: number): StructuralFieldErrors {
  const own = `actions[${index}]`;
  const shell: string[] = [];
  const fields: Record<string, string[]> = {};
  const addTo = (list: string[], codes: readonly string[]) => {
    for (const code of codes) if (!list.includes(code)) list.push(code);
  };
  for (const [path, codes] of Object.entries(placed.byPath)) {
    if (path === own) addTo(shell, codes);
    else if (path.startsWith(`${own}.`) || path.startsWith(`${own}[`)) {
      const rest = path.slice(own.length).replace(/^\./, '');
      if (FIELD_PATH.test(rest)) addTo((fields[rest] ??= []), codes);
      else addTo(shell, codes);
    }
  }
  return { shell, fields };
}

// ---- what the reader has not filled in yet -------------------------------

function conditionEntries(node: EditorNode, path: string, out: RuleErrorEntry[]): void {
  if (node.kind === 'group') {
    node.children.forEach((child, i) => conditionEntries(child, `${path}.${node.match}[${i}]`, out));
    return;
  }
  const shape = RULE_OPERATOR_SHAPES[node.op];
  if (shape === 'none') return;
  const value = node.value;
  if (shape === 'list') {
    if (!Array.isArray(value) || value.length === 0) out.push({ path, code: 'ARRAY_EMPTY' });
    else if (value.length > MAX_RULE_VALUE_LIST) out.push({ path, code: 'ARRAY_TOO_LARGE' });
  } else if (shape === 'range') {
    // A date range is a pair of `YYYY-MM-DD` texts (an unset end is ''); every other range is a pair of numbers.
    const isDate = RULE_CONDITION_FIELDS[node.field].kind === 'date';
    const complete =
      Array.isArray(value) &&
      value.length === 2 &&
      value.every((v) => (isDate ? typeof v === 'string' && v !== '' : typeof v === 'number'));
    if (!complete) out.push({ path, code: 'VALUE_REQUIRED' });
  } else if (value === undefined || value === '') {
    out.push({ path, code: 'VALUE_REQUIRED' });
  }
}

/** What is wrong with the text of a text action, as the codes the server answers with. */
function templateEntries(
  path: string,
  type: 'set_payee_from_text' | 'set_description',
  template: string,
  captures: readonly string[],
): RuleErrorEntry[] {
  if (template.trim() === '') return [{ path, code: 'VALUE_EMPTY' }];
  const max = type === 'set_payee_from_text' ? MAX_RULE_PAYEE_TEMPLATE_LENGTH : MAX_RULE_DESCRIPTION_TEMPLATE_LENGTH;
  if (template.length > max) return [{ path, code: 'VALUE_TOO_LONG' }];
  const { malformed, unknown } = checkTemplate(template, captures);
  return [
    ...(malformed.length > 0 ? [{ path, code: 'INVALID_CAPTURE' }] : []),
    ...(unknown.length > 0 ? [{ path, code: 'UNKNOWN_CAPTURE' }] : []),
  ];
}

/** The two advice codes of a `matches` pattern: authoring help, not a rule of the language. */
const AUTHORING_CODES: readonly string[] = ['LOOKS_LIKE_REGEX', 'PATTERN_WITHOUT_WILDCARD'];

/**
 * Whether the glob-trap advice applies, as the server decides it: to a new
 * rule, and to an existing one only when the condition differs from the one it
 * was loaded with (compared as saved, so ids of the editor's nodes do not count).
 */
function isAuthoring(draft: RuleDraft, loaded: RuleDraft | null | undefined): boolean {
  if (!loaded) return true;
  return JSON.stringify(draftToPayload(draft).condition) !== JSON.stringify(draftToPayload(loaded).condition);
}

/**
 * The gaps in a draft, as the entries the server would answer with, so they
 * land on the same cards. Only completeness is checked here; the server stays
 * the authority on everything else (bounds, ownership of each id).
 *
 * `loaded` is the draft an existing rule was opened with: a stored pattern
 * that predates the advice (`matches "NETFLIX.COM"`) does not stop its name,
 * triggers or actions from being saved while its condition is left alone.
 */
export function draftGaps(draft: RuleDraft, loaded?: RuleDraft | null): RuleErrorEntry[] {
  const out: RuleErrorEntry[] = [];
  if (draft.name.trim() === '') out.push({ path: NAME_KEY, code: 'NAME_REQUIRED' });
  const root: EditorGroup = draft.condition;
  conditionEntries(root, 'condition', out);
  const authoring = isAuthoring(draft, loaded);
  const scan = scanCaptures(root);
  for (const issue of scan.issues) {
    for (const code of issue.codes) {
      if (authoring || !AUTHORING_CODES.includes(code)) out.push({ path: issue.path, code });
    }
  }
  if (draft.actions.length === 0) out.push({ path: ACTIONS_LIST_KEY, code: 'NO_ACTIONS' });
  out.push(...structuralGaps(draft.actions, scan.names));
  draft.actions.forEach((action, i) => {
    const path = `actions[${i}]`;
    if ((action.type === 'add_tags' || action.type === 'remove_tags') && action.tagIds.length === 0) {
      out.push({ path, code: 'ARRAY_EMPTY' });
    } else if ((action.type === 'add_tags' || action.type === 'remove_tags') && action.tagIds.length > MAX_RULE_TAG_IDS) {
      out.push({ path, code: 'ARRAY_TOO_LARGE' });
    } else if (action.type === 'set_category' && action.categoryId === '') {
      out.push({ path, code: 'VALUE_REQUIRED' });
    } else if (action.type === 'set_payee' && action.payeeId === '') {
      out.push({ path, code: 'VALUE_REQUIRED' });
    } else if (action.type === 'request_ai_review' && action.instruction.trim() === '') {
      out.push({ path, code: 'VALUE_EMPTY' });
    } else if (action.type === 'set_payee_from_text' || action.type === 'set_description') {
      out.push(...templateEntries(path, action.type, action.template, scan.names));
    }
  });
  return out;
}

/**
 * The gaps of the two structural actions: an account or an amount not chosen
 * yet, a capture the patterns do not define, a second `rest`, and the two
 * combinations the server refuses (`DUPLICATE_ACTION`, `CONFLICTING_ACTIONS`).
 * Paths and codes are the server's (`rule-validation.ts`).
 */
function structuralGaps(actions: readonly EditorAction[], captures: readonly string[]): RuleErrorEntry[] {
  const out: RuleErrorEntry[] = [];
  const setsCategory = actions.some((a) => a.type === 'set_category');
  let seen = 0;
  actions.forEach((action, i) => {
    if (!isStructuralActionType(action.type)) return;
    const path = `actions[${i}]`;
    if (++seen > 1) out.push({ path, code: 'DUPLICATE_ACTION' });
    else if (setsCategory) out.push({ path, code: 'CONFLICTING_ACTIONS' });
    if (action.type === 'convert_to_transfer') {
      if (action.accountId === '') {
        out.push({ path: `${path}.${action.direction === 'from' ? 'fromAccountId' : 'toAccountId'}`, code: 'VALUE_REQUIRED' });
      }
      return;
    }
    if (action.type !== 'split') return;
    let rests = 0;
    action.parts.forEach((part, j) => {
      const at = `${path}.parts[${j}]`;
      const name = captureOfAmount(part.amount);
      if (part.amount === '') out.push({ path: `${at}.amount`, code: 'VALUE_REQUIRED' });
      else if (part.amount === SPLIT_REST) {
        if (++rests > 1) out.push({ path: `${at}.amount`, code: 'DUPLICATE_ACTION' });
      } else if (name === null) out.push({ path: `${at}.amount`, code: 'INVALID_SHAPE' });
      else if (!captures.includes(name)) out.push({ path: `${at}.amount`, code: 'UNKNOWN_CAPTURE' });
      if (part.kind === 'transfer' && part.transferAccountId === '') {
        out.push({ path: `${at}.transferAccountId`, code: 'VALUE_REQUIRED' });
      }
      const length = part.description.trim().length;
      if (part.description !== '' && length === 0) out.push({ path: `${at}.description`, code: 'VALUE_EMPTY' });
      else if (length > MAX_RULE_SPLIT_DESCRIPTION_LENGTH) out.push({ path: `${at}.description`, code: 'VALUE_TOO_LONG' });
    });
  });
  return out;
}
