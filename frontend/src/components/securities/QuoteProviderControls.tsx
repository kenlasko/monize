'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import type { UseFormRegisterReturn } from 'react-hook-form';

export type QuoteProviderValue = 'yahoo' | 'msn' | 'lse' | 'deutsche_boerse' | 'html_table';
/** `html_table` reads a page the security names, so it cannot search. */
export type LookupProviderValue = 'auto' | Exclude<QuoteProviderValue, 'html_table'>;

const PROVIDER_OPTIONS = [
  { value: 'yahoo', labelKey: 'form.providers.yahoo' },
  { value: 'msn', labelKey: 'form.providers.msn' },
  { value: 'lse', labelKey: 'form.providers.lse' },
  { value: 'deutsche_boerse', labelKey: 'form.providers.deutsche_boerse' },
];

/** Providers a security can be priced by but that never search for one. */
const PRICE_ONLY_OPTIONS = [{ value: 'html_table', labelKey: 'form.providers.html_table' }];

/** The provider the symbol lookup asks; `auto` tries them in turn. */
export function LookupProviderSelect({
  value,
  onChange,
}: {
  value: LookupProviderValue;
  onChange: (value: LookupProviderValue) => void;
}) {
  const t = useTranslations('securities');
  return (
    <Select
      aria-label={t('form.lookupProviderAriaLabel')}
      options={[{ value: 'auto', labelKey: 'form.providers.auto' }, ...PROVIDER_OPTIONS].map(
        (o) => ({ value: o.value, label: t(o.labelKey) }),
      )}
      value={value}
      onChange={(e) => onChange(e.target.value as LookupProviderValue)}
      className="mb-[1px] w-24"
    />
  );
}

/** The per-security quote provider override, with the MSN configuration warning. */
export function QuoteProviderSelect({
  value,
  onChange,
  userDefaultProvider,
  msnReady,
  error,
}: {
  value: string;
  onChange: (value: QuoteProviderValue | '') => void;
  userDefaultProvider: string;
  msnReady: boolean | null;
  error?: string;
}) {
  const t = useTranslations('securities');
  return (
    <div>
      <Select
        label={t('form.quoteProviderLabel')}
        options={[
          {
            value: '',
            label: t('form.quoteProviderUseDefault', {
              provider: t(`form.providers.${userDefaultProvider}`),
            }),
          },
          ...[...PROVIDER_OPTIONS, ...PRICE_ONLY_OPTIONS].map((o) => ({
            value: o.value,
            label: t(o.labelKey),
          })),
        ]}
        value={value}
        onChange={(e) => onChange(e.target.value as QuoteProviderValue | '')}
        error={error}
      />
      {value === 'msn' && msnReady === false && (
        <p
          role="alert"
          className="text-sm text-red-600 dark:text-red-400 mt-2"
          data-testid="msn-not-configured-error"
        >
          {t('form.msnNotConfigured')}
        </p>
      )}
    </div>
  );
}

/** The MSN instrument id, shown only while MSN is the chosen provider. */
export function MsnInstrumentIdInput({
  registration,
  error,
}: {
  registration: UseFormRegisterReturn;
  error?: string;
}) {
  const t = useTranslations('securities');
  return (
    <Input
      label={t('form.msnIdLabel')}
      {...registration}
      error={error}
      placeholder={t('form.exchangePlaceholder')}
    />
  );
}
