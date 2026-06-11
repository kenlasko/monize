'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { payeesApi } from '@/lib/payees';
import { AutoMergeGroup } from '@/types/payee';
import toast from 'react-hot-toast';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

type CategoryGranularity = 'category' | 'subcategory';

const logger = createLogger('AutoMergePayees');

interface AutoMergePayeesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface EditableGroup {
  id: string;
  groupKey: string;
  included: boolean;
  canonicalPayeeId: string;
  canonicalName: string;
  alias: string;
  members: AutoMergeGroup['members'];
  selectedMemberIds: Set<string>;
}

function toEditableGroups(groups: AutoMergeGroup[]): EditableGroup[] {
  return groups.map((g, index) => ({
    // Stable, unique identity for React keys and state updates. groupKey (the
    // shared token prefix) is not guaranteed unique across groups, so we cannot
    // key on it.
    id: `group-${index}`,
    groupKey: g.groupKey,
    included: true,
    canonicalPayeeId: g.suggestedCanonicalPayeeId,
    canonicalName: g.suggestedName,
    alias: g.suggestedAlias,
    members: g.members,
    selectedMemberIds: new Set(g.members.map((m) => m.payeeId)),
  }));
}

export function AutoMergePayeesDialog({
  isOpen,
  onClose,
  onSuccess,
}: AutoMergePayeesDialogProps) {
  const t = useTranslations('payees');
  const tc = useTranslations('common');

  const [minGroupSize, setMinGroupSize] = useState(2);
  const [similarityPercent, setSimilarityPercent] = useState(85);
  const [minTokenLength, setMinTokenLength] = useState(3);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [categoryMatchEnabled, setCategoryMatchEnabled] = useState(false);
  const [categoryGranularity, setCategoryGranularity] =
    useState<CategoryGranularity>('category');
  const [ignoreCommonWords, setIgnoreCommonWords] = useState(false);
  const [commonWordMinVariants, setCommonWordMinVariants] = useState(5);

  const [groups, setGroups] = useState<EditableGroup[]>([]);
  const [hasPreviewLoaded, setHasPreviewLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  // Reset state when the dialog opens (info-from-previous-render pattern to
  // avoid setState in an effect).
  const [prevOpen, setPrevOpen] = useState(isOpen);
  if (isOpen !== prevOpen) {
    setPrevOpen(isOpen);
    if (isOpen) {
      setGroups([]);
      setHasPreviewLoaded(false);
    }
  }

  const loadPreview = async () => {
    setIsLoading(true);
    try {
      const results = await payeesApi.getAutoMergePreview({
        minGroupSize,
        similarityThreshold: similarityPercent / 100,
        minTokenLength,
        includeInactive,
        categoryMatch: categoryMatchEnabled ? categoryGranularity : 'off',
        ignoreCommonWords,
        commonWordMinVariants,
      });
      setGroups(toEditableGroups(results));
      setHasPreviewLoaded(true);
    } catch (error) {
      toast.error(getErrorMessage(error, t('autoMerge.toasts.loadFailed')));
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  const updateGroup = (id: string, patch: Partial<EditableGroup>) => {
    setGroups((prev) =>
      prev.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    );
  };

  const toggleMember = (group: EditableGroup, payeeId: string) => {
    // The canonical member is always part of the merge.
    if (payeeId === group.canonicalPayeeId) return;
    const next = new Set(group.selectedMemberIds);
    if (next.has(payeeId)) {
      next.delete(payeeId);
    } else {
      next.add(payeeId);
    }
    updateGroup(group.id, { selectedMemberIds: next });
  };

  const setCanonical = (group: EditableGroup, payeeId: string) => {
    const member = group.members.find((m) => m.payeeId === payeeId);
    const next = new Set(group.selectedMemberIds);
    next.add(payeeId); // a canonical is always included
    updateGroup(group.id, {
      canonicalPayeeId: payeeId,
      canonicalName: member ? member.name : group.canonicalName,
      selectedMemberIds: next,
    });
  };

  const setAllIncluded = (included: boolean) => {
    setGroups((prev) => prev.map((g) => ({ ...g, included })));
  };

  // A group is applicable when included and has at least two selected members
  // (the canonical plus one source to merge in).
  const applicableGroups = groups.filter(
    (g) => g.included && g.selectedMemberIds.size >= 2,
  );

  const handleApply = async () => {
    if (applicableGroups.length === 0) {
      toast.error(t('autoMerge.toasts.selectAtLeastOne'));
      return;
    }

    setIsApplying(true);
    try {
      const payload = applicableGroups.map((g) => ({
        canonicalPayeeId: g.canonicalPayeeId,
        canonicalName: g.canonicalName.trim() || undefined,
        sourcePayeeIds: [...g.selectedMemberIds].filter(
          (id) => id !== g.canonicalPayeeId,
        ),
        alias: g.alias.trim() || undefined,
      }));

      const result = await payeesApi.applyAutoMerge(payload);
      toast.success(
        t('autoMerge.toasts.applied', {
          groups: result.groupsMerged,
          payees: result.payeesMerged,
        }),
      );
      if (result.skippedAliases > 0) {
        toast(
          t('autoMerge.toasts.aliasesSkipped', { count: result.skippedAliases }),
        );
      }
      onSuccess();
      onClose();
    } catch (error) {
      toast.error(getErrorMessage(error, t('autoMerge.toasts.applyFailed')));
      logger.error(error);
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="2xl" className="overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
          {t('autoMerge.title')}
        </h2>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {/* Description */}
        <div className="mb-6 p-4 bg-blue-50 dark:bg-blue-900/30 rounded-lg border border-blue-200 dark:border-blue-800">
          <h3 className="text-sm font-semibold text-blue-800 dark:text-blue-200 mb-2">
            {t('autoMerge.howItWorksTitle')}
          </h3>
          <p className="text-sm text-blue-700 dark:text-blue-300">
            {t('autoMerge.howItWorksBody')}
          </p>
        </div>

        {/* Settings */}
        <div className="space-y-6 mb-6">
          {/* Minimum group size */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('autoMerge.minGroupSizeLabel', { count: minGroupSize })}
            </label>
            <input
              type="range"
              min="2"
              max="10"
              value={minGroupSize}
              onChange={(e) => setMinGroupSize(parseInt(e.target.value))}
              className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-blue-600"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {t('autoMerge.minGroupSizeHelp')}
            </p>
          </div>

          {/* Similarity threshold */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('autoMerge.similarityLabel', { percent: similarityPercent })}
            </label>
            <input
              type="range"
              min="50"
              max="100"
              step="5"
              value={similarityPercent}
              onChange={(e) => setSimilarityPercent(parseInt(e.target.value))}
              className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-blue-600"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {t('autoMerge.similarityHelp')}
            </p>
          </div>

          {/* Minimum token length */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('autoMerge.minTokenLengthLabel', { count: minTokenLength })}
            </label>
            <input
              type="range"
              min="2"
              max="6"
              value={minTokenLength}
              onChange={(e) => setMinTokenLength(parseInt(e.target.value))}
              className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-blue-600"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {t('autoMerge.minTokenLengthHelp')}
            </p>
          </div>

          {/* Include inactive */}
          <label className="flex items-center gap-3 cursor-pointer">
            <ToggleSwitch
              checked={includeInactive}
              onChange={setIncludeInactive}
              label={t('autoMerge.includeInactiveLabel')}
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              {t('autoMerge.includeInactiveLabel')}
            </span>
          </label>

          {/* Require matching category */}
          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <ToggleSwitch
                checked={categoryMatchEnabled}
                onChange={setCategoryMatchEnabled}
                label={t('autoMerge.categoryMatchLabel')}
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                {t('autoMerge.categoryMatchLabel')}
              </span>
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {t('autoMerge.categoryMatchHelp')}
            </p>
            {categoryMatchEnabled && (
              <div
                className="flex gap-1 mt-2"
                role="group"
                aria-label={t('autoMerge.granularityLabel')}
              >
                {(['category', 'subcategory'] as CategoryGranularity[]).map(
                  (mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setCategoryGranularity(mode)}
                      aria-pressed={categoryGranularity === mode}
                      className={
                        categoryGranularity === mode
                          ? 'px-3 py-1.5 text-sm font-medium rounded-md bg-blue-600 text-white transition-colors'
                          : 'px-3 py-1.5 text-sm font-medium rounded-md bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors'
                      }
                    >
                      {t(`autoMerge.granularity.${mode}`)}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>

          {/* Ignore common words */}
          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <ToggleSwitch
                checked={ignoreCommonWords}
                onChange={setIgnoreCommonWords}
                label={t('autoMerge.ignoreCommonWordsLabel')}
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                {t('autoMerge.ignoreCommonWordsLabel')}
              </span>
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {t('autoMerge.ignoreCommonWordsHelp')}
            </p>
            {ignoreCommonWords && (
              <div className="mt-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  {t('autoMerge.commonWordSensitivityLabel', {
                    count: commonWordMinVariants,
                  })}
                </label>
                <input
                  type="range"
                  min="2"
                  max="15"
                  value={commonWordMinVariants}
                  onChange={(e) =>
                    setCommonWordMinVariants(parseInt(e.target.value))
                  }
                  className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {t('autoMerge.commonWordSensitivityHelp')}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Preview Button */}
        <div className="mb-4">
          <Button
            onClick={loadPreview}
            disabled={isLoading}
            variant="secondary"
            className="w-full"
          >
            {isLoading ? t('autoMerge.loading') : t('autoMerge.previewButton')}
          </Button>
        </div>

        {/* Results */}
        {hasPreviewLoaded && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {t('autoMerge.groupsHeader', { count: groups.length })}
              </h3>
              {groups.length > 0 && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setAllIncluded(true)}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {t('autoMerge.selectAll')}
                  </button>
                  <span className="text-gray-300 dark:text-gray-600">|</span>
                  <button
                    type="button"
                    onClick={() => setAllIncluded(false)}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {t('autoMerge.deselectAll')}
                  </button>
                </div>
              )}
            </div>

            {groups.length === 0 ? (
              <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                <p>{t('autoMerge.empty.line1')}</p>
                <p className="text-sm mt-1">{t('autoMerge.empty.line2')}</p>
              </div>
            ) : (
              <div className="space-y-4">
                {groups.map((group) => (
                  <div
                    key={group.id}
                    className={`border rounded-lg p-4 ${
                      group.included
                        ? 'border-gray-200 dark:border-gray-700'
                        : 'border-gray-200 dark:border-gray-700 opacity-50'
                    }`}
                  >
                    {/* Group header: include toggle + editable canonical name + alias */}
                    <div className="flex items-start gap-3 mb-3">
                      <div className="mt-1">
                        <ToggleSwitch
                          checked={group.included}
                          onChange={(next) =>
                            updateGroup(group.id, { included: next })
                          }
                          label={t('autoMerge.includeGroupLabel')}
                        />
                      </div>
                      <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                            {t('autoMerge.canonicalNameLabel')}
                          </label>
                          <input
                            type="text"
                            value={group.canonicalName}
                            onChange={(e) =>
                              updateGroup(group.id, {
                                canonicalName: e.target.value,
                              })
                            }
                            className="block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm text-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                            {t('autoMerge.aliasLabel')}
                          </label>
                          <input
                            type="text"
                            value={group.alias}
                            onChange={(e) =>
                              updateGroup(group.id, { alias: e.target.value })
                            }
                            placeholder={t('autoMerge.aliasPlaceholder')}
                            className="block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm text-sm font-mono focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Members */}
                    <ul className="divide-y divide-gray-100 dark:divide-gray-700 border-t border-gray-100 dark:border-gray-700">
                      {group.members.map((member) => {
                        const isCanonical = member.payeeId === group.canonicalPayeeId;
                        return (
                          <li
                            key={member.payeeId}
                            className="flex items-center gap-3 py-2 text-sm"
                          >
                            <input
                              type="radio"
                              name={`canonical-${group.id}`}
                              checked={isCanonical}
                              onChange={() => setCanonical(group, member.payeeId)}
                              disabled={!group.included}
                              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600"
                              aria-label={t('autoMerge.keepLabel')}
                            />
                            <ToggleSwitch
                              size="sm"
                              checked={group.selectedMemberIds.has(member.payeeId)}
                              onChange={() => toggleMember(group, member.payeeId)}
                              disabled={isCanonical || !group.included}
                              label={t('autoMerge.includeMemberLabel')}
                            />
                            <span className="flex-1 text-gray-900 dark:text-gray-100">
                              {member.name}
                              {isCanonical && (
                                <span className="ml-2 inline-flex text-xs font-medium rounded-full px-2 py-0.5 bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                                  {t('autoMerge.keepBadge')}
                                </span>
                              )}
                            </span>
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              {t('autoMerge.memberTransactions', {
                                count: member.transactionCount,
                              })}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-between items-center">
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {applicableGroups.length > 0 && (
            <span>
              {t('autoMerge.selectedCount', { count: applicableGroups.length })}
            </span>
          )}
        </div>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={onClose} disabled={isApplying}>
            {tc('cancel')}
          </Button>
          <Button
            onClick={handleApply}
            disabled={isApplying || applicableGroups.length === 0}
          >
            {isApplying
              ? t('autoMerge.applying')
              : t('autoMerge.applyButton', { count: applicableGroups.length })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
