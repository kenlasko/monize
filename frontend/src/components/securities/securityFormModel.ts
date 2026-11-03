import { z } from 'zod';
import type { AllocationRow } from './AllocationEditor';

// Map stored weightings (decimal 0-1) to editor rows (percentage strings).
export const toAllocationRows = (
  weightings: { name: string; weight: number }[] | null | undefined,
): AllocationRow[] =>
  (weightings ?? [])
    // An "Other" bucket isn't a real slice: don't surface it as a row --
    // it's folded into the editor's computed (100 - total) "Other" remainder.
    .filter((w) => (w.name ?? '').trim().toLowerCase() !== 'other')
    .map((w) => ({
      name: w.name,
      weight: String(Math.round(w.weight * 1000000) / 10000),
    }));

// Editor rows -> API slices: trim names, drop blank/zero rows. Weights stay in
// percentage units here; the caller converts to the stored decimal 0-1 form.
export const toAllocationSlices = (rows: AllocationRow[]) =>
  rows
    .map((row) => ({ name: row.name.trim(), weight: parseFloat(row.weight) }))
    .filter(
      (row) => row.name !== '' && Number.isFinite(row.weight) && row.weight > 0,
    );

export const buildSecuritySchema = (t: (key: string) => string) => z.object({
  symbol: z.string().min(1, t('validation.symbolRequired')).max(20, t('validation.symbolMax')),
  name: z.string().min(1, t('validation.nameRequired')).max(255, t('validation.nameMax')),
  securityType: z.string().optional(),
  exchange: z.string().optional(),
  currencyCode: z.string().min(1, t('validation.currencyRequired')),
  description: z.string().max(5000, t('validation.descriptionMax')).optional(),
  website: z.string().max(2048).optional(),
  irWebsite: z.string().max(2048).optional(),
  quoteProvider: z.enum(['', 'yahoo', 'msn', 'lse', 'deutsche_boerse', 'html_table']).optional(),
  quoteUrl: z.string().max(2048).optional(),
  msnInstrumentId: z.string().max(50).optional(),
  // A bond catalog program id, or '' for "not linked".
  bondProgramId: z.string().optional(),
  // Fetch every new series of the linked program automatically.
  bondAutoFetch: z.boolean().optional(),
  priceChartEnabled: z.boolean().optional(),
  skipPriceUpdates: z.boolean().optional(),
  priceAlertPercent: z.string().optional().refine((v) => !v?.trim() || (Number.isFinite(Number(v)) && Number(v) >= 0.1 && Number(v) <= 1000), t('priceAlert.range')),
  isFavourite: z.boolean().optional(),
}).superRefine((data, ctx) => {
  // The page is what this provider reads: without one it has nothing to price from.
  if (data.quoteProvider !== 'html_table') return;
  const url = data.quoteUrl?.trim() ?? '';
  if (!url) {
    ctx.addIssue({ code: 'custom', path: ['quoteUrl'], message: t('validation.quoteUrlRequired') });
  } else if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(url)) {
    ctx.addIssue({ code: 'custom', path: ['quoteUrl'], message: t('validation.quoteUrlInvalid') });
  }
});

export type SecurityFormData = z.infer<ReturnType<typeof buildSecuritySchema>>;

/**
 * The values to validate, given whether the quote provider control is shown.
 * A listed bond hides it (the engine prices the bond), so a web-page provider
 * chosen before the type changed is not validated: its page address field is
 * hidden too, and a rule on a field nobody can see blocks the save with no
 * reason on screen.
 */
export function valuesToValidate(
  values: SecurityFormData,
  providerShown: boolean,
): SecurityFormData {
  return !providerShown && values.quoteProvider === 'html_table'
    ? { ...values, quoteProvider: '' }
    : values;
}

