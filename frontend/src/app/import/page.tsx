'use client';

import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { UploadStep } from '@/components/import/UploadStep';
import { SelectAccountStep } from '@/components/import/SelectAccountStep';
import { MapCategoriesStep } from '@/components/import/MapCategoriesStep';
import { MapSecuritiesStep } from '@/components/import/MapSecuritiesStep';
import { MapAccountsStep } from '@/components/import/MapAccountsStep';
import { ReviewStep } from '@/components/import/ReviewStep';
import { CompleteStep } from '@/components/import/CompleteStep';
import { useImportWizard } from '@/hooks/useImportWizard';
import { formatCategoryPath } from './import-utils';

export default function ImportPage() {
  return (
    <ProtectedRoute>
      <ImportContent />
    </ProtectedRoute>
  );
}

function ImportContent() {
  const wizard = useImportWizard();

  const renderStep = () => {
    switch (wizard.step) {
      case 'upload':
        return (
          <UploadStep
            preselectedAccount={wizard.preselectedAccount}
            isLoading={wizard.isLoading}
            onFileSelect={wizard.handleFileSelect}
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
            categoryMappings={wizard.categoryMappings}
            shouldShowMapAccounts={wizard.shouldShowMapAccounts}
            setStep={wizard.setStep}
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
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title="Import Transactions"
          subtitle="Import transactions from a QIF file"
        />
        {/* Progress indicator */}
        <div className="mb-8">
          <div className="flex items-center justify-center space-x-4">
            {(() => {
              const stepOrder = ['upload', 'selectAccount', 'mapCategories', 'mapSecurities', 'mapAccounts', 'review', 'complete'];
              const currentIndex = stepOrder.indexOf(wizard.step);

              // Filter to only visible steps
              const visibleSteps = stepOrder.filter((s) => {
                if (s === 'mapCategories' && wizard.categoryMappings.length === 0) return false;
                if (s === 'mapSecurities' && wizard.securityMappings.length === 0) return false;
                if (s === 'mapAccounts' && !wizard.shouldShowMapAccounts) return false;
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
