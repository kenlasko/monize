'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Banner } from '@/components/rules/RuleEditorBanners';
import { RuleRunFilterFields } from '@/components/rules/RuleRunFilterFields';
import { RuleRunPreviewTable } from '@/components/rules/RuleRunPreviewTable';
import { RuleSection } from '@/components/rules/RuleSection';
import type { RuleOption } from '@/components/rules/use-rule-options';
import { useRuleRunErrorMessage } from '@/components/rules/use-rule-run-error';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { createLogger } from '@/lib/logger';
import { draftToPayload, type RuleDraft } from '@/lib/rule-draft';
import { NAME_KEY, draftGaps } from '@/lib/rule-errors';
import {
  DEFAULT_RUN_FILTERS,
  filtersToRequest,
  hasBackwardsRange,
  type RunFiltersState,
} from '@/lib/rule-run-filters';
import { transactionRulesApi } from '@/lib/transaction-rules-api';
import type { RuleRunPreview } from '@/types/transaction-rule-run';

const logger = createLogger('RuleTestPanel');

/**
 * Each state carries the key of the request that produced it (the draft's
 * condition, actions and active window plus the filters), so a result is never read as the
 * answer for a draft it was not computed from.
 */
type TestState =
  | { status: 'idle' }
  | { status: 'loading'; key: string }
  | { status: 'error'; key: string; message: string }
  | { status: 'done'; key: string; preview: RuleRunPreview };

/** What the last finished test found, for the save button's warning. */
export interface RuleTestOutcome {
  matched: number;
  /** Scanned transactions whose condition matched, changed or not. */
  conditionMatched: number;
  scanned: number;
  /** The draft or the filters changed since, so the result no longer describes the draft. */
  stale: boolean;
}

interface RuleTestPanelProps {
  /** The draft as it is now, saved or not. */
  draft: RuleDraft;
  accountOptions: readonly RuleOption[];
  /** The condition text does not parse, so the draft is not what the reader sees. */
  blocked?: boolean;
  /** Told the outcome of the last finished test, or null when there is none. */
  /** The draft an existing rule was opened with (see `draftGaps`); null for a new rule. */
  loaded?: RuleDraft | null;
  onResult?: (outcome: RuleTestOutcome | null) => void;
  /** The saved rule being edited; absent for a new rule. */
  ruleId?: string;
}

/**
 * "Test" below Then: runs the current draft, unsaved, against existing
 * transactions and shows what it would change. Nothing is written. Editing the
 * draft or the filters afterwards leaves the result on screen but marks it as
 * out of date, because it no longer describes what the reader is looking at.
 */
export function RuleTestPanel({ draft, accountOptions, blocked = false, loaded = null, onResult, ruleId }: RuleTestPanelProps) {
  const t = useTranslations('rules.test');
  const errorMessage = useRuleRunErrorMessage();
  const [filters, setFilters] = useState<RunFiltersState>(DEFAULT_RUN_FILTERS);
  const [state, setState] = useState<TestState>({ status: 'idle' });
  // Only the newest request may write the state.
  const latest = useRef(0);

  const request = useMemo(() => {
    // The window is part of what the rule does (INV-RULE-004): the test reaches only the rows the saved rule would.
    // An open side is left out; the server reads absent as open.
    const { condition, actions, activeFrom, activeTo } = draftToPayload(draft);
    return {
      ...(ruleId ? { ruleId } : {}),
      condition,
      actions,
      ...(activeFrom ? { activeFrom } : {}),
      ...(activeTo ? { activeTo } : {}),
      filters: filtersToRequest(filters),
    };
  }, [draft, filters, ruleId]);
  const key = useMemo(() => JSON.stringify(request), [request]);

  // The name is not part of a test; every other gap would be refused by the server.
  const incomplete = blocked || draftGaps(draft, loaded).some((entry) => entry.path !== NAME_KEY);
  // A window that ends before it starts is refused by the server; do not send it.
  const windowBackwards = draft.activeFrom !== '' && draft.activeTo !== '' && draft.activeFrom > draft.activeTo;
  const backwards = hasBackwardsRange(filters) || windowBackwards;
  const busy = state.status === 'loading';

  const test = async () => {
    const id = ++latest.current;
    setState({ status: 'loading', key });
    try {
      const preview = await transactionRulesApi.previewDraft(request);
      if (id === latest.current) setState({ status: 'done', key, preview });
    } catch (error) {
      if (id !== latest.current) return;
      logger.error(error);
      setState({
        status: 'error',
        key,
        message: errorMessage(error, 'testFailed'),
      });
    }
  };

  const stale = (state.status === 'done' || state.status === 'error') && state.key !== key;

  const done = state.status === 'done' ? state.preview : null;
  useEffect(() => {
    onResult?.(
      done
        ? {
            matched: done.matched.length,
            conditionMatched: done.conditionMatchedCount,
            scanned: done.scanned,
            stale,
          }
        : null,
    );
  }, [done, stale, onResult]);

  return (
    <RuleSection title={t('title')} description={t('description')} anchor={tourAnchor(TOUR_ANCHORS.ruleEditorTest)}>
      <RuleRunFilterFields filters={filters} accountOptions={accountOptions} onChange={setFilters} />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          isLoading={busy}
          disabled={busy || incomplete || backwards}
          onClick={() => void test()}
        >
          {state.status === 'done' ? t('again') : t('button')}
        </Button>
        {incomplete && <p className="text-sm text-gray-500 dark:text-gray-400">{t('incomplete')}</p>}
      </div>

      <div className="mt-4" aria-live="polite" aria-busy={busy || stale}>
        {state.status === 'idle' && <p className="text-sm text-gray-500 dark:text-gray-400">{t('idle')}</p>}
        {state.status === 'loading' && <LoadingSpinner text={t('running')} />}
        {state.status === 'error' && (
          <Banner tone="red">
            <p>{t('failed', { message: state.message })}</p>
          </Banner>
        )}
        {stale && (
          <p role="status" className="mb-3 text-sm text-amber-700 dark:text-amber-400">
            {t('stale')}
          </p>
        )}
        {state.status === 'done' && (
          <div className={stale ? 'opacity-60' : undefined} data-testid="rule-test-result" data-stale={stale}>
            <RuleRunPreviewTable preview={state.preview} />
          </div>
        )}
      </div>
    </RuleSection>
  );
}
