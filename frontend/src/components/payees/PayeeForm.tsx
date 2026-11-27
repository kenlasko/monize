'use client';

import { useState, useRef, useMemo, useCallback, useEffect, MutableRefObject } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { Combobox } from '@/components/ui/Combobox';
import { Select } from '@/components/ui/Select';
import {
  Payee,
  ApplyCategoryToTransactions,
  ContactLookupField,
  ContactLookupReason,
  PayeeContactLookupContext,
  CONTACT_LOOKUP_FIELDS,
} from '@/types/payee';
import { Category } from '@/types/category';
import { buildCategoryPickerOptions } from '@/lib/categoryUtils';
import { payeesApi } from '@/lib/payees';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useContactLookupAvailable } from '@/hooks/useContactLookupAvailable';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';
import { PayeeAliasManager } from './PayeeAliasManager';
import {
  formatPhoneForDisplay,
  normalizePhoneNumber,
  phoneRegionFromPreferences,
} from '@/lib/phone-number';
import type { CountryCode } from 'libphonenumber-js/max';
import { categoryPickerIcon } from '@/components/categories/CategoryPickerIcon';

/**
 * Exported so the validation rules can be tested directly: `PayeeForm.test.tsx`
 * mocks `zodResolver` away (so its submit handlers see real field values), which
 * makes every rule in here invisible from that suite.
 */
export const buildPayeeSchema = (
  t: (key: string) => string,
  /**
   * Where a number typed without a country code belongs.
   *
   * Three states, not two. `null` is an ANSWER -- the user's preferences name
   * no region -- which makes a bare national number a question rather than a
   * rejection, see the phone rule below. `undefined` is "we do not know yet",
   * because the preferences this is derived from have not loaded, and there
   * the field must not check at all: substituting a default would have this
   * form reject a Berlin number the API stores happily.
   */
  phoneRegion: CountryCode | null | undefined,
  /**
   * The phone this payee already holds, as the field shows it. A value equal to
   * it is not an edit, and is waived below.
   */
  currentPhone?: string,
) => z.object({
  name: z.string().min(1, t('validation.nameRequired')).max(255),
  defaultCategoryId: z.string().optional(),
  notes: z.string().optional(),
  website: z.string().max(2048).optional(),
  address: z.string().max(500).optional(),
  // Refined rather than `.email().or(z.literal(''))`: an emptied field submits
  // "" and that is how a contact detail is cleared, so the blank has to pass --
  // but a union's error message is a generic "invalid input", which would put
  // the wrong text under the field. One predicate keeps both.
  email: z
    .string()
    .max(255)
    .optional()
    .refine((value) => !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), {
      message: t('validation.emailInvalid'),
    }),
  // Checked here rather than left to the server so the error lands under the
  // field, and checked by the SAME rules the server applies (both layers assert
  // `backend/src/common/phone-number-cases.json`) so this can neither block a
  // number the API would take nor pass one it would refuse. Refined rather than
  // a stricter type for the reason the email above is: an emptied field submits
  // "" and that is how a contact detail is cleared, so the blank has to pass.
  phone: z
    .string()
    .max(50)
    .optional()
    .superRefine((value, ctx) => {
      if (!value) return;
      // A resent value is not an edit -- the same rule the server applies, and
      // it has to be applied here too or the two disagree in the direction that
      // costs the user the most: rows written before normalization are not
      // backfilled, so a payee holding "call the shop" would be impossible to
      // rename from this form while the API would take the change happily.
      if (currentPhone !== undefined && value === currentPhone) return;
      // The region is not known yet, so neither is the answer. The server
      // reads the stored preferences and will say; guessing here is how this
      // field would come to block a number the API accepts.
      if (phoneRegion === undefined) return;
      const result = normalizePhoneNumber(value, phoneRegion);
      if (result.ok) return;
      ctx.addIssue({
        code: 'custom',
        message:
          result.reason === 'needs-country-code'
            ? t('validation.phoneNeedsCountryCode')
            : t('validation.phoneInvalid'),
      });
    }),
});

type PayeeFormData = z.infer<ReturnType<typeof buildPayeeSchema>>;

/** A name shorter than this is not worth a paid lookup on blur. */
const MIN_LOOKUP_NAME_LENGTH = 3;

/**
 * The form fields the lookup is given as context. Not the same list as the
 * fields it can fill: `notes` is context only, and nothing ever writes it.
 */
const LOOKUP_CONTEXT_FIELDS = ['website', 'address', 'email', 'phone', 'notes'] as const;

type LookupState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'done'; reason: ContactLookupReason; detail?: string };

export type PayeeFormSubmitData = PayeeFormData & {
  pendingAliases?: string[];
  applyCategoryToTransactions?: ApplyCategoryToTransactions;
};

interface PayeeFormProps {
  payee?: Payee;
  categories: Category[];
  onSubmit: (data: PayeeFormSubmitData) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

export function PayeeForm({ payee, categories, onSubmit, onCancel, onDirtyChange, submitRef }: PayeeFormProps) {
  const t = useTranslations('payees');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(payee?.defaultCategoryId || '');
  const [applyMode, setApplyMode] = useState<ApplyCategoryToTransactions>('none');
  const pendingAliasesRef = useRef<string[]>([]);

  // Where a number typed without a country code belongs. The same two
  // preferences the server reads, so the field and the API agree about which
  // numbers are placeable.
  //
  // The whole ROW, not two fields off it: `preferences` is null before the
  // fetch lands and stays null when it fails, and reading the fields
  // individually cannot tell that apart from a row that names no region. The
  // shared truth table proves the two layers' FUNCTIONS agree; it cannot prove
  // they were handed the same inputs, and this is where they would not be.
  const preferences = usePreferencesStore((s) => s.preferences);
  const phoneRegion = useMemo(
    () => (preferences ? phoneRegionFromPreferences(preferences) : undefined),
    [preferences],
  );
  // What the field starts with, so an untouched phone is waived above.
  const currentPhoneDisplay = formatPhoneForDisplay(payee?.phone);
  const schema = useMemo(
    () => buildPayeeSchema(t, phoneRegion, currentPhoneDisplay),
    [t, phoneRegion, currentPhoneDisplay],
  );

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    subscribe,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<PayeeFormData>({
    resolver: zodResolver(schema),
    defaultValues: payee
      ? {
          name: payee.name,
          defaultCategoryId: payee.defaultCategoryId || '',
          notes: payee.notes || '',
          website: payee.website || '',
          address: payee.address || '',
          email: payee.email || '',
          // Shown the way a person reads a number; the save re-normalizes it
          // to the same stored value, so displaying it does not make the form
          // dirty or rewrite the row.
          phone: formatPhoneForDisplay(payee.phone),
        }
      : {
          defaultCategoryId: '',
        },
  });

  useFormDirtyNotify(isDirty, onDirtyChange);

  // ─── contact lookup ───────────────────────────────────────────────────
  //
  // The lookup fills only fields that are still empty, and never persists:
  // the suggestions sit in the form until the user saves. A response belongs
  // to the request that produced it -- a newer name aborts the older request,
  // and an answer whose captured request is no longer the current one is
  // dropped rather than adopted.
  const lookupEnabled = usePreferencesStore(
    (s) => s.preferences?.payeeContactLookupEnabled ?? false,
  );
  // The lookup runs on the user's AI provider. With none configured there is
  // nothing behind the button, so it is not offered at all -- and the blur
  // never spends a request establishing that.
  const { available: lookupAvailable } = useContactLookupAvailable();
  const [lookupState, setLookupState] = useState<LookupState>({ status: 'idle' });
  const [suggestedFields, setSuggestedFields] = useState<ReadonlySet<ContactLookupField>>(
    () => new Set(),
  );
  // Fields the lookup *replaced*, against the value it replaced. A refinement
  // only reaches a field the user filled in themselves ("Toronto" becoming the
  // branch's full address), so the original is kept for the undo -- clearing it
  // to blank would lose what they typed.
  const [replacedFields, setReplacedFields] = useState<ReadonlySet<ContactLookupField>>(
    () => new Set(),
  );
  const suggestedRef = useRef<Set<ContactLookupField>>(new Set());
  const replacedRef = useRef<Map<ContactLookupField, string>>(new Map());
  const applyingRef = useRef(false);
  const lookupRef = useRef<{ name: string; controller: AbortController } | null>(null);
  const lastLookedUpNameRef = useRef('');

  /**
   * What the form already holds, sent with every lookup. It decides which
   * organisation and which of its locations the answer is about -- a payee
   * whose address reads "Toronto" must not come back with a branch in Sydney.
   */
  const collectContext = useCallback((): PayeeContactLookupContext => {
    const context: PayeeContactLookupContext = {};
    for (const field of LOOKUP_CONTEXT_FIELDS) {
      const value = (getValues(field) ?? '').trim();
      if (value) context[field] = value;
    }
    return context;
  }, [getValues]);

  const runLookup = useCallback(
    async (rawName: string, { force = false } = {}) => {
      const name = rawName.trim();
      if (name.length < MIN_LOOKUP_NAME_LENGTH) return;
      if (!force && name === lastLookedUpNameRef.current) return;
      lookupRef.current?.controller.abort();
      const request = { name, controller: new AbortController() };
      lookupRef.current = request;
      lastLookedUpNameRef.current = name;
      setLookupState({ status: 'searching' });

      let result;
      try {
        result = await payeesApi.lookupContact(
          name,
          collectContext(),
          request.controller.signal,
        );
      } catch {
        // An aborted request has already been superseded; anything else is a
        // failure the user must see as one, never as "nothing found".
        if (lookupRef.current !== request) return;
        lookupRef.current = null;
        setLookupState({ status: 'done', reason: 'failed' });
        return;
      }
      if (lookupRef.current !== request) return;
      lookupRef.current = null;

      // The form has the user right there, but the picker belongs to the
      // detail screen's confirmation dialogue: here the best match is applied
      // into the fields, where every value is visible and editable before Save.
      const [suggestion] = result.suggestions;
      if (result.reason !== 'ok' || !suggestion) {
        setLookupState({ status: 'done', reason: result.reason, detail: result.detail });
        return;
      }
      // Two different things happen to a field, and the user is told which.
      // An empty field is filled. A field they typed is *replaced* only when
      // the server says its answer refines that value -- a fuller address for
      // the place they named -- and the value they typed is kept for the undo.
      const refined = new Set(suggestion.refined);
      const filled = new Set<ContactLookupField>();
      const replaced = new Map<ContactLookupField, string>();
      applyingRef.current = true;
      try {
        for (const field of CONTACT_LOOKUP_FIELDS) {
          const value = suggestion[field];
          if (!value) continue;
          // A suggestion arrives in the STORED form, and this field shows the
          // read form -- the same thing `defaultValues` does above, so a phone
          // does not read one way when the payee loads and another when a
          // lookup fills it (`+442079460958;ext=12` is not a thing to put in
          // front of anyone). Comparing the two forms directly is the same bug
          // wearing a different hat: it reports a number that did not change as
          // a replaced value.
          const shown = field === 'phone' ? formatPhoneForDisplay(value) : value;
          const current = getValues(field) ?? '';
          if (!current) {
            setValue(field, shown, { shouldDirty: true });
            filled.add(field);
          } else if (refined.has(field) && current !== shown) {
            setValue(field, shown, { shouldDirty: true });
            // A second lookup replaces the first one's answer, so the value to
            // restore is still the one the user typed. An edit in between
            // clears the entry (the watcher below), and `current` is then
            // theirs again.
            replaced.set(field, replacedRef.current.get(field) ?? current);
          }
        }
      } finally {
        applyingRef.current = false;
      }
      suggestedRef.current = filled;
      replacedRef.current = replaced;
      setSuggestedFields(new Set(filled));
      setReplacedFields(new Set(replaced.keys()));
      setLookupState({
        status: 'done',
        reason: filled.size > 0 || replaced.size > 0 ? 'ok' : 'none',
      });
    },
    [collectContext, getValues, setValue],
  );

  // A field the user edits stops being a suggestion (or a replacement),
  // whatever they typed: the value is theirs again, and the undo must not put
  // the lookup's answer back over it.
  useEffect(() => {
    const unsubscribe = subscribe({
      formState: { values: true },
      callback: ({ name }) => {
        if (applyingRef.current || !name) return;
        const field = name as ContactLookupField;
        if (suggestedRef.current.has(field)) {
          suggestedRef.current.delete(field);
          setSuggestedFields(new Set(suggestedRef.current));
        }
        if (replacedRef.current.has(field)) {
          replacedRef.current.delete(field);
          setReplacedFields(new Set(replacedRef.current.keys()));
        }
      },
    });
    return () => unsubscribe();
  }, [subscribe]);

  useEffect(() => () => lookupRef.current?.controller.abort(), []);

  // Undo, not clear: a filled field goes back to empty and a replaced one goes
  // back to what the user typed. Emptying a replaced field would throw away
  // the very value that told the lookup where to look.
  const undoLookup = useCallback(() => {
    applyingRef.current = true;
    try {
      for (const field of suggestedRef.current) {
        setValue(field, '', { shouldDirty: true });
      }
      for (const [field, original] of replacedRef.current) {
        setValue(field, original, { shouldDirty: true });
      }
    } finally {
      applyingRef.current = false;
    }
    suggestedRef.current = new Set();
    replacedRef.current = new Map();
    setSuggestedFields(new Set());
    setReplacedFields(new Set());
    setLookupState({ status: 'idle' });
  }, [setValue]);

  const nameField = register('name');
  const handleNameBlur = useCallback(
    (event: React.FocusEvent<HTMLInputElement>) => {
      void nameField.onBlur(event);
      // Automatic only for a new payee, and only when the user opted in; an
      // existing payee's values are theirs, so a lookup there is the button.
      if (!payee && lookupEnabled && lookupAvailable) {
        void runLookup(event.target.value);
      }
    },
    [nameField, payee, lookupEnabled, lookupAvailable, runLookup],
  );

  const handleFormSubmit = useCallback((data: PayeeFormData) => {
    const submitData: PayeeFormSubmitData = { ...data };
    if (!payee && pendingAliasesRef.current.length > 0) {
      submitData.pendingAliases = pendingAliasesRef.current;
    }
    // Only carry the backfill instruction when editing an existing payee that
    // ends up with a default category and the user opted into applying it.
    if (payee && data.defaultCategoryId && applyMode !== 'none') {
      submitData.applyCategoryToTransactions = applyMode;
    }
    return onSubmit(submitData);
  }, [payee, onSubmit, applyMode]);

  const onFormSubmit = useCallback((e?: React.BaseSyntheticEvent) => {
    handleSubmit(handleFormSubmit)(e);
  }, [handleSubmit, handleFormSubmit]);

  useFormSubmitRef(submitRef, handleSubmit, handleFormSubmit);

  // A payee's default goes on ordinary rows, so it is Income or Expense only;
  // the server refuses a Transfer category here (INV-CATEGORY-001).
  const categoryOptions = useMemo(
    () =>
      buildCategoryPickerOptions(categories, 'category', (category, label) => ({
        value: category.id,
        label,
        icon: categoryPickerIcon(category),
      })),
    [categories],
  );

  const handleCategoryChange = (categoryId: string) => {
    setSelectedCategoryId(categoryId);
    setValue('defaultCategoryId', categoryId || '', { shouldDirty: true });
    // Clearing the category makes the backfill choice meaningless; reset it.
    if (!categoryId) {
      setApplyMode('none');
    }
  };

  // Counts for the backfill option labels. Transfers and split parents are
  // excluded by the backend, so "all" is an upper bound on what changes.
  const uncategorizedCount = payee?.uncategorizedCount ?? 0;
  const transactionCount = payee?.transactionCount ?? 0;
  const showApplyCategory =
    !!payee && !!selectedCategoryId && transactionCount > 0;
  const applyOptions = useMemo(
    () => [
      { value: 'none', label: t('form.applyCategoryNone') },
      {
        value: 'uncategorized',
        label: t('form.applyCategoryUncategorized', { count: uncategorizedCount }),
      },
      { value: 'all', label: t('form.applyCategoryAll', { count: transactionCount }) },
    ],
    [t, uncategorizedCount, transactionCount],
  );

  // Find display name for the initial category
  const defaultCategoryId = payee?.defaultCategoryId;
  const initialCategoryName = useMemo(() => {
    if (!defaultCategoryId) return '';
    const cat = categories.find(c => c.id === defaultCategoryId);
    if (!cat) return '';
    const parent = cat.parentId ? categories.find(c => c.id === cat.parentId) : null;
    return parent ? `${parent.name}: ${cat.name}` : cat.name;
  }, [defaultCategoryId, categories]);

  // noValidate on the form: the email and phone inputs keep their types so a
  // phone offers the right keyboard, but validation is this form's own -- the
  // browser's native bubble is unlocalized and, by blocking the submit event,
  // would stop react-hook-form reporting the real message.
  return (
    <form onSubmit={onFormSubmit} className="space-y-4" noValidate>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            label={t('form.nameLabel')}
            error={errors.name?.message}
            {...nameField}
            onBlur={handleNameBlur}
          />
        </div>
        {lookupAvailable && (
          <Button
            type="button"
            variant="outline"
            size="md"
            disabled={lookupState.status === 'searching'}
            onClick={() => void runLookup(getValues('name') ?? '', { force: true })}
          >
            {t('form.lookup.button')}
          </Button>
        )}
      </div>

      {lookupState.status === 'searching' && (
        <div
          className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400"
          role="status"
          aria-live="polite"
        >
          <LoadingSpinner size="sm" fullContainer={false} />
          <span>{t('form.lookup.searching')}</span>
        </div>
      )}
      {lookupState.status === 'done' &&
        lookupState.reason === 'ok' &&
        (suggestedFields.size > 0 || replacedFields.size > 0) && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            {suggestedFields.size > 0 && (
              <>
                <span>{t('form.lookup.suggested')}</span>
                {CONTACT_LOOKUP_FIELDS.filter((field) => suggestedFields.has(field)).map(
                  (field) => (
                    <Badge key={field} variant="blue">
                      {t(`form.${field}Label`)}
                    </Badge>
                  ),
                )}
              </>
            )}
            {/* Named separately: a field the user typed into has been changed,
                which is a different thing from an empty one being filled. */}
            {replacedFields.size > 0 && (
              <>
                <span>{t('form.lookup.replaced')}</span>
                {CONTACT_LOOKUP_FIELDS.filter((field) => replacedFields.has(field)).map(
                  (field) => (
                    <Badge key={field} variant="amber">
                      {t(`form.${field}Label`)}
                    </Badge>
                  ),
                )}
              </>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={undoLookup}>
              {t('form.lookup.clear')}
            </Button>
          </div>
        )}
      {lookupState.status === 'done' && lookupState.reason === 'none' && (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('form.lookup.nothingFound')}</p>
      )}
      {lookupState.status === 'done' && lookupState.reason === 'no_provider' && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t.rich('form.lookup.noProvider', {
            link: (chunks) => (
              <Link
                href="/settings#payee-lookup"
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                {chunks}
              </Link>
            ),
          })}
        </p>
      )}
      {/* Its own message, not "no provider": the repair is to wait out or
          raise the Google Places limit, which is a different screen and a
          different decision from configuring an AI provider. */}
      {lookupState.status === 'done' && lookupState.reason === 'quota_exceeded' && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t.rich('form.lookup.quotaExceeded', {
            link: (chunks) => (
              <Link
                href="/settings#payee-lookup"
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                {chunks}
              </Link>
            ),
          })}
        </p>
      )}
      {lookupState.status === 'done' && lookupState.reason === 'failed' && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {lookupState.detail ?? t('form.lookup.failed')}
        </p>
      )}

      <Combobox
        label={t('form.categoryLabel')}
        placeholder={t('selectCategoryPlaceholder')}
        options={categoryOptions}
        value={selectedCategoryId}
        initialDisplayValue={initialCategoryName}
        onChange={handleCategoryChange}
        error={errors.defaultCategoryId?.message}
      />

      {showApplyCategory && (
        <div>
          <Select
            label={t('form.applyCategoryLabel')}
            options={applyOptions}
            value={applyMode}
            onChange={(e) => setApplyMode(e.target.value as ApplyCategoryToTransactions)}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('form.applyCategoryHelp')}
          </p>
        </div>
      )}

      <Input
        label={t('form.notesLabel')}
        error={errors.notes?.message}
        {...register('notes')}
      />

      {/* Rendered as a link on the detail page, so the backend stores only an
          http(s) address and adds https to a bare domain. */}
      <div aria-busy={lookupState.status === 'searching'} className="space-y-4">
      <Input
        label={t('form.websiteLabel')}
        placeholder="starbucks.com"
        error={errors.website?.message}
        {...register('website')}
      />

      {/* Free text, and multi-line because that is how an address is written.
          Nothing geocodes it: the detail page hands the whole string to the
          reader's maps application, which takes a single query anyway. */}
      <div>
        <label
          htmlFor="payee-address"
          className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          {t('form.addressLabel')}
        </label>
        <textarea
          id="payee-address"
          rows={3}
          className="block w-full rounded-md border-gray-300 shadow-sm focus:outline-none focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:focus-visible:border-blue-400 dark:focus-visible:ring-blue-400"
          {...register('address')}
        />
        {errors.address && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">
            {errors.address.message}
          </p>
        )}
      </div>

      <Input
        label={t('form.emailLabel')}
        type="email"
        error={errors.email?.message}
        {...register('email')}
      />

      <Input
        label={t('form.phoneLabel')}
        type="tel"
        error={errors.phone?.message}
        {...register('phone')}
      />
      </div>

      {payee ? (
        <PayeeAliasManager payeeId={payee.id} />
      ) : (
        <PayeeAliasManager onPendingAliasesChange={(aliases) => { pendingAliasesRef.current = aliases; }} />
      )}

      <FormActions onCancel={onCancel} submitLabel={payee ? t('form.submitUpdate') : t('form.submitCreate')} isSubmitting={isSubmitting} />
    </form>
  );
}
