import type { EntityManager } from "typeorm";
import { addDaysYMD } from "../../common/date-utils";
import {
  DEFAULT_LINK_DAYS_BEFORE,
  LINK_DAYS_AFTER,
  type ParsedReceipt,
  type ParsedReceiptItem,
} from "../parsing/receipt-parser.types";
import type { JoinPart } from "./join-settlement";
import { FIAT_MONEY_DECIMALS, moneyUnits } from "../../common/round.util";

/** The `link` section of a settlement profile that narrows the component search. */
export interface ComponentSearch {
  fromDomains?: readonly string[];
  daysBefore?: number;
}

/** A stored `component` receipt a link value found. */
export interface ComponentRow {
  id: string;
  linkKey: string;
  subject: string;
  /** `YYYY-MM-DD` (UTC): `original_sent_at ?? received_at`. */
  effectiveDate: string;
  parsed: ParsedReceipt;
  parserId: string | null;
}

/** The component chosen for a link value and how many were found (spec 3). */
export interface ChosenComponent {
  row: ComponentRow;
  several: number;
}

interface FoundRow {
  id: string;
  link_key: string;
  subject: string;
  effective_date: string;
  parsed: ParsedReceipt;
  parser_id: string | null;
}

/** A SUM(numeric) read from SQL as 1/10000 units, rounded once. */
export const unitsOf = (amount: string | number | null | undefined): number =>
  moneyUnits(Number(amount ?? 0), FIAT_MONEY_DECIMALS);

/**
 * Spec 3, pure: for each link value the newest component first (ties by id),
 * with the number found. A link value no row carries is absent from the map.
 * `drafts` are extra candidates (the test operation's `componentDraft` readings,
 * spec 10a): a draft replaces the stored row of the same receipt id, and the
 * choice among all of them is the same one.
 */
export function chooseComponents(
  links: readonly string[],
  rows: readonly ComponentRow[],
  drafts: readonly ComponentRow[] = [],
): Map<string, ChosenComponent> {
  const replaced = new Set(drafts.map((draft) => draft.id));
  const candidates = [
    ...rows.filter((row) => !replaced.has(row.id)),
    ...drafts,
  ];
  const chosen = new Map<string, ChosenComponent>();
  for (const link of new Set(links)) {
    const found = candidates
      .filter((row) => row.linkKey === link)
      .sort((a, b) =>
        a.effectiveDate !== b.effectiveDate
          ? a.effectiveDate < b.effectiveDate
            ? 1
            : -1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
      );
    if (found.length > 0)
      chosen.set(link, { row: found[0], several: found.length });
  }
  return chosen;
}

/** Where a settlement looks for its components (spec 2.2 and 3): dates `YYYY-MM-DD`, domains null for any sender. */
export interface ComponentWindow {
  from: string;
  to: string;
  domains: string[] | null;
}

/** The date window and sender domains of a settlement's component search, written once for the pipeline and the dry run. */
export function componentWindow(
  settlementDate: string,
  search: ComponentSearch,
): ComponentWindow {
  return {
    from: addDaysYMD(
      settlementDate,
      -(search.daysBefore ?? DEFAULT_LINK_DAYS_BEFORE),
    ),
    to: addDaysYMD(settlementDate, LINK_DAYS_AFTER),
    domains:
      search.fromDomains && search.fromDomains.length > 0
        ? [...search.fromDomains]
        : null,
  };
}

/**
 * Spec 4 input, pure: one `JoinPart` per settlement item, in item order. A part
 * with no link, or a link no component carries, has no component.
 */
export function toJoinParts(
  items: readonly Pick<ParsedReceiptItem, "link">[],
  chosen: ReadonlyMap<string, ChosenComponent>,
  takenUnits: ReadonlyMap<string, number>,
  tagByParser: ReadonlyMap<string, string | null>,
  nameByParser: ReadonlyMap<string, string | null> = new Map(),
): JoinPart[] {
  return items.map((item) => {
    const found = item.link ? chosen.get(item.link) : undefined;
    if (!found) return { component: null, several: 0, taken: 0 };
    return {
      component: {
        receiptId: found.row.id,
        parsed: found.row.parsed,
        tagName: found.row.parserId
          ? (tagByParser.get(found.row.parserId) ?? null)
          : null,
        subject: found.row.subject,
        effectiveDate: found.row.effectiveDate,
        profileName: found.row.parserId
          ? (nameByParser.get(found.row.parserId) ?? null)
          : null,
      },
      several: found.several,
      taken: takenUnits.get(found.row.id) ?? 0,
    };
  });
}

/**
 * The components the parts of a settlement point at (linked receipts spec 3 and
 * 11), in ONE query over the user's stored receipts, then the units other
 * settlements already took from each chosen one and its profile's tag. `links`
 * is one entry per settlement item (null: the part captured none).
 *
 * `lock` takes `FOR UPDATE OF r`, rows in ascending id: the second step of the
 * lock order (the settlement's own row, then these, then the advisory lock on
 * the matched transaction), so two settlements of one component read `taken`
 * one after the other. A read-only preview passes false. `drafts` are extra
 * candidates a preview read with an unsaved component profile (`chooseComponents`).
 *
 * A DATE is read with `TO_CHAR` and a numeric with `Number` (backend/CLAUDE.md).
 */
export async function loadLinkedComponents(
  m: EntityManager,
  userId: string,
  settlement: { id: string; effectiveDate: string },
  links: readonly (string | null)[],
  search: ComponentSearch,
  lock: boolean,
  drafts: readonly ComponentRow[] = [],
): Promise<JoinPart[]> {
  const wanted = [...new Set(links.filter((l): l is string => l !== null))];
  const items = links.map((link) => ({ link: link ?? undefined }));
  if (wanted.length === 0) {
    return toJoinParts(items, new Map(), new Map(), new Map());
  }
  const { from, to, domains } = componentWindow(
    settlement.effectiveDate,
    search,
  );
  const rows: FoundRow[] = await m.query(
    `SELECT r.id, r.link_key, r.subject,
            TO_CHAR((COALESCE(r.original_sent_at, r.received_at) AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS effective_date,
            r.parsed, r.parser_id
       FROM email_receipts r
      WHERE r.user_id = $1
        AND r.status = 'component'
        AND r.link_key = ANY($2::text[])
        AND r.id <> $3
        AND r.parsed IS NOT NULL
        AND ($4::text[] IS NULL OR EXISTS (
              SELECT 1 FROM unnest($4::text[]) AS d(domain)
               WHERE r.from_domain = d.domain
                  OR right(r.from_domain, length(d.domain) + 1) = '.' || d.domain))
        AND (COALESCE(r.original_sent_at, r.received_at) AT TIME ZONE 'UTC')::date
              BETWEEN $5::date AND $6::date
      ORDER BY r.id
      ${lock ? "FOR UPDATE OF r" : ""}`,
    [userId, wanted, settlement.id, domains, from, to],
  );
  const chosen = chooseComponents(
    wanted,
    rows.map((row) => ({
      id: row.id,
      linkKey: row.link_key,
      subject: row.subject,
      effectiveDate: row.effective_date,
      parsed: row.parsed,
      parserId: row.parser_id,
    })),
    drafts,
  );
  const ids = [...chosen.values()].map((c) => c.row.id);
  const taken = new Map<string, number>();
  const tags = new Map<string, string | null>();
  const names = new Map<string, string | null>();
  if (ids.length > 0) {
    const takenRows: { component_receipt_id: string; taken: string }[] =
      await m.query(
        `SELECT component_receipt_id, SUM(part_amount) AS taken
           FROM email_receipt_links
          WHERE user_id = $1
            AND component_receipt_id = ANY($2::uuid[])
            AND settlement_receipt_id <> $3
          GROUP BY component_receipt_id`,
        [userId, ids, settlement.id],
      );
    for (const row of takenRows) {
      taken.set(row.component_receipt_id, unitsOf(row.taken));
    }
    const parserIds = [
      ...new Set(
        [...chosen.values()]
          .map((c) => c.row.parserId)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (parserIds.length > 0) {
      const tagRows: {
        id: string;
        tag: string | null;
        name: string | null;
      }[] = await m.query(
        `SELECT id, definition->>'tag' AS tag, name
           FROM email_receipt_parsers
          WHERE user_id = $1 AND id = ANY($2::uuid[])`,
        [userId, parserIds],
      );
      for (const row of tagRows) {
        tags.set(row.id, row.tag);
        names.set(row.id, row.name);
      }
    }
  }
  return toJoinParts(items, chosen, taken, tags, names);
}
