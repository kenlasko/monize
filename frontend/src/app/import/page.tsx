'use client';

import { Suspense, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { UploadStep } from '@/components/import/UploadStep';
import { SelectAccountStep } from '@/components/import/SelectAccountStep';
import { CsvColumnMappingStep } from '@/components/import/CsvColumnMappingStep';
import { MapCategoriesStep } from '@/components/import/MapCategoriesStep';
import { MapSecuritiesStep } from '@/components/import/MapSecuritiesStep';
import { MapAccountsStep } from '@/components/import/MapAccountsStep';
import { ReviewStep } from '@/components/import/ReviewStep';
import { CompleteStep } from '@/components/import/CompleteStep';
import { MultiAccountReviewStep } from '@/components/import/MultiAccountReviewStep';
import { MnyReviewStep } from '@/components/import/MnyReviewStep';
import { MnyImportProgress } from '@/components/import/MnyImportProgress';
import { MnyVerificationReport } from '@/components/import/MnyVerificationReport';
import { MnyPasswordDialog } from '@/components/import/MnyPasswordDialog';
import { MnyWipeConfirmDialog } from '@/components/import/MnyWipeConfirmDialog';
import { useImportWizard } from '@/hooks/useImportWizard';
import { discardSharedBundle, readSharedBundle } from '@/lib/share-inbox';
import { isShareBundleId } from '@/lib/share-target';
import { createLogger } from '@/lib/logger';
import { useAuthStore } from '@/store/authStore';
import { formatCategoryPath } from './import-utils';
import { docsUrl } from '@/lib/docs-links';

const logger = createLogger('Import');

/**
 * Pick up files handed over by the Web Share Target's review screen.
 *
 * The review screen routes here with the bundle id rather than the files, so
 * this is where they are read and where they stop being the stash's: the bundle
 * is discarded once the wizard holds the contents, which is what keeps one owner
 * of those bytes. The ref makes it happen exactly once -- re-running it would
 * restart a wizard the user has already moved through.
 *
 * Nothing is imported here. The wizard opens on its mapping and review steps
 * exactly as it does for a file the user picked, and the import still takes an
 * explicit press.
 */
function useSharedFilesHandoff(
  handleFiles: (files: File[]) => Promise<void>,
  ready: boolean,
  // A bundle belongs to one account; the wizard reads it as that reader.
  viewerUserId: string | undefined,
) {
  const searchParams = useSearchParams();
  const shareId = searchParams?.get('share') ?? null;
  const takenRef = useRef<string | null>(null);

  useEffect(() => {
    // `ready` is the wizard's reference data being in. Without it the file
    // would be matched against empty account, category and security lists, so
    // every category in it would be offered as one to CREATE even where the
    // user already has it. The ref is claimed only once we actually proceed,
    // so a not-yet-ready render does not consume the one attempt.
    if (!ready || !viewerUserId) return;
    if (!isShareBundleId(shareId ?? '') || takenRef.current === shareId) return;
    takenRef.current = shareId;
    const id = shareId as string;

    const take = async () => {
      const bundle = await readSharedBundle(id, viewerUserId);
      if (!bundle || bundle.expired || bundle.files.length === 0) return;
      await handleFiles(bundle.files);
      await discardSharedBundle(id);
    };

    void take().catch((error) => {
      logger.error('Failed to take the shared files into the wizard:', error);
    });
  }, [shareId, handleFiles, ready, viewerUserId]);
}

export default function ImportPage() {
  return (
    <ProtectedRoute>
      {/* useSearchParams needs a boundary; the wizard renders immediately. */}
      <Suspense fallback={null}>
        <ImportContent />
      </Suspense>
    </ProtectedRoute>
  );
}

function ImportContent() {
  const t = useTranslations('import');
  const wizard = useImportWizard();
  // An OIDC account confirms the optional wipe by re-authenticating with its
  // provider rather than by typing a password.
  const user = useAuthStore((state) => state.user);
  useSharedFilesHandoff(wizard.handleFiles, wizard.dataLoaded, user?.id);

  const renderStep = () => {
    switch (wizard.step) {
      case 'upload':
        return (
          <UploadStep
            preselectedAccount={wizard.preselectedAccount}
            isLoading={wizard.isLoading}
            onFileSelect={wizard.handleFileSelect}
            onFilesDrop={wizard.handleFiles}
            // A .mny that would not open leaves the wizard right here, so this
            // is where the reason has to appear. The password prompt is not a
            // failure and shows itself.
            mnyError={
              wizard.mny.passwordPrompt ? null : wizard.mny.uploadError
            }
          />
        );

      case 'csvColumnMapping':
        return (
          <CsvColumnMappingStep
            headers={wizard.csvHeaders}
            sampleRows={wizard.csvSampleRows}
            columnMapping={wizard.csvColumnMapping}
            onColumnMappingChange={wizard.handleCsvColumnMappingChange}
            onInvestmentModeChange={wizard.handleCsvInvestmentModeChange}
            transferRules={wizard.csvTransferRules}
            onTransferRulesChange={wizard.handleCsvTransferRulesChange}
            accounts={wizard.accounts}
            savedMappings={wizard.savedColumnMappings}
            onSaveMapping={wizard.handleSaveColumnMapping}
            onLoadMapping={wizard.handleLoadColumnMapping}
            onDeleteMapping={wizard.handleDeleteColumnMapping}
            onDelimiterChange={wizard.handleCsvDelimiterChange}
            onHasHeaderChange={wizard.handleCsvHasHeaderChange}
            isLoading={wizard.isLoading}
            onNext={wizard.handleCsvMappingComplete}
            setStep={wizard.setStep}
          />
        );

      case 'selectAccount':
        return (
          <SelectAccountStep
            accounts={wizard.accounts}
            importFiles={wizard.importFiles}
            isBulkImport={wizard.isBulkImport}
            fileName={wizard.fileName}
            parsedData={wizard.parsedData}
            selectedAccountId={wizard.selectedAccountId}
            setSelectedAccountId={(id) => wizard.setSelectedAccountId(id)}
            setFileAccountId={wizard.setFileAccountId}
            showCreateAccount={wizard.showCreateAccount}
            setShowCreateAccount={wizard.setShowCreateAccount}
            creatingForFileIndex={wizard.creatingForFileIndex}
            setCreatingForFileIndex={wizard.setCreatingForFileIndex}
            newAccountName={wizard.newAccountName}
            setNewAccountName={wizard.setNewAccountName}
            newAccountType={wizard.newAccountType}
            setNewAccountType={wizard.setNewAccountType}
            newAccountCurrency={wizard.newAccountCurrency}
            setNewAccountCurrency={wizard.setNewAccountCurrency}
            isCreatingAccount={wizard.isCreatingAccount}
            handleCreateAccount={wizard.handleCreateAccount}
            accountTypeOptions={wizard.accountTypeOptions}
            currencyOptions={wizard.currencyOptions}
            categoryMappings={wizard.categoryMappings}
            securityMappings={wizard.securityMappings}
            shouldShowMapAccounts={wizard.shouldShowMapAccounts}
            setStep={wizard.setStep}
          />
        );

      case 'mapCategories':
        return (
          <MapCategoriesStep
            categoryMappings={wizard.categoryMappings}
            setCategoryMappings={wizard.setCategoryMappings}
            categoryOptions={wizard.categoryOptions}
            parentCategoryOptions={wizard.parentCategoryOptions}
            accounts={wizard.accounts}
            scrollContainerRef={wizard.scrollContainerRef}
            formatCategoryPath={formatCategoryPath}
            securityMappings={wizard.securityMappings}
            shouldShowMapAccounts={wizard.shouldShowMapAccounts}
            setStep={wizard.setStep}
          />
        );

      case 'mapSecurities':
        return (
          <MapSecuritiesStep
            securityMappings={wizard.securityMappings}
            handleSecurityMappingChange={wizard.handleSecurityMappingChange}
            handleSecurityLookup={wizard.handleSecurityLookup}
            lookupLoadingIndex={wizard.lookupLoadingIndex}
            bulkLookupInProgress={wizard.bulkLookupInProgress}
            securityOptions={wizard.getSecurityOptions()}
            securityTypeOptions={wizard.securityTypeOptions}
            currencyOptions={wizard.currencyOptions}
            categoryMappings={wizard.categoryMappings}
            shouldShowMapAccounts={wizard.shouldShowMapAccounts}
            setStep={wizard.setStep}
            isMultiAccountImport={!!wizard.multiAccountData}
            isLoading={wizard.isLoading}
            onMultiAccountImport={wizard.handleMultiAccountImport}
            lookupPickerQuery={wizard.lookupPickerQuery}
            lookupPickerCandidates={wizard.lookupPickerCandidates}
            handleLookupPickerPick={wizard.handleLookupPickerPick}
            handleLookupPickerCancel={wizard.handleLookupPickerCancel}
          />
        );

      case 'mapAccounts':
        return (
          <MapAccountsStep
            accountMappings={wizard.accountMappings}
            handleAccountMappingChange={wizard.handleAccountMappingChange}
            accountOptions={wizard.getAccountOptions()}
            accountTypeOptions={wizard.accountTypeOptions}
            currencyOptions={wizard.currencyOptions}
            defaultCurrency={wizard.defaultCurrency}
            scrollContainerRef={wizard.scrollContainerRef}
            categoryMappings={wizard.categoryMappings}
            securityMappings={wizard.securityMappings}
            setStep={wizard.setStep}
          />
        );

      case 'review':
        return (
          <ReviewStep
            importFiles={wizard.importFiles}
            isBulkImport={wizard.isBulkImport}
            fileName={wizard.fileName}
            parsedData={wizard.parsedData}
            selectedAccountId={wizard.selectedAccountId}
            accounts={wizard.accounts}
            categoryMappings={wizard.categoryMappings}
            accountMappings={wizard.accountMappings}
            securityMappings={wizard.securityMappings}
            shouldShowMapAccounts={wizard.shouldShowMapAccounts}
            isLoading={wizard.isLoading}
            handleImport={wizard.handleImport}
            setStep={wizard.setStep}
          />
        );

      case 'multiAccountReview':
        return wizard.multiAccountData ? (
          <MultiAccountReviewStep
            multiAccountData={wizard.multiAccountData}
            currencyCode={wizard.multiAccountCurrency}
            onCurrencyChange={wizard.setMultiAccountCurrency}
            currencyOptions={wizard.currencyOptions}
            dateFormat={wizard.dateFormat}
            onDateFormatChange={(format) => wizard.setDateFormat(format)}
            isLoading={wizard.isLoading}
            onImport={wizard.handleMultiAccountImport}
            setStep={wizard.setStep}
            hasSecuritiesToMap={wizard.securityMappings.length > 0}
            accountTypeChoices={wizard.multiAccountTypeChoices}
            onAccountTypeChoiceChange={wizard.handleMultiAccountAccountTypeChange}
            accountTypeOptions={wizard.accountTypeOptions}
          />
        ) : null;

      case 'mnyReview':
        return wizard.mny.preview ? (
          <MnyReviewStep
            preview={wizard.mny.preview}
            excludedHandles={wizard.mny.excludedHandles}
            currencyOverrides={wizard.mny.currencyOverrides}
            selectedBillHandles={wizard.mny.selectedBillHandles}
            options={wizard.mny.options}
            currencyOptions={wizard.currencyOptions}
            isLoading={wizard.mny.isStarting}
            startError={wizard.mny.uploadError}
            onToggleAccount={wizard.mny.toggleAccount}
            onSetAllAccounts={wizard.mny.setAllAccounts}
            onSetAccountCurrency={wizard.mny.setAccountCurrency}
            onToggleBill={wizard.mny.toggleBill}
            onSetAllBills={wizard.mny.setAllBills}
            onSetOption={wizard.mny.setOption}
            onBack={wizard.handleMnyDone}
            onImport={wizard.handleMnyImportClick}
          />
        ) : null;

      case 'mnyImporting':
        // The same step covers running, failed and finished: the job row is the
        // single source of truth for which of the three the user is looking at.
        return wizard.mny.job?.status === 'completed' &&
          wizard.mny.job.result ? (
          <MnyVerificationReport
            result={wizard.mny.job.result}
            currencyCode={wizard.mny.preview?.baseCurrency ?? 'USD'}
            filename={wizard.mnyFileName}
            onDone={wizard.handleMnyDone}
          />
        ) : (
          <MnyImportProgress
            job={wizard.mny.job}
            isStarting={wizard.mny.isStarting}
            onRetry={wizard.mny.retry}
            onStartOver={wizard.handleMnyDone}
          />
        );

      case 'complete':
        return (
          <CompleteStep
            importFiles={wizard.importFiles}
            isBulkImport={wizard.isBulkImport}
            fileName={wizard.fileName}
            selectedAccountId={wizard.selectedAccountId}
            accounts={wizard.accounts}
            importResult={wizard.importResult}
            bulkImportResult={wizard.bulkImportResult}
            onImportMore={wizard.handleImportMore}
          />
        );
    }
  };

  return (
    <PageLayout>
      <MnyPasswordDialog
        isOpen={wizard.mny.passwordPrompt !== null}
        isRetry={wizard.mny.passwordPrompt?.retry ?? false}
        isLoading={wizard.mny.isUploading}
        onSubmit={wizard.handleMnyPasswordSubmit}
        onCancel={wizard.mny.cancelPasswordPrompt}
      />
      <MnyWipeConfirmDialog
        isOpen={wizard.showMnyWipeConfirm}
        isOidc={user?.authProvider === 'oidc'}
        isLoading={wizard.mny.isStarting}
        onConfirm={wizard.handleMnyWipeConfirm}
        onCancel={wizard.cancelMnyWipeConfirm}
      />
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('page.title')}
          subtitle={t('page.subtitle')}
          helpUrl={docsUrl('importTransactions')}
        />
        {/* Progress indicator */}
        <div className="mb-8">
          <div className="flex items-center justify-center space-x-4">
            {(() => {
              const stepOrder = ['upload', 'csvColumnMapping', 'selectAccount', 'mapCategories', 'mapSecurities', 'mapAccounts', 'review', 'multiAccountReview', 'complete'];
              const currentIndex = stepOrder.indexOf(wizard.step);

              // Filter to only visible steps
              const visibleSteps = stepOrder.filter((s) => {
                if (s === 'csvColumnMapping' && wizard.fileType !== 'csv') return false;
                if (s === 'mapCategories' && wizard.categoryMappings.length === 0) return false;
                if (s === 'mapSecurities' && wizard.securityMappings.length === 0) return false;
                if (s === 'mapAccounts' && !wizard.shouldShowMapAccounts) return false;
                if (s === 'multiAccountReview' && !wizard.multiAccountData) return false;
                if (wizard.multiAccountData && ['selectAccount', 'mapCategories', 'mapAccounts', 'review'].includes(s)) return false;
                if (wizard.multiAccountData && s === 'mapSecurities' && wizard.securityMappings.length === 0) return false;
                return true;
              });

              return visibleSteps.map((s, visibleIndex) => {
                const stepIndex = stepOrder.indexOf(s);
                const isActive = s === wizard.step;
                const isComplete = stepIndex < currentIndex;
                const isLastStep = visibleIndex === visibleSteps.length - 1;

                return (
                  <div key={s} className="flex items-center">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                        isComplete
                          ? 'bg-blue-600 text-white'
                          : isActive
                          ? 'bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400 border-2 border-blue-600'
                          : 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {isComplete ? (
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                          <path
                            fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                      ) : (
                        visibleIndex + 1
                      )}
                    </div>
                    {!isLastStep && (
                      <div
                        className={`w-12 h-1 ${
                          isComplete ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-700'
                        }`}
                      />
                    )}
                  </div>
                );
              });
            })()}
          </div>
        </div>

        {renderStep()}
      </main>
    </PageLayout>
  );
}
