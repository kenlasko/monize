import { EntityManager } from "typeorm";
import {
  templateCashPricedOf,
  templateFaceValueOf,
} from "../bonds/bond-adapters";
import { seriesOnSaleSql } from "../bonds/bond-series-resolver";

/**
 * Why a security cannot be linked to a bond program (the engine prices a linked
 * security and nothing else does). One definition for the write that links
 * (`SecuritiesService.update`/`create`), the preview of the AI assistant and MCP
 * `update_security`, and the undo of a security edit, so the three cannot
 * disagree about what a valid link is
 * (`docs/specs/bond-program-securities.md` section 2.2).
 */
export type BondLinkProblem =
  | { readonly code: "PROGRAM_NOT_FOUND" }
  /** Only a security of type BOND can be linked. */
  | { readonly code: "NOT_BOND_TYPE" }
  /** `instrumentCurrency` is the program's currency (the name predates programs). */
  | { readonly code: "CURRENCY_MISMATCH"; readonly instrumentCurrency: string };

/** The security type a link requires. */
export const BOND_SECURITY_TYPE = "BOND";

/**
 * The first problem with linking a security of this type and currency to the
 * program, or null when the link is valid: the program exists, the security is
 * of type BOND, and it is recorded in the program's currency (INV-PRICE-001 -- a
 * stored price is in the currency the security is recorded in, and the engine
 * prices in the program's).
 */
export async function findBondLinkProblem(
  m: EntityManager,
  link: {
    readonly bondProgramId: string;
    readonly currencyCode: string;
    readonly securityType: string | null | undefined;
  },
): Promise<BondLinkProblem | null> {
  const rows: Array<{ currency_code: string }> = await m.query(
    `SELECT currency_code FROM bond_programs WHERE id = $1`,
    [link.bondProgramId],
  );
  if (rows.length === 0) return { code: "PROGRAM_NOT_FOUND" };
  if (link.securityType !== BOND_SECURITY_TYPE)
    return { code: "NOT_BOND_TYPE" };
  const programCurrency = rows[0].currency_code;
  return programCurrency === link.currencyCode
    ? null
    : { code: "CURRENCY_MISMATCH", instrumentCurrency: programCurrency };
}

/**
 * A share-moving trade price within this multiple of the face value per bond is
 * a price per bond (the exchange price of a bond is close to par).
 */
export const BOND_UNIT_PRICE_BAND = { min: "0.5", max: "2" } as const;

/**
 * The band of a series whose unit price is a cash price (a marketable coupon
 * series: the quoted price, times the index ratio for an indexed principal, of
 * one unit of face value, `docs/specs/bond-marketable-primitives.md` section 3):
 * a deep-discount bond is worth a fraction of its face value and an indexed one
 * several times it, so a price is a price per bond up to this multiple of the
 * face value, and every positive price is above the lower end.
 */
export const BOND_CASH_PRICE_BAND = { min: "0", max: "5" } as const;

/**
 * SQL over a `bond_terms_versions.terms` column (the alias `terms`): true when
 * the series trades and carries a coupon, the series `BOND_CASH_PRICE_BAND`
 * applies to (the same series `marketPriceRequired` names, `engine/price-policy.ts`).
 */
const CASH_PRICED_TERMS_SQL = `(terms -> 'instrument' ->> 'marketability' = 'MARKETABLE'
                         AND terms -> 'rateRule' ->> 'type' <> 'ZERO_COUPON_DISCOUNT')`;

/**
 * The ACQUISITIONS whose per-unit price says what a quantity counts: BUY and the
 * REINVEST variants (a transfer or ADD_SHARES has no price). A SELL or REDEEM is
 * not read: a long-held EDO or ROD is legitimately worth more than twice its
 * face value, and a removal counted in currency units is already refused by the
 * lot derivation (REMOVAL_EXCEEDS_SERIES). The link check read SELL before; it
 * no longer does.
 */
const BAND_ACTIONS_SQL = `'BUY', 'REINVEST', 'REINVEST_INTEREST',
                             'REINVEST_CAPITAL_GAIN_SHORT', 'REINVEST_CAPITAL_GAIN_LONG'`;

/** A trade whose price is outside the band of its face value. */
export interface QuantityNotBonds {
  readonly rowId: string;
  /** The stored per-unit price, as a decimal string. */
  readonly price: string;
  /** The face value per bond it was read against, as a decimal string. */
  readonly faceValue: string;
  /** True when it was read against `BOND_CASH_PRICE_BAND` (a marketable coupon series). */
  readonly cashPrice: boolean;
}

/**
 * The face value of one bond of the program the template declares, and whether
 * the template's unit price is a cash price, or null when the program is not
 * found or no installed adapter declares it (then a row with no series of its
 * own has nothing to be read against and is not refused).
 */
export async function programTemplate(
  m: EntityManager,
  bondProgramId: string,
): Promise<{ faceValue: string; cashPriced: boolean } | null> {
  const rows: Array<{
    issuer_country_code: string;
    issuer_code: string;
    program_code: string;
  }> = await m.query(
    `SELECT issuer_country_code, issuer_code, program_code
       FROM bond_programs WHERE id = $1::uuid`,
    [bondProgramId],
  );
  if (rows.length === 0) return null;
  const key = {
    issuerCountryCode: rows[0].issuer_country_code,
    issuerCode: rows[0].issuer_code,
    programCode: rows[0].program_code,
  };
  const faceValue = templateFaceValueOf(key);
  return faceValue === null
    ? null
    : { faceValue, cashPriced: templateCashPricedOf(key) };
}

/**
 * The priced acquisitions of the security (at most `limit`) whose per-unit price is not within
 * [0.5, 2] x the face value of the series it is read as (for a marketable
 * coupon series, whose price is a cash price, not above 5 x it:
 * `BOND_CASH_PRICE_BAND`), which means its
 * quantities are not numbers of bonds (a legacy security recording currency
 * units, or one unit per package): the lot derivation reads a quantity as a
 * count of bonds, so the link would publish a figure off by a factor of the face
 * value (INV-BOND-005). A row is read as its stored series when that is in the
 * program; otherwise (no stored series, or one of another program, which a link
 * clears) as the series of the program on sale on its date (`seriesOnSaleSql`,
 * the inference a write applies), and when none is on sale that day as the
 * program's newest series (the greatest sale window start). A row with no
 * series to read, because the program has none stored, is read against the face
 * value of the program's template (`templateFaceValueOf`): a row is never
 * skipped for lack of a series. Rows with no price (ADD_SHARES, a transfer) say
 * nothing and are not read; VOID rows recorded nothing. `onlyRowIds` narrows the
 * read to the rows a write has just stored (read from their stored price and
 * series, inside the write's transaction).
 */
export async function findQuantitiesNotBonds(
  m: EntityManager,
  userId: string,
  securityId: string,
  bondProgramId: string,
  options: {
    readonly onlyRowIds?: readonly string[];
    readonly limit?: number;
  } = {},
): Promise<QuantityNotBonds[]> {
  const template = await programTemplate(m, bondProgramId);
  const onSale = seriesOnSaleSql(
    "$3",
    "TO_CHAR(t.transaction_date, 'YYYY-MM-DD')",
  );
  const rows: Array<{
    id: string;
    price: string;
    face: string;
    cash_price: boolean;
  }> = await m.query(
    `SELECT t.id, t.price::text AS price, COALESCE(f.face, $4::numeric)::text AS face,
              COALESCE(f.cash, $7::boolean) AS cash_price
       FROM (
         SELECT t.*
           FROM investment_transactions t
          WHERE t.security_id = $1 AND t.user_id = $2
            AND t.status != 'VOID'
            AND t.action IN (${BAND_ACTIONS_SQL})
            AND t.price IS NOT NULL AND t.price > 0
            AND ($5::uuid[] IS NULL OR t.id = ANY($5::uuid[]))
       ) t
      LEFT JOIN LATERAL (
        SELECT i.id
          FROM bond_instruments i
         WHERE i.bond_program_id = $3::uuid
           AND (
             i.id = t.bond_instrument_id
             OR (
               NOT EXISTS (SELECT 1 FROM bond_instruments o
                            WHERE o.id = t.bond_instrument_id
                              AND o.bond_program_id = $3::uuid)
               AND (
                 i.id IN (${onSale})
                 OR (
                   NOT EXISTS (${onSale})
                   AND i.id = (
                     SELECT n.id
                       FROM bond_instruments n
                      CROSS JOIN LATERAL (
                        SELECT v.terms
                          FROM bond_terms_versions v
                         WHERE v.bond_instrument_id = n.id
                         ORDER BY v.version DESC
                         LIMIT 1
                      ) nv
                      WHERE n.bond_program_id = $3::uuid
                      ORDER BY (nv.terms -> 'saleWindow' ->> 'from') DESC NULLS LAST,
                               n.series_code DESC
                      LIMIT 1
                   )
                 )
               )
             )
           )
      ) r ON true
      LEFT JOIN LATERAL (
        SELECT (terms -> 'instrument' ->> 'faceValue')::numeric AS face,
               ${CASH_PRICED_TERMS_SQL} AS cash
          FROM bond_terms_versions
         WHERE bond_instrument_id = r.id
         ORDER BY version DESC
         LIMIT 1
      ) f ON true
      WHERE COALESCE(f.face, $4::numeric) > 0
        AND CASE WHEN COALESCE(f.cash, $7::boolean)
              THEN (t.price < COALESCE(f.face, $4::numeric) * ${BOND_CASH_PRICE_BAND.min}::numeric
                    OR t.price > COALESCE(f.face, $4::numeric) * ${BOND_CASH_PRICE_BAND.max}::numeric)
              ELSE (t.price < COALESCE(f.face, $4::numeric) * ${BOND_UNIT_PRICE_BAND.min}::numeric
                    OR t.price > COALESCE(f.face, $4::numeric) * ${BOND_UNIT_PRICE_BAND.max}::numeric)
            END
      LIMIT $6::int`,
    [
      securityId,
      userId,
      bondProgramId,
      template?.faceValue ?? null,
      options.onlyRowIds ?? null,
      options.limit ?? null,
      template?.cashPriced ?? false,
    ],
  );
  return rows.map((r) => ({
    rowId: r.id,
    price: r.price,
    faceValue: r.face,
    cashPrice: r.cash_price,
  }));
}

/** True when `findQuantitiesNotBonds` finds a trade (the link-time question). */
export async function hasQuantitiesThatAreNotBonds(
  m: EntityManager,
  userId: string,
  securityId: string,
  bondProgramId: string,
): Promise<boolean> {
  const found = await findQuantitiesNotBonds(
    m,
    userId,
    securityId,
    bondProgramId,
    { limit: 1 },
  );
  return found.length > 0;
}
