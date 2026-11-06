"use client";

import { useLayoutEffect, useMemo, useState, type MutableRefObject } from "react";
import { useFormDirtyNotify } from "@/hooks/useFormDirtyNotify";
import { flushSync } from "react-dom";
import { useTranslations } from "next-intl";
import { useForm, useWatch, Resolver } from "react-hook-form";
import "@/lib/zodConfig";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import toast from "react-hot-toast";
import { Input } from "@/components/ui/Input";
import { NumericInput } from "@/components/ui/NumericInput";
import { CurrencyInput } from "@/components/ui/CurrencyInput";
import { Select } from "@/components/ui/Select";
import { MultiSelect } from "@/components/ui/MultiSelect";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { FormActions } from "@/components/ui/FormActions";
import { Skeleton } from "@/components/ui/LoadingSkeleton";
import { ReportError } from "@/components/reports/ReportError";
import { SecurityForm } from "@/components/securities/SecurityForm";
import { securityFormModalProps } from "@/components/securities/security-form-modal";
import { PlusIcon, SparklesIcon } from "@heroicons/react/24/outline";
import { useReportData } from "@/hooks/useReportData";
import { useDateFormat } from "@/hooks/useDateFormat";
import { accountsApi } from "@/lib/accounts";
import { investmentsApi } from "@/lib/investments";
import { gemStrategyApi } from "@/lib/gem-strategy";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { GEM_ROLE_ORDER } from "@/lib/gem-strategy-view";
import {
  GEM_DEFAULT_SUGGESTION_REGION,
  GEM_SUGGESTED_SECURITIES,
  GEM_SUGGESTION_REGIONS,
  GemSuggestedSecurity,
  GemSuggestionRegion,
  suggestionsForRole,
  symbolKey,
} from "@/lib/gem-suggested-securities";
import { TOUR_ANCHORS, tourAnchor } from "@/lib/tours/anchors";
import { CreateSecurityData, Security } from "@/types/investment";
import {
  GemAssetRef,
  GemAssetRole,
  GemRange,
  GemStrategyMeta,
  GemStrategyReport,
} from "@/types/gem-strategy";
import { GemCard, GemStatRow, GemUnknown } from "./GemPrimitives";
import { GemInstrumentSelect } from "./GemInstrumentSelect";
import { useGemLabels } from "./useGemLabels";

const logger = createLogger("GemSettingsForm");

/**
 * Empty-string selects and blank number fields mean "not set", which the API
 * expresses as null. Numbers stay optional so clearing a cost assumption is
 * possible without inventing a zero -- `undefined` rather than `''`, because
 * the numeric fields are `NumericInput`/`CurrencyInput`, which speak numbers.
 */
const configSchema = z.object({
  accountIds: z.array(z.string()),
  cadence: z.enum(["MONTHLY", "QUARTERLY"]),
  lookbackMonths: z.coerce.number().int().min(1).max(60),
  taxRatePercent: z.coerce.number().min(0).max(100).optional(),
  commissionAmount: z.coerce.number().min(0).optional(),
  rulesSourceUrl: z.string().max(500),
  rulesSourceLabel: z.string().max(100),
  US_EQUITY: z.string(),
  EX_US_EQUITY: z.string(),
  EM_EQUITY: z.string(),
  SAFE: z.string(),
  RISK_FREE: z.string(),
});

type ConfigFormValues = z.infer<typeof configSchema>;

/** Blank number field -> null (unknown), a filled one -> the number. */
function optionalNumber(value: number | undefined): number | null {
  return value === undefined || Number.isNaN(value) ? null : Number(value);
}

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface GemSettingsFormProps {
  strategy: GemStrategyMeta;
  /** Current role assignments, in strategy order. */
  assets: GemAssetRef[];
  /** Range the page is showing, so the refreshed report comes back matching. */
  range: GemRange;
  /** Receives the refreshed report the save returns. */
  onSaved: (report: GemStrategyReport) => void;
  /**
   * Told when the form gains or loses unsaved edits.
   *
   * The parent owns the tab, scenario and delete controls, and each of those
   * unmounts this form. Without the signal there is nothing for them to ask
   * about, and the edits go silently.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Filled with a submitter so the unsaved-changes dialog's "save" can run
   * this form without the parent reaching into react-hook-form.
   */
  submitRef?: MutableRefObject<(() => void) | null>;
  /**
   * Told when a save starts and when it ends.
   *
   * The parent owns the scenario and range controls, and a save is scoped to
   * the pair that was selected when it began. Without this the form's save was
   * invisible from up there, so a response for scenario A could land after the
   * user had moved to B and be adopted as B's report.
   */
  onSavingChange?: (saving: boolean) => void;
  /**
   * Told when a submit was rejected by client-side validation, so it never
   * reached the server.
   *
   * The parent's unsaved-changes dialog answers "Save" by arming the action
   * the user was interrupted mid-way through -- a tab change, a scenario
   * switch, a *deletion* -- and running this form's submitter. A submit that
   * fails validation never calls `onSubmit`, so nothing cleared that armed
   * action: it sat there and fired against whatever the next successful save
   * happened to be, which for a delete means removing a scenario the user had
   * stopped asking to remove.
   */
  onInvalidSubmit?: () => void;
}

/**
 * "Settings" tab: the strategy configuration, editable. Assigning an instrument
 * to each role is what turns the report from its unconfigured state into a live
 * signal, so this is the form that gets a new strategy running.
 */
export function GemSettingsForm({
  strategy,
  assets,
  range,
  onSaved,
  onDirtyChange,
  submitRef,
  onSavingChange,
  onInvalidSubmit,
}: GemSettingsFormProps) {
  const t = useTranslations("strategies");
  const { roleLabel, roleDescription } = useGemLabels();
  const { formatDate } = useDateFormat();
  const [isSaving, setIsSaving] = useState(false);
  // Role whose "add instrument" modal is open, and the securities created
  // through it -- appended locally so the new one can be picked straight away
  // without re-fetching the whole list.
  const [creatingFor, setCreatingFor] = useState<{
    role: GemAssetRole;
    suggestion?: GemSuggestedSecurity;
  } | null>(null);
  const [isFillingRoles, setIsFillingRoles] = useState(false);
  const [createdSecurities, setCreatedSecurities] = useState<Security[]>([]);

  // Investment accounts and securities are the two pick-lists the form needs.
  const {
    data: lookups,
    isLoading,
    error: lookupError,
    reload: reloadLookups,
  } = useReportData(async () => {
    const [accounts, securities] = await Promise.all([
      accountsApi.getAll(),
      // Deactivated instruments included. They are not offered in the
      // pick-list, but they still hold their symbol against the server's
      // uniqueness check, so leaving them out made "you already have this"
      // answer no for an instrument that cannot be created again.
      investmentsApi.getSecurities(true),
    ]);
    return { accounts, securities };
  }, []);

  const data = lookups;

  const assetBySecurity = useMemo(
    () => new Map(assets.map((asset) => [asset.role, asset.securityId ?? ""])),
    [assets],
  );

  const {
    register,
    handleSubmit,
    setValue,
    control,
    reset,
    formState: { errors, isDirty },
  } = useForm<ConfigFormValues>({
    // The coercing schema's input and output types differ; the project's
    // convention is to type the resolver by the form's value shape.
    resolver: zodResolver(configSchema) as Resolver<ConfigFormValues>,
    defaultValues: {
      accountIds: strategy.accounts.map((account) => account.id),
      cadence: strategy.cadence,
      lookbackMonths: strategy.lookbackMonths,
      taxRatePercent: strategy.taxRatePercent ?? undefined,
      commissionAmount: strategy.commissionAmount ?? undefined,
      rulesSourceUrl: strategy.rulesSourceUrl ?? "",
      rulesSourceLabel: strategy.rulesSourceLabel ?? "",
      US_EQUITY: assetBySecurity.get("US_EQUITY") ?? "",
      EX_US_EQUITY: assetBySecurity.get("EX_US_EQUITY") ?? "",
      EM_EQUITY: assetBySecurity.get("EM_EQUITY") ?? "",
      SAFE: assetBySecurity.get("SAFE") ?? "",
      RISK_FREE: assetBySecurity.get("RISK_FREE") ?? "",
    },
  });

  const accountOptions = useMemo(() => {
    const investmentAccounts = (data?.accounts ?? []).filter(
      (account) =>
        account.accountType === "INVESTMENT" &&
        // The cash half of a brokerage pair holds no securities.
        account.accountSubType !== "INVESTMENT_CASH",
    );
    return investmentAccounts.map((account) => ({
      value: account.id,
      label: `${account.name} (${account.currencyCode})`,
    }));
  }, [data?.accounts]);

  // MultiSelect and the numeric inputs are controlled, so their values are read
  // back through the form state rather than from a DOM value.
  const selectedAccountIds = useWatch({ control, name: "accountIds" });
  const watchedLookback = useWatch({ control, name: "lookbackMonths" });
  const watchedTaxRatePercent = useWatch({ control, name: "taxRatePercent" });
  const watchedCommissionAmount = useWatch({ control, name: "commissionAmount" });

  // Watching the role selects keeps the "fill the missing roles" prompt in step
  // with what is still unassigned, including roles just filled in.
  const roleValues = useWatch({ control, name: GEM_ROLE_ORDER });
  const assignedRoles = new Map(
    GEM_ROLE_ORDER.map((role, index) => [role, roleValues[index]]),
  );
  /**
   * Which listings the one-click fill uses.
   *
   * The button has to commit to one region -- the same index is a different
   * fund in New York and in London -- and it used to commit to the US listings
   * for everyone, silently. A European broker cannot buy any of them, so the
   * one action that exists to spare a new user five trips through the create
   * form left them with five instruments they cannot trade. The choice is
   * theirs to make, defaulted to the listings the strategy's own literature is
   * written against.
   */
  const [fillRegion, setFillRegion] = useState<GemSuggestionRegion>(
    GEM_DEFAULT_SUGGESTION_REGION,
  );
  const missingRoles = GEM_SUGGESTED_SECURITIES.filter(
    (suggestion) =>
      suggestion.region === fillRegion && !assignedRoles.get(suggestion.role),
  );

  // Instruments the list has to offer even when they are deactivated: the one a
  // role already points at (dropping it would silently clear the role on save)
  // and anything picked during this session. Everything else is active-only.
  const pickableInactiveIds = useMemo(
    () =>
      new Set(
        [
          ...assets.map((asset) => asset.securityId),
          ...createdSecurities.map((security) => security.id),
        ].filter((id): id is string => !!id),
      ),
    [assets, createdSecurities],
  );

  const pickableSecurities = useMemo(() => {
    const byId = new Map<string, Security>();
    for (const security of [
      ...(data?.securities ?? []),
      ...createdSecurities,
    ]) {
      byId.set(security.id, security);
    }
    return [...byId.values()].filter(
      (security) =>
        security.isActive !== false || pickableInactiveIds.has(security.id),
    );
  }, [data?.securities, createdSecurities, pickableInactiveIds]);

  /**
   * Every instrument the user holds, by symbol -- deactivated ones included.
   *
   * This is the "do I already have it" question, and it is answered with the
   * server's own rule: one security per symbol per user. Anything narrower
   * offers the user a create the server will refuse (see `symbolKey`).
   */
  const ownedBySymbol = useMemo(() => {
    const bySymbol = new Map<string, Security>();
    for (const security of [
      ...(data?.securities ?? []),
      ...createdSecurities,
    ]) {
      bySymbol.set(symbolKey(security), security);
    }
    return bySymbol;
  }, [data?.securities, createdSecurities]);

  /**
   * Assign an instrument to a role, making it selectable first when it is one
   * the pick-list does not offer -- a deactivated instrument reached through
   * its suggestion. Without that the role is set to an id the trigger cannot
   * resolve, and the field reads "No instrument" over a real assignment.
   */
  const assignToRole = (role: GemAssetRole, securityId: string) => {
    const chosen = securityId
      ? (data?.securities ?? []).find(
          (security) => security.id === securityId,
        )
      : undefined;
    if (chosen && !pickableSecurities.some((s) => s.id === chosen.id)) {
      flushSync(() => setCreatedSecurities((previous) => [...previous, chosen]));
    }
    setValue(role, securityId, { shouldDirty: true });
  };

  /**
   * Currencies the assigned instruments are priced in. More than one means the
   * strategy converts on every switch, which the roles card warns about: the
   * conversion is a real cost the momentum figures do not carry.
   */
  const currencyById = new Map(
    pickableSecurities.map((security) => [security.id, security.currencyCode]),
  );
  const assignedCurrencies = [
    ...new Set(
      GEM_ROLE_ORDER.map((role) => assignedRoles.get(role))
        .filter((id): id is string => !!id)
        .map((id) => currencyById.get(id))
        .filter((code): code is string => !!code),
    ),
  ].sort();

  /**
   * Create a security from the role's "add instrument" modal and assign it to
   * that role. Nothing else on the page changes until the configuration is
   * saved, so the user can still review the pick.
   */
  const handleSecurityCreated = async (values: CreateSecurityData) => {
    const role = creatingFor?.role;
    if (!role) return;
    try {
      const created = await investmentsApi.createSecurity(values);
      // The picker renders the assignment by looking the id up in this list, so
      // the new instrument has to be in it before the value is written.
      flushSync(() =>
        setCreatedSecurities((previous) => [...previous, created]),
      );
      setValue(role, created.id, { shouldDirty: true });
      setCreatingFor(null);
      toast.success(
        t("gem.settingsForm.instrumentCreated", { symbol: created.symbol }),
      );
    } catch (error) {
      logger.error("Failed to create a security for a GEM role:", error);
      toast.error(
        getErrorMessage(error, t("gem.settingsForm.instrumentCreateError")),
      );
      throw error;
    }
  };

  /**
   * One click for a portfolio that has never held a GEM instrument: fill every
   * unassigned role with its suggested ETF. A security the user already owns is
   * reused rather than duplicated, and nothing is saved until the user reviews
   * the picks and submits the form.
   */
  const handleFillMissingRoles = async () => {
    const owned = ownedBySymbol;
    const missing = missingRoles;
    if (missing.length === 0) return;

    setIsFillingRoles(true);
    const filled: Array<{ role: GemAssetRole; security: Security }> = [];
    // Instruments the pick-list does not offer yet: the ones just created, and
    // any deactivated one being reused (the symbol is taken, so creating it
    // again would be rejected -- it has to become selectable instead).
    const pickable: Security[] = [];
    try {
      for (const { role, region: _region, ...values } of missing) {
        // Owned means the symbol is taken, which is the only sense in which
        // Monize can hold the same instrument twice -- it cannot. Reusing it
        // is not an approximation of creating it; creating it is impossible,
        // and asking anyway is what made this button fail with "Security with
        // symbol EXUS already exists" on a portfolio that had EXUS.
        const existing = owned.get(symbolKey(values));
        const security =
          existing ?? (await investmentsApi.createSecurity(values));
        if (!existing || security.isActive === false) pickable.push(security);
        filled.push({ role, security });
      }
      toast.success(
        t("gem.settingsForm.fillMissingDone", { count: filled.length }),
      );
    } catch (error) {
      logger.error("Failed to add the suggested GEM instruments:", error);
      toast.error(
        getErrorMessage(error, t("gem.settingsForm.fillMissingError")),
      );
    } finally {
      // Whatever was created before a failure is already on the server, so
      // assign it: retrying then reuses those instruments instead of adding
      // the same symbol a second time.
      if (pickable.length > 0) {
        // Same reason as the single-role modal: the <option> has to exist
        // before the registered select can be given its value.
        flushSync(() =>
          setCreatedSecurities((previous) => [...previous, ...pickable]),
        );
      }
      for (const { role, security } of filled) {
        setValue(role, security.id, { shouldDirty: true });
      }
      setIsFillingRoles(false);
    }
  };

  // Reported up so the parent can guard the controls that unmount this form.
  useFormDirtyNotify(isDirty, onDirtyChange);

  const onSubmit = async (values: ConfigFormValues) => {
    setIsSaving(true);
    onSavingChange?.(true);
    try {
      const report = await gemStrategyApi.updateConfig(
        {
          accountIds: values.accountIds,
          cadence: values.cadence,
          lookbackMonths: Number(values.lookbackMonths),
          taxRatePercent: optionalNumber(values.taxRatePercent),
          commissionAmount: optionalNumber(values.commissionAmount),
          rulesSourceUrl: optionalText(values.rulesSourceUrl),
          rulesSourceLabel: optionalText(values.rulesSourceLabel),
          assets: GEM_ROLE_ORDER.map((role) => ({
            role,
            securityId: values[role as keyof ConfigFormValues]
              ? String(values[role as keyof ConfigFormValues])
              : null,
          })),
        },
        range,
        // Naming the scenario is what keeps the save on the one being edited:
        // omitted, the server falls back to the user's oldest -- which is also
        // what the first save needs, because there is no scenario to name yet.
        strategy.id ?? undefined,
      );
      toast.success(t("gem.settingsForm.saved"));
      // The saved values are the new baseline. Without this the form stays
      // dirty for the rest of its life: react-hook-form compares against the
      // mount-time defaults, and the key is the scenario id, which a save does
      // not change -- so every later tab, scenario or delete asked to discard
      // edits that had already been written.
      reset(values);
      onSaved(report);
    } catch (error) {
      logger.error("Failed to save the GEM strategy configuration:", error);
      toast.error(getErrorMessage(error, t("gem.settingsForm.saveError")));
    } finally {
      setIsSaving(false);
      onSavingChange?.(false);
    }
  };

  /**
   * The submit the dialog's "Save" runs, and the branch it takes when the
   * form refuses.
   *
   * `handleSubmit(onSubmit)` with no second argument silently does nothing on
   * an invalid form -- correct for a form, wrong for a caller that has staged
   * an action behind the save and is waiting to be told which way it went.
   * The errors stay on screen either way; what changes is that the parent now
   * hears about it and can disarm.
   */
  const submitOrReport = handleSubmit(onSubmit, () => onInvalidSubmit?.());

  // Handed to the parent so the unsaved-changes dialog's "save" runs this
  // form, rather than the parent reaching into react-hook-form itself. Kept
  // pointing at this render's submit after commit, never written during render,
  // and only once the form itself is on screen.
  const formShown = !isLoading && !lookupError && !!lookups;
  useLayoutEffect(() => {
    if (submitRef && formShown) submitRef.current = submitOrReport;
  });

  if (isLoading) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  /**
   * A failed lookup is not an empty pick-list.
   *
   * Rendering the form over `[]` offers no accounts and no instruments and
   * leaves Save live above them, so a request that never arrived reads as a
   * user with nothing to choose -- and one click writes an empty selection
   * over a configured strategy. Loaded-and-empty, loading, failed,
   * stale-previous and current are five states, and this is the failed one.
   */
  if (lookupError || !lookups) {
    return (
      <ReportError
        message={t("gem.settingsForm.lookupsError")}
        onRetry={reloadLookups}
      />
    );
  }

  return (
    <>
      <form onSubmit={submitOrReport} noValidate>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <GemCard title={t("gem.settings.generalTitle")}>
            <div className="space-y-3">
              <div {...tourAnchor(TOUR_ANCHORS.gemSettingsAccounts)}>
                <MultiSelect
                  label={t("gem.settings.accounts")}
                  // The visible label is not tied to the trigger button, so name
                  // it explicitly for screen readers and keyboard users.
                  ariaLabel={t("gem.settings.accounts")}
                  options={accountOptions}
                  value={selectedAccountIds}
                  onChange={(ids) =>
                    setValue("accountIds", ids, { shouldDirty: true })
                  }
                  placeholder={t("gem.settingsForm.noAccount")}
                  error={errors.accountIds?.message}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t("gem.settingsForm.accountsHint")}
                </p>
              </div>
              {/* Cadence, momentum window and the two cost inputs share one
                wrapper so a guided tour can explain "how far GEM looks back,
                and what a switch costs" in a single step. It repeats the
                parent's `space-y-3`, so the spacing is unchanged. */}
              <div
                className="space-y-3"
                {...tourAnchor(TOUR_ANCHORS.gemSettingsTimingAndCosts)}
              >
                <Select
                  label={t("gem.settings.cadence")}
                  options={[
                    { value: "MONTHLY", label: t("gem.cadences.MONTHLY") },
                    { value: "QUARTERLY", label: t("gem.cadences.QUARTERLY") },
                  ]}
                  error={errors.cadence?.message}
                  {...register("cadence")}
                />
                {/* Numbers go through the shared inputs rather than a raw numeric
                  one: no spinner arrows, no scroll-wheel edits, and the money
                  field gets the formatting and calculator the rest of the app
                  has. */}
                <NumericInput
                  label={t("gem.settingsForm.lookbackMonths")}
                  value={watchedLookback || undefined}
                  onChange={(value) =>
                    // Clearing a required field has to fail validation rather than
                    // quietly keep the previous number.
                    setValue("lookbackMonths", value ?? Number.NaN, {
                      shouldDirty: true,
                      shouldValidate: true,
                    })
                  }
                  decimalPlaces={0}
                  min={1}
                  error={errors.lookbackMonths?.message}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <NumericInput
                    label={t("gem.settingsForm.taxRatePercent")}
                    suffix="%"
                    value={watchedTaxRatePercent}
                    onChange={(value) =>
                      setValue("taxRatePercent", value, {
                        shouldDirty: true,
                        shouldValidate: true,
                      })
                    }
                    decimalPlaces={2}
                    min={0}
                    error={errors.taxRatePercent?.message}
                  />
                  <CurrencyInput
                    label={t("gem.settingsForm.commissionAmount")}
                    value={watchedCommissionAmount}
                    onChange={(value) =>
                      setValue("commissionAmount", value, {
                        shouldDirty: true,
                        shouldValidate: true,
                      })
                    }
                    allowNegative={false}
                    error={errors.commissionAmount?.message}
                  />
                </div>
              </div>
              <Input
                label={t("gem.settingsForm.rulesSourceUrl")}
                placeholder={t("gem.settingsForm.rulesSourceUrlPlaceholder")}
                error={errors.rulesSourceUrl?.message}
                {...register("rulesSourceUrl")}
              />
              <Input
                label={t("gem.settingsForm.rulesSourceLabel")}
                placeholder={t("gem.settingsForm.rulesSourceLabelPlaceholder")}
                error={errors.rulesSourceLabel?.message}
                {...register("rulesSourceLabel")}
              />
            </div>
            {/* The field name read as though it wanted a machine-readable rule
              definition. It is a plain bookmark shown in the footer. */}
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t("gem.settingsForm.rulesSourceHint")}
            </p>

            {/* Read-only facts about the configuration, not inputs. */}
            <dl className="mt-4 space-y-1 border-t border-gray-200 pt-3 dark:border-gray-700">
              <GemStatRow
                label={t("gem.settings.nextEvaluation")}
                value={
                  strategy.nextEvaluationOn ? (
                    formatDate(strategy.nextEvaluationOn)
                  ) : (
                    <GemUnknown />
                  )
                }
              />
              <GemStatRow
                label={t("gem.settings.pricesAsOf")}
                value={
                  strategy.pricesAsOf ? (
                    formatDate(strategy.pricesAsOf)
                  ) : (
                    <GemUnknown />
                  )
                }
              />
            </dl>
          </GemCard>

          {/* The always-mounted card, deliberately not the conditional "fill the
            missing roles" box inside it: that box disappears the moment every
            role is filled, and an active anchor going away mid-step reads as the
            tour breaking. */}
          <GemCard
            title={t("gem.settings.assetsTitle")}
            {...tourAnchor(TOUR_ANCHORS.gemSettingsAssets)}
          >
            <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
              {t("gem.settingsForm.assetsHint", {
                months: Number(watchedLookback) || strategy.lookbackMonths,
              })}
            </p>
            {/* A portfolio that has never held a GEM instrument can be filled in
              one click rather than four trips through the create form. */}
            {missingRoles.length > 0 && (
              <div className="mb-4 rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/40">
                <p className="text-xs text-gray-600 dark:text-gray-300">
                  {t("gem.settingsForm.fillMissingHint", {
                    symbols: missingRoles
                      .map((suggestion) => suggestion.symbol)
                      .join(", "),
                  })}
                </p>
                {/* Which listings, before adding them: the US funds and their
                  UCITS equivalents track the same indices, and only one of the
                  two is buyable at any given broker. */}
                <div className="mt-2 max-w-xs">
                  <Select
                    label={t("gem.settingsForm.fillMissingRegion")}
                    value={fillRegion}
                    onChange={(event) =>
                      setFillRegion(event.target.value as GemSuggestionRegion)
                    }
                    options={GEM_SUGGESTION_REGIONS.map((region) => ({
                      value: region,
                      label: t(
                        `gem.settingsForm.regions.${region}` as Parameters<
                          typeof t
                        >[0],
                      ),
                    }))}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2 gap-1"
                  onClick={handleFillMissingRoles}
                  disabled={isFillingRoles}
                >
                  <SparklesIcon className="h-4 w-4" aria-hidden="true" />
                  {isFillingRoles
                    ? t("gem.settingsForm.fillMissingBusy")
                    : t("gem.settingsForm.fillMissing", {
                        count: missingRoles.length,
                      })}
                </Button>
              </div>
            )}
            <div
              className="space-y-3"
              {...tourAnchor(TOUR_ANCHORS.gemSettingsRoles)}
            >
              {GEM_ROLE_ORDER.map((role) => (
                <div key={role}>
                  <div className="flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <GemInstrumentSelect
                        role={role}
                        label={roleLabel(role)}
                        value={String(assignedRoles.get(role) ?? "")}
                        securities={pickableSecurities}
                        ownedBySymbol={ownedBySymbol}
                        suggestions={suggestionsForRole(role)}
                        onChange={(securityId) =>
                          assignToRole(role, securityId)
                        }
                        onPickSuggestion={(suggestion) =>
                          setCreatingFor({ role, suggestion })
                        }
                        error={errors[role as keyof ConfigFormValues]?.message}
                      />
                    </div>
                    {/* An instrument the suggestions do not cover is added from
                      here, with nothing prefilled. */}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => setCreatingFor({ role })}
                      aria-label={t("gem.settingsForm.addInstrumentFor", {
                        role: roleLabel(role),
                      })}
                    >
                      <PlusIcon className="h-4 w-4" aria-hidden="true" />
                      <span className="ml-1 hidden sm:inline">
                        {t("gem.settingsForm.addInstrument")}
                      </span>
                    </Button>
                  </div>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {roleDescription(role)}
                  </p>
                </div>
              ))}
            </div>

            <p
              className={
                assignedCurrencies.length > 1
                  ? "mt-3 rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-200"
                  : "mt-3 text-xs text-gray-500 dark:text-gray-400"
              }
            >
              {assignedCurrencies.length > 1
                ? t("gem.settingsForm.currencyMixed", {
                    currencies: assignedCurrencies.join(", "),
                  })
                : t("gem.settingsForm.currencyHint")}
            </p>

            <div className="mt-4 border-t border-gray-200 pt-3 dark:border-gray-700">
              <FormActions
                submitLabel={t("gem.settingsForm.save")}
                isSubmitting={isSaving}
                // FormActions' own anchor hook wraps just the button pair; the
                // row is full-width, so anchoring the row would ring the form.
                anchorProps={tourAnchor(TOUR_ANCHORS.gemSettingsSave)}
              />
            </div>
          </GemCard>
        </div>
      </form>

      <Modal
        isOpen={creatingFor !== null}
        onClose={() => setCreatingFor(null)}
        {...securityFormModalProps}
        title={
          creatingFor
            ? t("gem.settingsForm.addInstrumentFor", {
                role: roleLabel(creatingFor.role),
              })
            : ""
        }
        // Prefilled from a suggestion, the exchange and currency are still the
        // investor's to correct: the same fund lists on several venues.
        description={
          creatingFor?.suggestion
            ? t("gem.settingsForm.addInstrumentPrefilled")
            : t("gem.settingsForm.currencyHint")
        }
      >
        <SecurityForm
          key={creatingFor?.suggestion?.symbol ?? "blank"}
          defaults={creatingFor?.suggestion}
          onSubmit={handleSecurityCreated}
          onCancel={() => setCreatingFor(null)}
        />
      </Modal>
    </>
  );
}
