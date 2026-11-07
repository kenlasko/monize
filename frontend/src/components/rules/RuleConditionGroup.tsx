'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { RuleCardShell, RuleErrorList } from '@/components/rules/RuleCardShell';
import { RuleConditionCard } from '@/components/rules/RuleConditionCard';
import type { RuleOptions } from '@/components/rules/use-rule-options';
import { useCardActions } from '@/components/rules/use-rule-card-actions';
import { Button } from '@/components/ui/Button';
import type { RowAction } from '@/components/ui/row-actions/rowAction';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { scanCaptures } from '@/lib/rule-captures';
import { MAX_RULE_CONDITION_DEPTH } from '@/lib/rule-fields';
import {
  canDuplicateNode,
  canMoveNode,
  canNestGroup,
  conditionKey,
  type EditorGroup,
  type EditorNode,
  type GroupMatch,
  type NodePath,
  type TreeCapacity,
} from '@/lib/rule-tree';

/** What a group or a card can ask the tree to do; every path is from the root. */
export interface RuleTreeHandlers {
  replace: (path: NodePath, node: EditorNode) => void;
  add: (groupPath: NodePath, kind: 'leaf' | 'group') => void;
  remove: (path: NodePath) => void;
  move: (path: NodePath, delta: -1 | 1) => void;
  duplicate: (path: NodePath) => void;
}

/** Everything the recursive group reads that is not its own node. */
export interface RuleTreeEnv {
  root: EditorGroup;
  options: RuleOptions;
  /** Error codes by card key (`conditionKey`). */
  errors: Readonly<Record<string, readonly string[]>>;
  capacity: TreeCapacity;
  handlers: RuleTreeHandlers;
}

interface RuleConditionGroupProps {
  group: EditorGroup;
  path: NodePath;
  env: RuleTreeEnv;
  /** The card menu of a nested group; absent for the root, which has no frame. */
  actions?: RowAction[];
}

const MATCHES: readonly GroupMatch[] = ['all', 'any'];

/**
 * A group of conditions: "all of these" or "any of these", optionally negated,
 * holding conditions and further groups. The root group has no card frame or
 * menu, since it cannot be moved or removed; a nested group is a card like any
 * other. "Add group" is disabled at the depth the server allows, so a tree the
 * server would refuse cannot be built.
 */
export function RuleConditionGroup({ group, path, env, actions }: RuleConditionGroupProps) {
  const t = useTranslations('rules.editor');
  const cardActions = useCardActions();
  const { handlers, root, capacity } = env;
  const errors = env.errors[conditionKey(path)] ?? [];
  const canGroup = canNestGroup(path);
  // A pattern is checked against the whole rule (a name may be used once), so the scan reads the root.
  const captureCodes = useMemo(
    () => new Map(scanCaptures(root).issues.map((issue) => [issue.uid, issue.codes])),
    [root],
  );

  const header = (
    <div className="flex flex-wrap items-center gap-3">
      <div role="group" aria-label={t('group.matchLabel')} className={SEGMENTED_GROUP_CLASS}>
        {MATCHES.map((match) => (
          <button
            key={match}
            type="button"
            aria-pressed={group.match === match}
            className={segmentClass(group.match === match)}
            onClick={() => handlers.replace(path, { ...group, match })}
          >
            {match === 'all' ? t('group.matchAll') : t('group.matchAny')}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <ToggleSwitch
          size="sm"
          checked={group.not}
          label={t('group.not')}
          onChange={(not) => handlers.replace(path, { ...group, not })}
        />
        <span className="text-sm text-gray-700 dark:text-gray-300">{t('group.not')}</span>
        <InfoTooltip text={t('group.notHelp')} placement="top" usePortal learnMore="rulesConditions" />
      </div>
    </div>
  );

  const body = (
    <div className="space-y-3">
      {header}
      {group.children.length === 0 && actions !== undefined && (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('group.empty')}</p>
      )}
      {group.children.map((child, index) => {
        const childPath = [...path, index];
        const childActions = cardActions({
          canDuplicate: canDuplicateNode(root, childPath),
          canMoveUp: canMoveNode(root, childPath, -1),
          canMoveDown: canMoveNode(root, childPath, 1),
          onDuplicate: () => handlers.duplicate(childPath),
          onMoveUp: () => handlers.move(childPath, -1),
          onMoveDown: () => handlers.move(childPath, 1),
          onDelete: () => handlers.remove(childPath),
        });
        if (child.kind === 'group') {
          return (
            <RuleConditionGroup key={child.uid} group={child} path={childPath} env={env} actions={childActions} />
          );
        }
        return (
          <RuleConditionCard
            key={child.uid}
            leaf={child}
            options={env.options}
            actions={childActions}
            errors={env.errors[conditionKey(childPath)] ?? []}
            captureCodes={captureCodes.get(child.uid)}
            onChange={(next) => handlers.replace(childPath, next)}
          />
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={!capacity.canAddLeaf} onClick={() => handlers.add(path, 'leaf')}>
          {t('group.addCondition')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canGroup || !capacity.canAddGroupNode}
          onClick={() => handlers.add(path, 'group')}
        >
          {t('group.addGroup')}
        </Button>
      </div>
      {!canGroup && (
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('group.depthLimit', { max: MAX_RULE_CONDITION_DEPTH })}</p>
      )}
      {(!capacity.canAddLeaf || !capacity.canAddGroupNode) && (
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('group.sizeLimit')}</p>
      )}
    </div>
  );

  if (actions === undefined) {
    return (
      <div>
        {body}
        <RuleErrorList errors={errors} />
      </div>
    );
  }
  return (
    <RuleCardShell label={t('group.title')} actions={actions} errors={errors}>
      {body}
    </RuleCardShell>
  );
}
