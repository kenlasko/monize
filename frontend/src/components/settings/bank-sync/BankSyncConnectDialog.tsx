'use client';

import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { bankSyncApi } from '@/lib/bank-sync';
import { consentDaysToShow } from '@/lib/bank-sync-consent';
import { buildBankSyncCountryOptions } from '@/lib/bank-sync-countries';
import { safeAuthorizationUrl } from '@/lib/bank-sync-redirect';
import { getErrorMessage } from '@/lib/errors';
import type { BankInstitution, BankSyncPsuType } from '@/types/bank-sync';

const PSU_TYPES: readonly BankSyncPsuType[] = ['personal', 'business'];

/**
 * The account-holder kinds a bank offers, in the order the select shows them.
 * A bank that lists none we recognise (or none at all) is offered both: the
 * server validates the pair, and a picker with no option is a dead end.
 */
function allowedPsuTypes(institution: BankInstitution | undefined): BankSyncPsuType[] {
  if (!institution) return [...PSU_TYPES];
  const offered = PSU_TYPES.filter((type) =>
    institution.psuTypes.some((value) => value.toLowerCase() === type),
  );
  return offered.length > 0 ? offered : [...PSU_TYPES];
}

interface BankSyncConnectDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Pick a country, then a bank, then send the browser to the bank to authorize.
 *
 * The institution list belongs to the country that asked for it: it is held
 * under its country and only read for the current selection, so a slow answer
 * for a country the user has already left cannot fill the picker for the one
 * they are on. A failed list is a failure with a retry, never an empty
 * list -- "the provider lists no banks" is a different sentence.
 *
 * The page renders this only while it is open, so closing it drops its state.
 */
export function BankSyncConnectDialog({
  isOpen,
  onClose,
}: BankSyncConnectDialogProps) {
  const t = useTranslations('settings.bankSync.connect');
  const locale = useLocale();
  const [country, setCountry] = useState('');
  // Answers and failures are held per country, so an answer that lands late
  // for a country the user has left is kept where it belongs instead of
  // replacing the one for the country they are on.
  const [loaded, setLoaded] = useState<Record<string, BankInstitution[]>>({});
  const [failed, setFailed] = useState<Record<string, true>>({});
  const [institutionName, setInstitutionName] = useState('');
  const [psuType, setPsuType] = useState<BankSyncPsuType>('personal');
  const [connecting, setConnecting] = useState(false);

  const countryOptions = useMemo(
    () => buildBankSyncCountryOptions(locale),
    [locale],
  );

  const institutions = loaded[country] ?? null;
  const loadFailed = country !== '' && failed[country] === true;
  const loading = country !== '' && institutions === null && !loadFailed;

  const institution = institutions?.find((item) => item.name === institutionName);
  // What the server will request, not what the bank would allow at most.
  const consentDays = consentDaysToShow(institution?.maximumConsentValidityDays);
  const psuOptions = allowedPsuTypes(institution);
  const effectivePsuType = psuOptions.includes(psuType) ? psuType : psuOptions[0];

  const loadInstitutions = (code: string) => {
    setFailed((previous) => {
      const { [code]: _cleared, ...rest } = previous;
      return rest;
    });
    bankSyncApi
      .listInstitutions(code)
      .then((list) => setLoaded((previous) => ({ ...previous, [code]: list })))
      .catch(() => setFailed((previous) => ({ ...previous, [code]: true })));
  };

  const handleCountryChange = (code: string) => {
    setCountry(code);
    setInstitutionName('');
    if (code !== '') loadInstitutions(code);
  };

  const handleContinue = async () => {
    if (!institution || connecting) return;
    setConnecting(true);
    try {
      const { authorizationUrl } = await bankSyncApi.createConnection({
        institutionName: institution.name,
        country,
        psuType: effectivePsuType,
      });
      const safeUrl = safeAuthorizationUrl(authorizationUrl);
      if (!safeUrl) {
        toast.error(t('unsafeUrl'));
        setConnecting(false);
        return;
      }
      // Leaves the app; `connecting` stays set so the button cannot fire twice.
      window.location.assign(safeUrl);
    } catch (error) {
      toast.error(getErrorMessage(error, t('failed')));
      setConnecting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('title')}
      description={t('subtitle')}
      padding="md"
      maxWidth="lg"
      pushHistory
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('whySecondAuthorization')}
        </p>
        <Select
          label={t('countryLabel')}
          id="bank-sync-country"
          value={country}
          onChange={(event) => handleCountryChange(event.target.value)}
          options={[
            { value: '', label: t('countryPlaceholder') },
            ...countryOptions,
          ]}
        />

        {loading && (
          <p className="text-sm text-gray-500 dark:text-gray-400" role="status">
            {t('institutionsLoading')}
          </p>
        )}

        {loadFailed && (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {t('institutionsFailed')}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => loadInstitutions(country)}
            >
              {t('retry')}
            </Button>
          </div>
        )}

        {institutions && institutions.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('noInstitutions')}
          </p>
        )}

        {institutions && institutions.length > 0 && (
          <Combobox
            label={t('institutionLabel')}
            placeholder={t('institutionPlaceholder')}
            options={institutions.map((item) => ({
              value: item.name,
              label: item.name,
            }))}
            value={institutionName}
            onChange={(value) => setInstitutionName(value)}
            usePortal
            openOnFocus={false}
          />
        )}

        {institution && (
          <>
            <Select
              label={t('psuTypeLabel')}
              id="bank-sync-psu-type"
              value={effectivePsuType}
              onChange={(event) =>
                setPsuType(event.target.value as BankSyncPsuType)
              }
              options={psuOptions.map((type) => ({
                value: type,
                label: type === 'personal' ? t('psuPersonal') : t('psuBusiness'),
              }))}
            />
            {consentDays !== null && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t('consentDays', { days: consentDays })}
              </p>
            )}
          </>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            onClick={handleContinue}
            disabled={!institution || connecting}
          >
            {connecting ? t('continuing') : t('continue')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
