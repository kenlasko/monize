import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { EntityManager } from "typeorm";
import type { Category } from "./entities/category.entity";
import type { UpdateCategoryDto } from "./dto/update-category.dto";
import { tr } from "../i18n/translate";
import { accrualErrors } from "../accruals/accrual-errors";
import { requireAccrualOwner } from "../accruals/accrual-source";
import {
  canonical,
  resolveSourceAccrualEdit,
} from "../accruals/accrual-source-edit";
import type { BulkAccrualPreview } from "../accruals/accrual-bulk-edit";
import type { AccrualFamily } from "../accruals/accrual-balance";
import { assertReconciledRowsMutable } from "../transactions/reconciled-lock.util";

export type CategoryNode = Pick<
  Category,
  | "id"
  | "userId"
  | "parentId"
  | "name"
  | "description"
  | "icon"
  | "color"
  | "isIncome"
  | "autoSign"
  | "isSystem"
  | "createdAt"
> & { snapshot: string };
interface SourceRow {
  id: string;
  categoryId: string | null;
  isSplit: boolean;
  status: string;
  snapshot: string;
}
export type CategoryCommand =
  | { operation: "update"; dto: UpdateCategoryDto }
  | { operation: "reassign"; toCategoryId: string | null }
  | { operation: "delete" };
const graphSql = `SELECT c.id,c.user_id AS "userId",c.parent_id AS "parentId",c.name,c.description,c.icon,c.color,
 c.is_income AS "isIncome",c.auto_sign AS "autoSign",c.is_system AS "isSystem",c.created_at AS "createdAt",
 to_jsonb(c)::text AS snapshot FROM categories c WHERE c.user_id=$1 ORDER BY c.id`;
function sourceSql(lock: boolean) {
  return (
    `SELECT t.id,t.category_id AS "categoryId",t.is_split AS "isSplit",t.status,to_jsonb(t)::text AS snapshot
 FROM transactions t WHERE t.user_id=$1 AND
 (t.category_id=ANY($2::uuid[]) OR EXISTS(SELECT 1 FROM transaction_splits s
 WHERE s.transaction_id=t.id AND s.category_id=ANY($2::uuid[]))) ORDER BY t.id` +
    (lock ? " FOR UPDATE OF t" : "")
  );
}
function subtree(graph: CategoryNode[], id: string): string[] {
  const ids = new Set([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of graph)
      if (row.parentId && ids.has(row.parentId) && !ids.has(row.id)) {
        ids.add(row.id);
        changed = true;
      }
  }
  return [...ids].sort();
}
function sameRows(
  rows: { id: string; snapshot?: string }[],
  other: { id: string; snapshot?: string }[],
) {
  return (
    JSON.stringify(rows.map((row) => [row.id, row.snapshot])) ===
    JSON.stringify(other.map((row) => [row.id, row.snapshot]))
  );
}

/** Source -> payee defaults (deletion only) -> sorted categories; freeze the hierarchy and membership. */
export async function prepareCategoryMutation(
  m: EntityManager,
  userId: string,
  id: string,
  command: CategoryCommand,
) {
  const initial: CategoryNode[] = await m.query(graphSql, [userId]);
  const initialCategory = initial.find((row) => row.id === id);
  if (!initialCategory) throw accrualErrors.missing();
  const affected = command.operation === "update" ? subtree(initial, id) : [id];
  const sources: SourceRow[] = await m.query(sourceSql(true), [
    userId,
    affected,
  ]);
  const payeeSql =
    "SELECT id FROM payees WHERE user_id=$1 AND default_category_id=$2 ORDER BY id";
  const payees: { id: string }[] =
    command.operation === "delete"
      ? await m.query(payeeSql + " FOR UPDATE", [userId, id])
      : [];
  const graph: CategoryNode[] = await m.query(graphSql + " FOR UPDATE OF c", [
    userId,
  ]);
  if (!sameRows(initial, graph)) throw accrualErrors.conflict();
  const current: SourceRow[] = await m.query(sourceSql(false), [
    userId,
    affected,
  ]);
  if (!sameRows(sources, current)) throw accrualErrors.conflict();
  if (
    command.operation === "delete" &&
    !sameRows(payees, await m.query(payeeSql, [userId, id]))
  )
    throw accrualErrors.conflict();
  const category = graph.find((row) => row.id === id)!;
  let parentId = category.parentId,
    newIncome = category.isIncome;
  const families = new Map<string, AccrualFamily>();
  if (command.operation === "update") {
    if (category.isSystem)
      throw new BadRequestException(
        tr(
          "errors.categories.cannotModifySystem",
          "Cannot modify system categories",
        ),
      );
    const dto = command.dto;
    parentId = dto.parentId !== undefined ? dto.parentId : category.parentId;
    if (parentId === id)
      throw new BadRequestException(
        tr("errors.categories.selfParent", "Category cannot be its own parent"),
      );
    if (parentId) {
      const parent = graph.find((row) => row.id === parentId);
      if (!parent) throw accrualErrors.missing();
      if (affected.includes(parentId))
        throw new BadRequestException(
          tr(
            "errors.categories.circularParent",
            "Circular parent reference detected",
          ),
        );
      newIncome = parent.isIncome;
    } else newIncome = dto.isIncome ?? category.isIncome;
    for (const node of graph)
      if (affected.includes(node.id) && node.isIncome !== newIncome)
        families.set(node.id, newIncome ? "income" : "expense");
  } else if (
    command.operation === "reassign" &&
    command.toCategoryId &&
    !graph.some((row) => row.id === command.toCategoryId)
  )
    throw accrualErrors.missing();
  const preview: BulkAccrualPreview = {
    fingerprint: null,
    transactionIds: sources.map((row) => row.id),
    impacts: [],
  };
  if (
    command.operation !== "delete" &&
    (command.operation === "reassign" || families.size)
  ) {
    await assertReconciledRowsMutable(m, userId, sources);
    const accrued: { id: string }[] = sources.length
      ? await m.query(
          "SELECT DISTINCT source_transaction_id AS id FROM accrual_schedules WHERE user_id=$1 AND source_transaction_id=ANY($2::uuid[]) ORDER BY id",
          [userId, preview.transactionIds],
        )
      : [];
    if (accrued.length) requireAccrualOwner(userId);
    const signatures: { id: string; fingerprint: string | null }[] = [];
    for (const source of sources) {
      if (!accrued.some((row) => row.id === source.id)) continue;
      const patch =
        command.operation === "reassign" && source.categoryId === id
          ? { categoryId: command.toCategoryId }
          : {};
      const splits = new Map<string, string | null>();
      if (command.operation === "reassign") {
        const lines: { id: string }[] = await m.query(
          "SELECT id FROM transaction_splits WHERE transaction_id=$1 AND category_id=$2 ORDER BY id",
          [source.id, id],
        );
        for (const line of lines) splits.set(line.id, command.toCategoryId);
      }
      const resolved = await resolveSourceAccrualEdit(
        m,
        userId,
        source.id,
        patch,
        splits,
        new Set(),
        families,
      );
      signatures.push({ id: source.id, fingerprint: resolved.fingerprint });
      if (resolved.impacts.length)
        preview.impacts.push({
          transactionId: source.id,
          schedules: resolved.impacts,
        });
    }
    if (preview.impacts.length) {
      const input =
        command.operation === "update"
          ? {
              operation: command.operation,
              dto: (({ accrualImpactFingerprint: _ignored, ...rest }) => rest)(
                command.dto,
              ),
            }
          : command;
      preview.fingerprint = createHash("sha256")
        .update(
          JSON.stringify(
            canonical({
              version: "category-mutation-v1",
              userId,
              id,
              input,
              graph: graph.map((row) => [row.id, row.snapshot]),
              sources: sources.map((row) => [row.id, row.snapshot]),
              signatures,
              impacts: preview.impacts,
              families: [...families],
              parentId,
              newIncome,
            }),
          ),
        )
        .digest("hex");
    }
  }
  return {
    category,
    graph,
    affected,
    sources,
    payees,
    parentId,
    newIncome,
    families,
    preview,
  };
}
