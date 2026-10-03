/**
 * The rule as the editor holds it while it is being edited (`RuleDraft`), and
 * the conversions to and from the API shape.
 *
 * Reading a stored rule is deliberately forgiving: an invalid rule is kept by
 * the server and skipped at run time, and its JSON may be anything (a restore
 * leaves `{}` and `[]`). The editor has to open it to repair it, so a part
 * that cannot be read is dropped or reset, counted in `repaired`, and the
 * editor says so. Writing is the opposite: `draftToPayload` emits exactly what
 * the create and update DTOs accept, and the server validates it again.
 */
import {
  createAction,
  createSplitPart,
  isDescriptionMode,
  isEditorActionType,
  type EditorAction,
  type EditorSplitPart,
  type TransferDirection,
} from '@/lib/rule-actions';
import {
  RULE_CONDITION_FIELDS,
  RULE_OPERATOR_SHAPES,
  RULE_TRIGGERS,
  isRuleField,
  isRuleOperator,
} from '@/lib/rule-fields';
import {
  createGroup,
  defaultValue,
  newUid,
  type EditorGroup,
  type EditorLeaf,
  type EditorNode,
  type EditorValue,
} from '@/lib/rule-tree';
import type {
  CreateTransactionRuleData,
  RuleAction,
  RuleConditionNode,
  RuleLeafValue,
  RuleTrigger,
  SplitActionPart,
  TransactionRule,
} from '@/types/transaction-rule';

export interface RuleDraft {
  readonly name: string;
  readonly enabled: boolean;
  readonly triggers: readonly RuleTrigger[];
  readonly stopProcessing: boolean;
  /** The active window, `YYYY-MM-DD` or empty (open on that side). */
  readonly activeFrom: string;
  readonly activeTo: string;
  readonly condition: EditorGroup;
  readonly actions: readonly EditorAction[];
}

/** A new rule: on, for both triggers, applying to every transaction, no actions yet. */
export function emptyDraft(): RuleDraft {
  return {
    name: '',
    enabled: true,
    triggers: [...RULE_TRIGGERS],
    stopProcessing: false,
    activeFrom: '',
    activeTo: '',
    condition: createGroup('all'),
    actions: [],
  };
}

// ---- API to editor -------------------------------------------------------

type Record_ = Record<string, unknown>;

const isRecord = (v: unknown): v is Record_ => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isNumberList = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === 'number');

/** Counts the parts of a stored definition the editor had to drop or reset. */
class Repairs {
  count = 0;
  note(): void {
    this.count += 1;
  }
}

function readValue(field: EditorLeaf['field'], op: EditorLeaf['op'], raw: unknown, repairs: Repairs): EditorValue {
  const kind = RULE_CONDITION_FIELDS[field].kind;
  const shape = RULE_OPERATOR_SHAPES[op];
  if (shape === 'none') {
    if (raw !== undefined) repairs.note();
    return undefined;
  }
  const scalarOk = (v: unknown): boolean =>
    kind === 'money' || kind === 'dayOfMonth'
      ? typeof v === 'number'
      : kind === 'boolean'
        ? typeof v === 'boolean'
        : typeof v === 'string';
  let ok: boolean;
  if (shape === 'scalar') ok = scalarOk(raw);
  else if (shape === 'list') ok = kind === 'dayOfMonth' ? isNumberList(raw) : isStringList(raw);
  else {
    const endType = kind === 'date' ? 'string' : 'number';
    ok = Array.isArray(raw) && raw.length === 2 && raw.every((v) => typeof v === endType);
  }
  if (ok) return raw as EditorValue;
  repairs.note();
  return defaultValue(field, op);
}

function readNode(input: unknown, repairs: Repairs): EditorNode | null {
  if (!isRecord(input)) {
    repairs.note();
    return null;
  }
  const hasAll = 'all' in input;
  const hasAny = 'any' in input;
  if (hasAll !== hasAny) {
    const match = hasAll ? 'all' : 'any';
    const rawChildren = input[match];
    if (!Array.isArray(rawChildren)) {
      repairs.note();
      return createGroup(match);
    }
    const children = rawChildren
      .map((child) => readNode(child, repairs))
      .filter((child): child is EditorNode => child !== null);
    return { ...createGroup(match, children), not: input.not === true };
  }
  const { field, op } = input;
  if (!isRuleField(field)) {
    repairs.note();
    return null;
  }
  const allowed = RULE_CONDITION_FIELDS[field].operators;
  if (!isRuleOperator(op) || !allowed.includes(op)) {
    repairs.note();
    const first = allowed[0];
    return { kind: 'leaf', uid: newUid(), field, op: first, value: defaultValue(field, first) };
  }
  return { kind: 'leaf', uid: newUid(), field, op, value: readValue(field, op, input.value, repairs) };
}

/** A stored condition as an editable root group; a bare leaf is wrapped in one. */
function readCondition(input: unknown, repairs: Repairs): EditorGroup {
  const node = readNode(input, repairs);
  if (node === null) return createGroup('all');
  return node.kind === 'group' ? node : createGroup('all', [node]);
}

function readAction(input: unknown, repairs: Repairs): EditorAction | null {
  if (!isRecord(input) || !isEditorActionType(input.type)) {
    repairs.note();
    return null;
  }
  const blank = createAction(input.type);
  switch (blank.type) {
    case 'add_tags':
    case 'remove_tags':
      if (!isStringList(input.tagIds)) repairs.note();
      return { ...blank, tagIds: isStringList(input.tagIds) ? input.tagIds : [] };
    case 'set_category':
    case 'set_payee': {
      const key = blank.type === 'set_category' ? 'categoryId' : 'payeeId';
      if (typeof input[key] !== 'string') repairs.note();
      // A missing flag reads as the default the server applies: fill, do not overwrite.
      return {
        ...blank,
        [key]: typeof input[key] === 'string' ? input[key] : '',
        onlyIfEmpty: typeof input.onlyIfEmpty === 'boolean' ? input.onlyIfEmpty : true,
      } as EditorAction;
    }
    case 'set_payee_from_text': {
      // The template is kept exactly as stored (no trim), so opening and saving loses nothing.
      if (typeof input.template !== 'string') repairs.note();
      return {
        ...blank,
        template: typeof input.template === 'string' ? input.template : '',
        createIfMissing: typeof input.createIfMissing === 'boolean' ? input.createIfMissing : blank.createIfMissing,
        onlyIfEmpty: typeof input.onlyIfEmpty === 'boolean' ? input.onlyIfEmpty : blank.onlyIfEmpty,
      };
    }
    case 'set_description': {
      if (typeof input.template !== 'string') repairs.note();
      // A missing mode or flag reads as the server's default; a mode it does not know is repaired.
      if (input.mode !== undefined && !isDescriptionMode(input.mode)) repairs.note();
      return {
        ...blank,
        template: typeof input.template === 'string' ? input.template : '',
        mode: isDescriptionMode(input.mode) ? input.mode : blank.mode,
        onlyIfEmpty: typeof input.onlyIfEmpty === 'boolean' ? input.onlyIfEmpty : blank.onlyIfEmpty,
      };
    }
    case 'request_ai_review':
      if (typeof input.instruction !== 'string') repairs.note();
      return { ...blank, instruction: typeof input.instruction === 'string' ? input.instruction : '' };
    case 'convert_to_transfer':
      return readConvert(blank, input, repairs);
    case 'split':
      return readSplit(blank, input, repairs);
  }
}

/** An optional id: absent reads as none, a non-string is repaired. */
function readOptionalId(value: unknown, repairs: Repairs): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  repairs.note();
  return '';
}

function readConvert(
  blank: Extract<EditorAction, { type: 'convert_to_transfer' }>,
  input: Record_,
  repairs: Repairs,
): EditorAction {
  const hasTo = input.toAccountId !== undefined;
  const hasFrom = input.fromAccountId !== undefined;
  // Exactly one is stored; both (or neither) is repaired to the "to" side.
  if (hasTo === hasFrom) repairs.note();
  // Only the income side names `fromAccountId`; anything else reads as the expense side.
  let direction: TransferDirection = 'to';
  if (hasFrom && !hasTo) direction = 'from';
  const accountId = readOptionalId(direction === 'from' ? input.fromAccountId : input.toAccountId, repairs);
  if (input.clearCategory !== undefined && typeof input.clearCategory !== 'boolean') repairs.note();
  return {
    ...blank,
    direction,
    accountId,
    // A missing flag reads as the server's default: a transfer has no category.
    clearCategory: typeof input.clearCategory === 'boolean' ? input.clearCategory : blank.clearCategory,
    payeeId: readOptionalId(input.payeeId, repairs),
  };
}

function readSplitPart(input: unknown, repairs: Repairs): EditorSplitPart {
  if (!isRecord(input)) {
    repairs.note();
    return createSplitPart();
  }
  const blank = createSplitPart();
  const categoryId = readOptionalId(input.categoryId, repairs);
  const transferAccountId = readOptionalId(input.transferAccountId, repairs);
  // A category and a transfer account together is refused by the server; the transfer wins here.
  if (categoryId !== '' && transferAccountId !== '') repairs.note();
  const kind = transferAccountId !== '' ? 'transfer' : 'category';
  const payeeId = readOptionalId(input.payeeId, repairs);
  // A payee belongs to the counterpart leg of a transfer part, so it means nothing on a category line.
  if (payeeId !== '' && kind !== 'transfer') repairs.note();
  if (input.description !== undefined && typeof input.description !== 'string') repairs.note();
  if (typeof input.amount !== 'string') repairs.note();
  return {
    ...blank,
    amount: typeof input.amount === 'string' ? input.amount : '',
    kind,
    categoryId: kind === 'category' ? categoryId : '',
    transferAccountId,
    payeeId: kind === 'transfer' ? payeeId : '',
    description: typeof input.description === 'string' ? input.description : '',
  };
}

function readSplit(
  blank: Extract<EditorAction, { type: 'split' }>,
  input: Record_,
  repairs: Repairs,
): EditorAction {
  let parts: EditorSplitPart[] = [];
  if (Array.isArray(input.parts)) parts = input.parts.map((part) => readSplitPart(part, repairs));
  else repairs.note();
  // A split has at least two parts; a definition with fewer is padded so the editor can open it.
  if (parts.length === 0) parts = blank.parts.map((part) => ({ ...part }));
  return { ...blank, payeeId: readOptionalId(input.payeeId, repairs), parts };
}

function partToApi(part: EditorSplitPart): SplitActionPart {
  return {
    amount: part.amount,
    ...(part.kind === 'category' && part.categoryId !== '' ? { categoryId: part.categoryId } : {}),
    ...(part.kind === 'transfer' && part.transferAccountId !== '' ? { transferAccountId: part.transferAccountId } : {}),
    ...(part.kind === 'transfer' && part.transferAccountId !== '' && part.payeeId !== '' ? { payeeId: part.payeeId } : {}),
    // Kept as typed; a whitespace-only text is the server's to refuse (VALUE_EMPTY).
    ...(part.description !== '' ? { description: part.description } : {}),
  };
}

export interface DraftFromRule {
  readonly draft: RuleDraft;
  /** Parts of the stored definition that could not be read and were dropped or reset. */
  readonly repaired: number;
}

export function draftFromRule(rule: TransactionRule): DraftFromRule {
  const repairs = new Repairs();
  const condition = readCondition(rule.condition, repairs);
  let actions: EditorAction[] = [];
  if (Array.isArray(rule.actions)) {
    actions = rule.actions
      .map((a) => readAction(a, repairs))
      .filter((a): a is EditorAction => a !== null);
  } else {
    repairs.note();
  }
  const triggers = RULE_TRIGGERS.filter((t) => Array.isArray(rule.triggers) && rule.triggers.includes(t));
  return {
    draft: {
      name: typeof rule.name === 'string' ? rule.name : '',
      enabled: rule.enabled === true,
      triggers,
      stopProcessing: rule.stopProcessing === true,
      activeFrom: typeof rule.activeFrom === 'string' ? rule.activeFrom : '',
      activeTo: typeof rule.activeTo === 'string' ? rule.activeTo : '',
      condition,
      actions,
    },
    repaired: repairs.count,
  };
}

// ---- editor to API -------------------------------------------------------

function leafToApi(leaf: EditorLeaf): RuleConditionNode {
  if (RULE_OPERATOR_SHAPES[leaf.op] === 'none') return { field: leaf.field, op: leaf.op };
  return { field: leaf.field, op: leaf.op, value: leaf.value as RuleLeafValue };
}

export function conditionToApi(node: EditorNode): RuleConditionNode {
  if (node.kind === 'leaf') return leafToApi(node);
  const children = node.children.map(conditionToApi);
  const not = node.not ? { not: true } : {};
  return node.match === 'all' ? { all: children, ...not } : { any: children, ...not };
}

export function actionToApi(action: EditorAction): RuleAction {
  switch (action.type) {
    case 'add_tags':
    case 'remove_tags':
      return { type: action.type, tagIds: action.tagIds };
    case 'set_category':
      return { type: 'set_category', categoryId: action.categoryId, onlyIfEmpty: action.onlyIfEmpty };
    case 'set_payee':
      return { type: 'set_payee', payeeId: action.payeeId, onlyIfEmpty: action.onlyIfEmpty };
    case 'set_payee_from_text':
      return {
        type: 'set_payee_from_text',
        template: action.template,
        createIfMissing: action.createIfMissing,
        onlyIfEmpty: action.onlyIfEmpty,
      };
    case 'set_description':
      return {
        type: 'set_description',
        template: action.template,
        mode: action.mode,
        onlyIfEmpty: action.onlyIfEmpty,
      };
    case 'request_ai_review':
      return { type: 'request_ai_review', instruction: action.instruction };
    case 'convert_to_transfer':
      return {
        type: 'convert_to_transfer',
        // An account not chosen yet is left out, so the server names the missing field.
        ...(action.accountId === ''
          ? {}
          : action.direction === 'from'
            ? { fromAccountId: action.accountId }
            : { toAccountId: action.accountId }),
        clearCategory: action.clearCategory,
        ...(action.payeeId !== '' ? { payeeId: action.payeeId } : {}),
      };
    case 'split':
      return {
        type: 'split',
        ...(action.payeeId !== '' ? { payeeId: action.payeeId } : {}),
        parts: action.parts.map(partToApi),
      };
  }
}

/**
 * One side of the active window as the API takes it. An open side that was
 * never set is left out, so a backend that predates the window (and refuses an
 * unknown key) still accepts the save; a side the loaded rule had and the
 * draft cleared is sent as null, which clears it.
 */
function windowSide(value: string, loadedValue: string): string | null | undefined {
  if (value !== '') return value;
  return loadedValue !== '' ? null : undefined;
}

/**
 * Exactly what the create DTO accepts; an update adds `revision` to it. Pass
 * the draft the rule was opened with (`loaded`) when updating, so a cleared
 * window side is sent as null.
 */
export function draftToPayload(draft: RuleDraft, loaded: RuleDraft | null = null): CreateTransactionRuleData {
  const activeFrom = windowSide(draft.activeFrom, loaded?.activeFrom ?? '');
  const activeTo = windowSide(draft.activeTo, loaded?.activeTo ?? '');
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    triggers: RULE_TRIGGERS.filter((t) => draft.triggers.includes(t)),
    condition: conditionToApi(draft.condition),
    actions: draft.actions.map(actionToApi),
    stopProcessing: draft.stopProcessing,
    ...(activeFrom !== undefined ? { activeFrom } : {}),
    ...(activeTo !== undefined ? { activeTo } : {}),
  };
}

/** Two drafts with the same signature would save the same rule. */
export function draftSignature(draft: RuleDraft): string {
  return JSON.stringify(draftToPayload(draft));
}
