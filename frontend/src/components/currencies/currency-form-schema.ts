import '@/lib/zodConfig';
import { z } from 'zod';
import { CURRENCY_KINDS } from '@/lib/currency-kind';
import { MONEY_SCALE } from '@/lib/format';
import { QUOTE_SYMBOL_MAX_LENGTH, quoteSymbolFiat } from '@/lib/crypto-quote-symbol';

/**
 * Decimal places a new coin starts at: eight, Bitcoin's and the money column
 * scale (`NUMERIC(24,8)`), the most the server accepts
 * (`docs/specs/money-precision.md` decision 2).
 */
export const CRYPTO_DEFAULT_DECIMAL_PLACES = 8;

/** The most decimal places a currency may carry: the money column scale. */
export const MAX_CURRENCY_DECIMAL_PLACES = MONEY_SCALE;

/** Decimal places a new fiat currency starts at before a lookup fills it. */
export const FIAT_DEFAULT_DECIMAL_PLACES = 2;

/**
 * The currency form's schema. `quoteSymbol` is the price symbol of a
 * cryptocurrency: empty is allowed (an unpriced coin), a value must be a
 * `<COIN>-<FIAT>` pair whose fiat leg is an ISO code, and a fiat currency
 * carries none, the same refusals the server makes
 * (`currencies.quoteSymbolNotAPair`, `currencies.quoteSymbolRequiresCrypto`).
 */
export const buildCurrencySchema = (t: (key: string) => string) =>
  z
    .object({
      code: z.string().length(3, t('validation.codeLength')),
      name: z.string().min(1, t('validation.nameRequired')).max(100, t('validation.nameMax')),
      symbol: z.string().min(1, t('validation.symbolRequired')).max(10, t('validation.symbolMax')),
      decimalPlaces: z.coerce.number().int().min(0).max(MAX_CURRENCY_DECIMAL_PLACES).default(FIAT_DEFAULT_DECIMAL_PLACES),
      kind: z.enum(CURRENCY_KINDS).default('FIAT'),
      quoteSymbol: z
        .string()
        .max(QUOTE_SYMBOL_MAX_LENGTH, t('validation.quoteSymbolMax'))
        .default(''),
    })
    .superRefine((data, ctx) => {
      const quote = data.quoteSymbol.trim();
      if (!quote) return;
      if (data.kind !== 'CRYPTO') {
        ctx.addIssue({
          code: 'custom',
          path: ['quoteSymbol'],
          message: t('validation.quoteSymbolRequiresCrypto'),
        });
        return;
      }
      if (!quoteSymbolFiat(quote)) {
        ctx.addIssue({
          code: 'custom',
          path: ['quoteSymbol'],
          message: t('validation.quoteSymbolNotAPair'),
        });
      }
    });

export type CurrencyFormData = z.infer<ReturnType<typeof buildCurrencySchema>>;
