'use client';

import { memo, useCallback, useMemo, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { DensityToggleBar } from '@/components/ui/DensityToggle';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import type { RowAction } from '@/components/ui/row-actions/rowAction';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { INTERACTIVE_ROW_FOCUS_CLASS, activateOnKey } from '@/components/ui/interactive-row';
import { CellLabel, TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useLongPress, type LongPressRowHandlers } from '@/hooks/useLongPress';
import { useTableDensity, type DensityLevel } from '@/hooks/useTableDensity';
import { ruleInvalidReasonKeys, ruleSummaryValues } from '@/lib/rule-summary';
import { cn } from '@/lib/utils';
import { useDensityPreference } from '@/store/densityStore';
import type { TransactionRule } from '@/types/transaction-rule';

export type RuleMoveDirection = 'up' | 'down';

export interface RulesListProps {
  /** In evaluation order, exactly as the API answered. */
  rules: readonly TransactionRule[];
  /** Rules with a change in flight; their switch waits for the answer. */
  pendingIds: ReadonlySet<string>;
  /** True while a reorder is in flight; every move waits for it. */
  reordering: boolean;
  onToggle: (rule: TransactionRule, enabled: boolean) => void;
  onDuplicate: (rule: TransactionRule) => void;
  /** Open the manual-run dialog for the rule. */
  onRun: (rule: TransactionRule) => void;
  onMove: (rule: TransactionRule, direction: RuleMoveDirection) => void;
  onDelete: (rule: TransactionRule) => void;
}

/** A click on a control inside the row is that control's, not the row's. */
const keepInsideControl = (event: SyntheticEvent) => event.stopPropagation();

interface RuleRowProps {
  rule: TransactionRule;
  index: number;
  pending: boolean;
  actions: RowAction[];
  density: DensityLevel;
  cellPadding: string;
  /** Phone at Normal density: one card per rule instead of the table's cells. */
  wrapped: boolean;
  getRowHandlers: (rule: TransactionRule) => LongPressRowHandlers;
  onToggle: (rule: TransactionRule, enabled: boolean) => void;
  onOpen: (rule: TransactionRule) => void;
}

const RuleRow = memo(function RuleRow({
  rule,
  index,
  pending,
  actions,
  density,
  cellPadding,
  wrapped,
  getRowHandlers,
  onToggle,
  onOpen,
}: RuleRowProps) {
  const t = useTranslations('rules');
  const format = useFormatter();
  const summary = t('list.summary', { ...ruleSummaryValues(rule) });

  const reasons = ruleInvalidReasonKeys(rule).map((key) => t(`invalid.reasons.${key}`));
  const invalidText = t('invalid.tooltip', { reasons: format.list(reasons, { type: 'conjunction' }) });

  const rowProps = {
    role: 'row',
    tabIndex: 0,
    className: `ui-list-row group cursor-pointer select-none ${INTERACTIVE_ROW_FOCUS_CLASS} ${HOVER_ROW_ON_CARD}`,
    ...getRowHandlers(rule),
    onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
      // Enter on the switch or a menu button is theirs, not the row's.
      if (event.target === event.currentTarget) activateOnKey(() => onOpen(rule))(event);
    },
  };

  const toggle = (
    <ToggleSwitch
      checked={rule.enabled}
      disabled={pending}
      label={t('list.enabledLabel', { name: rule.name })}
      onChange={(next) => onToggle(rule, next)}
    />
  );

  const name = (
    <div
      className={`text-sm font-medium ${
        rule.enabled ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'
      }`}
    >
      {rule.name}
    </div>
  );

  const invalid = rule.invalid && (
    <div
      className="mt-1 inline-flex items-center gap-1"
      onClick={keepInsideControl}
      onMouseDown={keepInsideControl}
      onTouchStart={keepInsideControl}
    >
      <Badge variant="red" size="sm">
        {t('invalid.badge')}
      </Badge>
      <InfoTooltip text={invalidText} placement="top" usePortal />
    </div>
  );

  // Phone at Normal density: one card per rule. The card has no column header
  // above it, so the switch carries its own visible name; the actions are the
  // long-press sheet's, as on the other phone lists.
  if (wrapped) {
    return (
      <tr {...rowProps}>
        <td className="p-0">
          <div className={cellPadding}>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2">
              <div className="min-w-0 break-words">
                {name}
                {invalid}
              </div>
              <div
                className="inline-flex items-center gap-2"
                onClick={keepInsideControl}
                onMouseDown={keepInsideControl}
                onTouchStart={keepInsideControl}
                onContextMenu={keepInsideControl}
              >
                {toggle}
                <span className="text-sm text-gray-700 dark:text-gray-300">{t('list.header.enabled')}</span>
              </div>
              <div className="col-span-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4">
                <div>
                  <CellLabel>{t('list.header.order')}</CellLabel>
                  <div className="text-sm text-gray-500 dark:text-gray-400">{index + 1}</div>
                </div>
                <div className="min-w-0">
                  <CellLabel>{t('list.header.summary')}</CellLabel>
                  <div className="text-sm text-gray-500 dark:text-gray-400 break-words">{summary}</div>
                </div>
              </div>
            </div>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr {...rowProps}>
      <Td className={cn(cellPadding, 'ui-rule-no hidden w-12 text-gray-500 dark:text-gray-400 sm:table-cell')}>{index + 1}</Td>
      <Td className={cn(cellPadding, 'w-16')}>
        {/* The column header names the switch; its accessible name adds the rule's. */}
        <div
          className="inline-flex"
          onClick={keepInsideControl}
          onMouseDown={keepInsideControl}
          onTouchStart={keepInsideControl}
          onContextMenu={keepInsideControl}
        >
          {toggle}
        </div>
      </Td>
      <Td className={cellPadding}>
        {name}
        <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 sm:hidden">{summary}</div>
        {invalid}
      </Td>
      <Td className={cn(cellPadding, 'hidden text-gray-500 dark:text-gray-400 sm:table-cell')}>{summary}</Td>
      <Td align="right" className={cn(cellPadding, 'hidden whitespace-nowrap font-medium min-[480px]:table-cell')}>
        <RowActions actions={actions} density={density} maxInline={2} />
      </Td>
    </tr>
  );
});

/**
 * The rules in evaluation order, one row each. Reordering is a move up or down
 * in the row menu (no drag library); the order the reader sees is the order the
 * server holds, so a move waits for the server's answer instead of guessing.
 * The headers do not sort: the list's order IS the order the rules run in, and
 * a list sorted by name would show an order that is not the one applied.
 */
export function RulesList({
  rules,
  pendingIds,
  reordering,
  onToggle,
  onDuplicate,
  onRun,
  onMove,
  onDelete,
}: RulesListProps) {
  const t = useTranslations('rules');
  const tc = useTranslations('common');
  const router = useRouter();
  const [sheetRule, setSheetRule] = useState<TransactionRule | null>(null);
  const { density } = useDensityPreference('rules');
  const { cellPadding, headerPadding } = useTableDensity(density);
  const isMobile = useIsMobile();
  const wrapped = isMobile && density === 'normal';

  const openRule = useCallback(
    (rule: TransactionRule) => router.push(`/rules/${rule.id}`),
    [router],
  );

  const { getRowHandlers } = useLongPress<TransactionRule>({
    onLongPress: setSheetRule,
    onClick: openRule,
  });

  const buildActions = useCallback(
    (rule: TransactionRule, index: number): RowAction[] => [
      { key: 'edit', label: tc('actions.edit'), icon: 'edit', tone: 'primary', onClick: () => openRule(rule) },
      { key: 'duplicate', label: tc('actions.duplicate'), icon: 'duplicate', tone: 'neutral', onClick: () => onDuplicate(rule) },
      {
        key: 'run',
        label: t('actions.run'),
        icon: 'post',
        tone: 'success',
        // An invalid rule is refused by the server; the editor explains why.
        disabled: rule.invalid,
        title: rule.invalid ? t('actions.runInvalid') : undefined,
        onClick: () => onRun(rule),
      },
      {
        key: 'moveUp',
        label: t('actions.moveUp'),
        icon: 'moveUp',
        tone: 'neutral',
        disabled: index === 0 || reordering,
        onClick: () => onMove(rule, 'up'),
      },
      {
        key: 'moveDown',
        label: t('actions.moveDown'),
        icon: 'moveDown',
        tone: 'neutral',
        disabled: index === rules.length - 1 || reordering,
        onClick: () => onMove(rule, 'down'),
      },
      { key: 'delete', label: tc('actions.delete'), icon: 'delete', tone: 'delete', destructive: true, onClick: () => onDelete(rule) },
    ],
    [t, tc, rules.length, reordering, openRule, onDuplicate, onRun, onMove, onDelete],
  );

  const rowActions = useMemo(() => rules.map((rule, index) => buildActions(rule, index)), [rules, buildActions]);
  // The sheet shows the rule as the list holds it now, not as it was pressed.
  const sheetIndex = sheetRule ? rules.findIndex((r) => r.id === sheetRule.id) : -1;
  const sheetCurrent = sheetIndex >= 0 ? rules[sheetIndex] : null;

  return (
    <div>
      <DensityToggleBar view="rules" />
      <div className="overflow-x-auto">
        <table className={`${TABLE_CLASS} ui-list-ledger ui-list-rules`}>
          {/* The phone card captions its own values, and nothing here sorts, so it has no header row. */}
          {!wrapped && (
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <Th className={cn(headerPadding, 'hidden sm:table-cell')}>{t('list.header.order')}</Th>
                <Th className={headerPadding}>{t('list.header.enabled')}</Th>
                <Th className={headerPadding}>{t('list.header.name')}</Th>
                <Th className={cn(headerPadding, 'hidden sm:table-cell')}>{t('list.header.summary')}</Th>
                <Th align="right" className={cn(headerPadding, 'hidden min-[480px]:table-cell')}>
                  {t('list.header.actions')}
                </Th>
              </tr>
            </thead>
          )}
          <tbody className={TABLE_BODY_CLASS}>
            {rules.map((rule, index) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                index={index}
                pending={pendingIds.has(rule.id)}
                actions={rowActions[index]}
                density={density}
                cellPadding={cellPadding}
                wrapped={wrapped}
                getRowHandlers={getRowHandlers}
                onToggle={onToggle}
                onOpen={openRule}
              />
            ))}
          </tbody>
        </table>
      </div>
      <RowActionSheet
        isOpen={sheetCurrent !== null}
        title={sheetCurrent?.name ?? ''}
        actions={sheetCurrent ? buildActions(sheetCurrent, sheetIndex) : []}
        onClose={() => setSheetRule(null)}
      />
    </div>
  );
}
