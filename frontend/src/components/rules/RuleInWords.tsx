'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useRuleEnumLabels } from '@/components/rules/use-rule-enum-labels';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import {
  RULE_CONDITION_FIELDS,
  isEditorRuleField,
  isRuleActionType,
  isRuleField,
  isRuleOperator,
} from '@/lib/rule-fields';
import type {
  RuleAction,
  RuleConditionLeaf,
  RuleConditionNode,
  RuleLeafValue,
  RuleTrigger,
  SplitActionPart,
} from '@/types/transaction-rule';

/** Names for the ids a rule definition mentions; an id with no name is a deleted item. */
export interface RuleWordsLabels {
  accounts: Readonly<Record<string, string>>;
  payees: Readonly<Record<string, string>>;
  categories: Readonly<Record<string, string>>;
  tags: Readonly<Record<string, string>>;
}

const HEADING_CLASS = 'text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400';
const LIST_CLASS = 'list-disc space-y-0.5 pl-5 text-sm text-gray-900 dark:text-gray-100';

function isGroup(node: RuleConditionNode): node is Exclude<RuleConditionNode, RuleConditionLeaf> {
  return 'all' in node || 'any' in node;
}

/** The sentences a rule is read in, from the `rules` catalog and the reader's own formats. */
export function useRuleWords(labels: RuleWordsLabels) {
  const t = useTranslations('rules');
  const format = useFormatter();
  const { formatNumber } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const unknown = t('run.change.unknown');
  const enumLabels = useRuleEnumLabels();

  const list = (items: readonly string[]) => format.list(items, { type: 'conjunction' });
  const named = (names: Readonly<Record<string, string>>, id: unknown) =>
    typeof id === 'string' ? (names[id] ?? unknown) : unknown;

  const scalar = (leaf: RuleConditionLeaf, value: string | number | boolean): string => {
    const kind = RULE_CONDITION_FIELDS[leaf.field].kind;
    switch (kind) {
      case 'accountId':
        return named(labels.accounts, value);
      case 'payeeId':
        return named(labels.payees, value);
      case 'categoryId':
        return named(labels.categories, value);
      case 'tagIds':
        return named(labels.tags, value);
      case 'text':
        return t('words.text', { value: String(value) });
      case 'money':
        return typeof value === 'number' ? formatNumber(value) : unknown;
      case 'dayOfMonth':
        return String(value);
      case 'date':
        return typeof value === 'string' && value !== '' ? formatDate(value) : unknown;
      case 'boolean':
        return value === true ? t('editor.value.yes') : value === false ? t('editor.value.no') : unknown;
      case 'enum':
        return enumLabels.label(leaf.field, String(value));
      case 'currency':
        return String(value);
    }
  };

  const value = (leaf: RuleConditionLeaf, raw: RuleLeafValue): string => {
    if (!Array.isArray(raw)) return scalar(leaf, raw as string | number | boolean);
    const items = (raw as readonly (string | number)[]).map((item) => scalar(leaf, item));
    return leaf.op === 'between' && items.length === 2
      ? t('words.range', { from: items[0], to: items[1] })
      : list(items);
  };

  const leafText = (leaf: RuleConditionLeaf): string => {
    // A field or operator newer than this client still says that a condition exists.
    if (!isRuleField(leaf.field) || !isEditorRuleField(leaf.field) || !isRuleOperator(leaf.op)) {
      return t('words.unknownCondition');
    }
    const field = t(`editor.fields.${leaf.field}`);
    const operator = t(`editor.operators.${leaf.op}`);
    return leaf.value === undefined
      ? t('words.leafNoValue', { field, operator })
      : t('words.leaf', { field, operator, value: value(leaf, leaf.value) });
  };

  const groupText = (group: Exclude<RuleConditionNode, RuleConditionLeaf>): string => {
    const all = 'all' in group;
    if (group.not === true) return t(all ? 'words.group.notAll' : 'words.group.notAny');
    return t(all ? 'words.group.all' : 'words.group.any');
  };

  const triggerText = (trigger: RuleTrigger): string =>
    trigger === 'create' ? t('editor.when.created') : t('editor.when.imported');

  const partText = (part: SplitActionPart): string => {
    const amount = part.amount === 'rest' ? t('words.splitPart.rest') : part.amount;
    if (part.transferAccountId !== undefined) {
      return t('words.splitPart.transfer', { amount, account: named(labels.accounts, part.transferAccountId) });
    }
    if (part.categoryId !== undefined) {
      return t('words.splitPart.category', { amount, category: named(labels.categories, part.categoryId) });
    }
    return t('words.splitPart.plain', { amount });
  };

  const actionText = (action: RuleAction): string => {
    if (!isRuleActionType(action.type)) return t('words.unknownAction');
    switch (action.type) {
      case 'add_tags':
      case 'remove_tags':
        return t(`words.action.${action.type}`, { tags: list(action.tagIds.map((id) => named(labels.tags, id))) });
      case 'set_category':
        return t('words.action.set_category', {
          name: named(labels.categories, action.categoryId),
          onlyIfEmpty: action.onlyIfEmpty ? 'yes' : 'no',
        });
      case 'set_payee':
        return t('words.action.set_payee', {
          name: named(labels.payees, action.payeeId),
          onlyIfEmpty: action.onlyIfEmpty ? 'yes' : 'no',
        });
      case 'request_ai_review':
        return t('words.action.request_ai_review', { instruction: action.instruction });
      case 'set_payee_from_text':
        return t('words.action.set_payee_from_text', {
          template: action.template,
          createIfMissing: action.createIfMissing ? 'yes' : 'no',
          onlyIfEmpty: action.onlyIfEmpty ? 'yes' : 'no',
        });
      case 'set_description':
        return t('words.action.set_description', {
          template: action.template,
          mode: action.mode,
          onlyIfEmpty: action.onlyIfEmpty ? 'yes' : 'no',
        });
      case 'convert_to_transfer':
        return t('words.action.convert_to_transfer', {
          direction: action.fromAccountId !== undefined ? 'from' : 'other',
          account: named(labels.accounts, action.fromAccountId ?? action.toAccountId),
        });
      case 'split':
        return t('words.action.split', { parts: list(action.parts.map(partText)) });
    }
  };

  return { leafText, groupText, triggerText, actionText };
}

function ConditionNode({
  node,
  words,
  empty,
}: {
  node: RuleConditionNode;
  words: ReturnType<typeof useRuleWords>;
  empty: string;
}) {
  if (!isGroup(node)) return <li>{words.leafText(node)}</li>;
  const children = 'all' in node ? node.all : node.any;
  return (
    <li>
      {words.groupText(node)}
      {children.length === 0 ? (
        <p className="pl-1 text-gray-500 dark:text-gray-400">{empty}</p>
      ) : (
        <ul className="mt-0.5 list-[circle] space-y-0.5 pl-5">
          {children.map((child, index) => (
            <ConditionNode key={index} node={child} words={words} empty={empty} />
          ))}
        </ul>
      )}
    </li>
  );
}

interface RuleWordsProps {
  labels: RuleWordsLabels;
}

/** When the rule looks at a transaction. */
export function RuleTriggersInWords({ triggers, labels }: RuleWordsProps & { triggers: readonly RuleTrigger[] }) {
  const words = useRuleWords(labels);
  return (
    <ul className={LIST_CLASS}>
      {triggers.map((trigger) => (
        <li key={trigger}>{words.triggerText(trigger)}</li>
      ))}
    </ul>
  );
}

/** The conditions as a nested list; a group reads "All of these" or "Any of these". */
export function RuleConditionInWords({ condition, labels }: RuleWordsProps & { condition: RuleConditionNode }) {
  const t = useTranslations('rules');
  const words = useRuleWords(labels);
  // The empty "all" group is what a rule with no conditions stores: it matches everything.
  if (isGroup(condition) && 'all' in condition && condition.all.length === 0 && condition.not !== true) {
    return <p className="text-sm text-gray-900 dark:text-gray-100">{t('words.everyTransaction')}</p>;
  }
  return (
    <ul className={LIST_CLASS}>
      <ConditionNode node={condition} words={words} empty={t('editor.group.empty')} />
    </ul>
  );
}

/** What the rule does, in order. */
export function RuleActionsInWords({ actions, labels }: RuleWordsProps & { actions: readonly RuleAction[] }) {
  const words = useRuleWords(labels);
  return (
    <ol className="list-decimal space-y-0.5 pl-5 text-sm text-gray-900 dark:text-gray-100">
      {actions.map((action, index) => (
        <li key={index}>{words.actionText(action)}</li>
      ))}
    </ol>
  );
}

/** The active window in the reader's date format: "Active between 1 Oct 2026 and (no limit)". */
export function RuleActiveWindowInWords({
  activeFrom,
  activeTo,
}: {
  activeFrom?: string | null;
  activeTo?: string | null;
}) {
  const t = useTranslations('rules.editor');
  const { formatDate } = useDateFormat();
  const noLimit = t('when.window.noLimit');
  return (
    <p className="text-sm text-gray-900 dark:text-gray-100">
      {t('when.window.words', {
        from: activeFrom ? formatDate(activeFrom) : noLimit,
        to: activeTo ? formatDate(activeTo) : noLimit,
      })}
    </p>
  );
}

export interface RuleInWordsProps extends RuleWordsProps {
  rule: {
    triggers: readonly RuleTrigger[];
    condition: RuleConditionNode;
    actions: readonly RuleAction[];
    stopProcessing: boolean;
    activeFrom?: string | null;
    activeTo?: string | null;
  };
}

/** A whole rule: when, if, then, and whether it ends the pass. */
export function RuleInWords({ rule, labels }: RuleInWordsProps) {
  const t = useTranslations('rules.editor');
  return (
    <div className="space-y-2" data-testid="rule-in-words">
      <section>
        <h4 className={HEADING_CLASS}>{t('sections.when')}</h4>
        <RuleTriggersInWords triggers={rule.triggers} labels={labels} />
        {(rule.activeFrom || rule.activeTo) && (
          <RuleActiveWindowInWords activeFrom={rule.activeFrom} activeTo={rule.activeTo} />
        )}
      </section>
      <section>
        <h4 className={HEADING_CLASS}>{t('sections.if')}</h4>
        <RuleConditionInWords condition={rule.condition} labels={labels} />
      </section>
      <section>
        <h4 className={HEADING_CLASS}>{t('sections.then')}</h4>
        <RuleActionsInWords actions={rule.actions} labels={labels} />
      </section>
      {rule.stopProcessing && (
        <p className="text-sm text-gray-900 dark:text-gray-100">{t('when.stopProcessing')}</p>
      )}
    </div>
  );
}
