import {
  DefaultCategoryDefinition,
  DefaultCategorySet,
  GENERIC_CATEGORY_SET,
} from "./default-categories";

/**
 * Country-specific tweaks layered over the generic default category catalog.
 *
 * The baseline in `default-categories.ts` is country-neutral. A user importing
 * defaults picks the country they budget in, and the matching overlay adds the
 * tax lines, benefit programmes, and local charges that country actually uses
 * -- while removing the generic placeholders those entries supersede (a
 * Canadian does not need both "Income Tax" and "Federal Income Tax").
 *
 * Adding a country means adding an entry to {@link COUNTRY_CATEGORY_ADDITIONS}
 * and adding the new English names to `src/i18n/locales/en/categories.json`
 * (`default-category-i18n.spec.ts` fails when the two drift apart). Nothing
 * else -- the API and the picker read the country list from this file.
 */

export interface CountryCategoryAddition {
  /** Parent category name; matched against the baseline, or created if new. */
  name: string;
  /** Subcategories to add under the parent. */
  subcategories?: string[];
  /**
   * Baseline subcategories this country's more specific entries replace, e.g.
   * the generic "Sales Tax" once "GST/HST" has been added.
   */
  removeSubcategories?: string[];
}

export interface CountryCategoryAdditions {
  income?: CountryCategoryAddition[];
  expense?: CountryCategoryAddition[];
}

/** ISO 3166-1 alpha-2 codes with a category overlay. */
export const DEFAULT_CATEGORY_COUNTRY_CODES = ["CA", "GB", "US"] as const;

export type DefaultCategoryCountry =
  (typeof DEFAULT_CATEGORY_COUNTRY_CODES)[number];

export const COUNTRY_CATEGORY_ADDITIONS: Readonly<
  Record<DefaultCategoryCountry, CountryCategoryAdditions>
> = {
  CA: {
    income: [
      { name: "Investment Income", subcategories: ["RESP Grant"] },
      {
        name: "Other Income",
        subcategories: ["Canada Child Benefit", "GST/HST Credit"],
      },
      {
        name: "Retirement Income",
        subcategories: [
          "CPP/QPP Benefits",
          "OAS Benefits",
          "RRIF Withdrawal",
          "RRSP Withdrawal",
        ],
      },
    ],
    expense: [
      { name: "Bank Fees", subcategories: ["NSF"] },
      { name: "Food", subcategories: ["Cannabis"] },
      { name: "Gifts", subcategories: ["RESP Contribution"] },
      { name: "Insurance", subcategories: ["Provincial Health Premium"] },
      {
        name: "Taxes",
        subcategories: [
          "CPP/QPP Contributions",
          "EI Premiums",
          "Federal Income Tax",
          "GST/HST",
          "Provincial Income Tax",
          "Provincial Sales Tax",
          "Union Dues",
        ],
        removeSubcategories: ["Income Tax", "Sales Tax"],
      },
    ],
  },
  GB: {
    income: [
      { name: "Other Income", subcategories: ["Child Benefit"] },
      {
        name: "Retirement Income",
        subcategories: ["State Pension", "Workplace Pension"],
      },
    ],
    expense: [
      {
        name: "Automobile",
        subcategories: ["Congestion Charge", "MOT", "Road Tax"],
      },
      { name: "Bank Fees", subcategories: ["Unpaid Item Fee"] },
      { name: "Bills", subcategories: ["TV Licence"] },
      { name: "Housing", subcategories: ["Ground Rent", "Service Charge"] },
      { name: "Loan", subcategories: ["Student Loan Repayment"] },
      {
        name: "Taxes",
        subcategories: ["Council Tax", "National Insurance", "VAT"],
        removeSubcategories: ["Sales Tax"],
      },
    ],
  },
  US: {
    income: [
      { name: "Other Income", subcategories: ["State Tax Refund"] },
      {
        name: "Retirement Income",
        subcategories: [
          "401(k) Withdrawal",
          "IRA Withdrawal",
          "Social Security Benefits",
        ],
      },
    ],
    expense: [
      { name: "Bank Fees", subcategories: ["NSF"] },
      { name: "Education", subcategories: ["529 Plan Contribution"] },
      {
        name: "Healthcare",
        subcategories: ["Copay", "Health Savings Account"],
      },
      {
        name: "Loan",
        subcategories: ["Student Loan Interest", "Student Loan Principal"],
      },
      {
        name: "Taxes",
        subcategories: [
          "Federal Income Tax",
          "Local Income Tax",
          "Medicare Tax",
          "Social Security Tax",
          "State Income Tax",
        ],
        removeSubcategories: ["Income Tax"],
      },
    ],
  },
};

export function isDefaultCategoryCountry(
  code: string | undefined | null,
): code is DefaultCategoryCountry {
  if (!code) return false;
  return (DEFAULT_CATEGORY_COUNTRY_CODES as readonly string[]).includes(code);
}

const byName = (a: DefaultCategoryDefinition, b: DefaultCategoryDefinition) =>
  a.name.localeCompare(b.name, "en");

function mergeBranch(
  base: DefaultCategoryDefinition[],
  additions: CountryCategoryAddition[],
): DefaultCategoryDefinition[] {
  const merged = base.map((category) => {
    const addition = additions.find((a) => a.name === category.name);
    if (!addition) return category;
    const removed = new Set(addition.removeSubcategories ?? []);
    const subcategories = Array.from(
      new Set([
        ...category.subcategories.filter((s) => !removed.has(s)),
        ...(addition.subcategories ?? []),
      ]),
    ).sort((a, b) => a.localeCompare(b, "en"));
    return { ...category, subcategories };
  });

  const newParents = additions
    .filter((a) => !base.some((c) => c.name === a.name))
    .map((a) => ({
      name: a.name,
      subcategories: Array.from(new Set(a.subcategories ?? [])).sort((x, y) =>
        x.localeCompare(y, "en"),
      ),
    }));

  return [...merged, ...newParents].sort(byName);
}

/**
 * The default catalog for a country, or the generic baseline when the country
 * is unknown, unsupported, or omitted. Never mutates the exported baseline.
 */
export function getDefaultCategories(
  country?: string | null,
): DefaultCategorySet {
  if (!isDefaultCategoryCountry(country)) return GENERIC_CATEGORY_SET;

  const additions = COUNTRY_CATEGORY_ADDITIONS[country];
  return {
    income: mergeBranch(GENERIC_CATEGORY_SET.income, additions.income ?? []),
    expense: mergeBranch(GENERIC_CATEGORY_SET.expense, additions.expense ?? []),
    // Moving one's own money is the same in every country.
    transfer: GENERIC_CATEGORY_SET.transfer,
  };
}

/** Every default name that can be created for any country, for i18n parity. */
export function allDefaultCategoryDefinitions(): DefaultCategoryDefinition[] {
  const sets = [
    GENERIC_CATEGORY_SET,
    ...DEFAULT_CATEGORY_COUNTRY_CODES.map((c) => getDefaultCategories(c)),
  ];
  return sets.flatMap((set) => [
    ...set.income,
    ...set.expense,
    ...set.transfer,
  ]);
}
