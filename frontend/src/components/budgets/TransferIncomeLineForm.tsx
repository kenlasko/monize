'use client';

import { useTranslations } from 'next-intl';
import { useForm, Controller } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { FormActions } from '@/components/ui/FormActions';
import { Select } from '@/components/ui/Select';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { entryDecimalPlaces, getCurrencySymbol } from '@/lib/format';
import type { Account } from '@/types/account';
import type { CreateTransferIncomeLineData } from '@/types/budget';

const buildSchema = (t: (key: string) => string) =>
  z.object({
    transferAccountId: z.string().min(1, t('transferIncomeForm.accountRequired')),
    amount: z.number().min(0, t('categoryValidation.amountMin')),
  });

type TransferIncomeLineFormData = z.infer<ReturnType<typeof buildSchema>>;

interface TransferIncomeLineFormProps {
  /** The accounts a new line may name: the user's own, open, not yet in a transfer line. */
  accounts: Account[];
  currencyCode: string;
  onSave: (data: CreateTransferIncomeLineData) => Promise<void>;
  onCancel: () => void;
  isSaving?: boolean;
}

/**
 * Adds a transfer income line to a budget: money moved in from the chosen
 * account counts as income, less anything moved back to it (issue #2141).
 */
export function TransferIncomeLineForm({
  accounts,
  currencyCode,
  onSave,
  onCancel,
  isSaving = false,
}: TransferIncomeLineFormProps) {
  const t = useTranslations('budgets');
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<TransferIncomeLineFormData>({
    resolver: zodResolver(buildSchema(t)),
    defaultValues: { transferAccountId: '', amount: 0 },
  });

  const onSubmit = (data: TransferIncomeLineFormData) =>
    onSave({ transferAccountId: data.transferAccountId, amount: data.amount });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t('transferIncomeForm.hint')}
      </p>
      <Select
        label={t('transferIncomeForm.account')}
        {...register('transferAccountId')}
        error={errors.transferAccountId?.message}
        options={[
          { value: '', label: t('transferIncomeForm.accountPlaceholder') },
          ...accounts.map((a) => ({ value: a.id, label: a.name })),
        ]}
      />
      <Controller
        name="amount"
        control={control}
        render={({ field }) => (
          <CurrencyInput
            label={t('transferIncomeForm.amount')}
            value={field.value}
            onChange={(value) => field.onChange(value ?? 0)}
            onBlur={field.onBlur}
            allowNegative={false}
            decimalPlaces={entryDecimalPlaces(currencyCode)}
            prefix={getCurrencySymbol(currencyCode)}
            error={errors.amount?.message}
          />
        )}
      />
      <FormActions
        onCancel={onCancel}
        submitLabel={t('transferIncomeForm.submit')}
        isSubmitting={isSaving}
      />
    </form>
  );
}
