import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";

/**
 * Catalog + generic row seeder for the RLS enforcement spec (task T2).
 *
 * T2 has to make an assertion about *every* table in the database, including
 * tables that do not exist yet when this is written. That rules out hand-rolled
 * per-table fixtures: a new table would silently get no coverage. Instead the
 * catalog is read from the live database (information_schema + pg_catalog) and
 * rows are generated from it -- one row per (table, owner) -- so a table added
 * by a future migration is seeded, bucketed and asserted on with no
 * registration step. A column type this generator does not understand throws,
 * naming the column; that failure is the prompt to extend the generator, not a
 * gap in coverage.
 */

export interface ColumnInfo {
  name: string;
  dataType: string;
  udtName: string;
  nullable: boolean;
  hasDefault: boolean;
  maxLength: number | null;
}

export interface ForeignKeyInfo {
  column: string;
  refTable: string;
  refColumn: string;
}

export interface TableCatalogEntry {
  name: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  /** Foreign-key column pairs, including composite keys, keyed by the referencing column. */
  foreignKeys: Map<string, ForeignKeyInfo>;
}

export type TableCatalog = Map<string, TableCatalogEntry>;

/** Reads every public table's columns, primary key and foreign keys. */
export async function loadTableCatalog(
  dataSource: DataSource,
): Promise<TableCatalog> {
  const catalog: TableCatalog = new Map();

  const tables: { tablename: string }[] = await dataSource.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  for (const { tablename } of tables) {
    catalog.set(tablename, {
      name: tablename,
      columns: [],
      primaryKey: [],
      foreignKeys: new Map(),
    });
  }

  const columns: {
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
    character_maximum_length: number | null;
  }[] = await dataSource.query(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable,
            column_default, character_maximum_length
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`,
  );
  for (const col of columns) {
    catalog.get(col.table_name)?.columns.push({
      name: col.column_name,
      dataType: col.data_type,
      udtName: col.udt_name,
      nullable: col.is_nullable === "YES",
      hasDefault: col.column_default !== null,
      maxLength: col.character_maximum_length,
    });
  }

  const pks: { table_name: string; column_name: string }[] =
    await dataSource.query(
      `SELECT tc.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
          AND kcu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
        ORDER BY tc.table_name, kcu.ordinal_position`,
    );
  for (const pk of pks) {
    catalog.get(pk.table_name)?.primaryKey.push(pk.column_name);
  }

  // pg_constraint rather than information_schema for foreign keys: the
  // information_schema view multiplies rows for composite keys, and conkey /
  // confkey keep referencing and referenced columns paired positionally.
  const fks: {
    table_name: string;
    column_name: string;
    ref_table: string;
    ref_column: string;
  }[] = await dataSource.query(
    `SELECT rel.relname AS table_name,
            att.attname AS column_name,
            fref.relname AS ref_table,
            fatt.attname AS ref_column
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
       JOIN pg_class fref ON fref.oid = con.confrelid
       JOIN LATERAL unnest(con.conkey, con.confkey) AS pairs(attnum, fattnum) ON true
       JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = pairs.attnum
       JOIN pg_attribute fatt ON fatt.attrelid = fref.oid AND fatt.attnum = pairs.fattnum
      WHERE con.contype = 'f' AND ns.nspname = 'public'`,
  );
  for (const fk of fks) {
    // Ownership can have both a users FK and an ownership-preserving composite
    // FK. Keep the direct owner reference; other pairs resolve the seeded parent.
    const existing = catalog
      .get(fk.table_name)
      ?.foreignKeys.get(fk.column_name);
    if (existing?.refTable === "users" && fk.ref_table !== "users") continue;
    catalog.get(fk.table_name)?.foreignKeys.set(fk.column_name, {
      column: fk.column_name,
      refTable: fk.ref_table,
      refColumn: fk.ref_column,
    });
  }

  return catalog;
}

/** First label of every enum type, keyed by the type's udt name. */
export async function loadEnumFirstValues(
  dataSource: DataSource,
): Promise<Map<string, string>> {
  const rows: { typname: string; enumlabel: string }[] = await dataSource.query(
    `SELECT DISTINCT ON (t.typname) t.typname, e.enumlabel
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      ORDER BY t.typname, e.enumsortorder`,
  );
  return new Map(rows.map((r) => [r.typname, r.enumlabel]));
}

export interface BuiltInsert {
  sql: string;
  values: unknown[];
}

/**
 * Ownership columns that reference `users(id)` by convention. Several entities
 * declare these as plain uuid columns without a relation, so the
 * synchronize-built schema has no FK constraint to discover -- but the RLS
 * policies still key on them, so the seeder must fill them with the owner.
 */
const USER_REF_COLUMNS = new Set([
  "user_id",
  "owner_user_id",
  "delegate_user_id",
]);

/**
 * Parent references that likewise lack a DB-level FK constraint in the
 * synchronize-built schema (`table.column` -> parent). A future FK-less
 * reference column is not silently mis-seeded: it gets a random uuid, the
 * policy hides the row, and the visibility sweep fails naming the table.
 */
const FKLESS_PARENT_REFS: Record<string, ForeignKeyInfo> = {
  "attachment_blobs.attachment_id": {
    column: "attachment_id",
    refTable: "transaction_attachments",
    refColumn: "id",
  },
  "delegate_account_favourites.account_id": {
    column: "account_id",
    refTable: "accounts",
    refColumn: "id",
  },
  "delegate_net_worth_exclusions.account_id": {
    column: "account_id",
    refTable: "accounts",
    refColumn: "id",
  },
  "account_delegate_grants.account_id": {
    column: "account_id",
    refTable: "accounts",
    refColumn: "id",
  },
};

/**
 * Nullable parent references a production CHECK still requires (`table.column`).
 * The generator leaves a nullable foreign key NULL, so these are filled -- and
 * ordered -- like a NOT NULL one. `transaction_attachments` has two nullable
 * parents and `chk_attachment_one_parent` wants exactly one of them: the row
 * takes its transaction, the parent every attachment had before warranties.
 */
const REQUIRED_NULLABLE_PARENTS = new Set([
  "transaction_attachments.transaction_id",
]);

/**
 * Columns a production CHECK constrains to a vocabulary or a shape the generic
 * generator cannot guess (it writes `t1`, `t2`, ... into a text column and
 * leaves a nullable column NULL). The integration schema carries production's
 * CHECKs (test/helpers/schema-constraints.ts), so a generated row must be one
 * production could hold. Explicit `overrides` still win.
 *
 * `ai_review_requests` is an `email_trade` request because that is the kind
 * whose row has no transaction (`ck_ai_review_requests_trade_shape`); every
 * other kind needs one (`ck_ai_review_requests_transaction_required`).
 */
const PRODUCTION_SHAPED_VALUES: Record<string, Record<string, unknown>> = {
  ai_review_requests: { kind: "email_trade" },
  backup_offsite_uploads: {
    destination: "s3",
    tier: "daily",
    status: "pending",
  },
  email_receipt_mailboxes: {
    auth_method: "password",
    password_enc: "seeded-ciphertext",
  },
  // The generator's integers count up across the whole seed, past the year
  // bounds these CHECKs hold.
  monte_carlo_cash_flows: { flow_type: "ONE_TIME", start_year: 1 },
  monte_carlo_scenarios: { years_to_retirement: 30 },
  // chk_warranty_expiry: a warranty is lifetime or has an expiry date.
  warranties: { is_lifetime: true },
};

/**
 * Generates one minimal valid row per (table, owner) and remembers what it
 * inserted, so ownership assertions can compare "what the app role can see"
 * against "what was seeded for that user" exactly, by primary key.
 *
 * Ownership is expressed through foreign keys: any column referencing
 * `users(id)` gets the owner's id, any other NOT NULL foreign key gets the
 * owner's already-seeded parent row (which is why seeding follows a topological
 * order), and `currencies` -- global, RLS-exempt reference data -- always
 * resolves to USD. That single rule covers direct `user_id` tables, the bespoke
 * owner columns (`owner_user_id`, `delegate_user_id`, `users.id` itself) and
 * every indirect table, without a per-table map.
 */
export class RlsRowSeeder {
  private uniq = 0;

  /**
   * The delegate of every generically seeded `account_delegates` row. The
   * production CHECK `account_delegates_no_self` refuses a delegation to
   * oneself, so the owner cannot also be the delegate; the other isolation
   * user cannot be either, or the delegation would be visible to two users and
   * the exact-visibility sweep would mean nothing. A third user nobody queries
   * as, outside `seededRows`, keeps each row its owner's alone.
   */
  private counterpartyUserId: string | null = null;

  /** Inserted rows: table -> ownerId -> full row (RETURNING *). */
  readonly seededRows = new Map<string, Map<string, Record<string, unknown>>>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly catalog: TableCatalog,
    private readonly enumFirstValues: Map<string, string>,
  ) {}

  /**
   * Orders `tables` so every NOT NULL foreign key's parent (within the set)
   * comes first. Nullable foreign keys are left NULL by the generator, so they
   * impose no ordering; references to `users` and `currencies` are satisfied
   * outside the set.
   */
  topoOrder(tables: string[]): string[] {
    const inSet = new Set(tables);
    const remaining = new Set(tables);
    const ordered: string[] = [];

    while (remaining.size > 0) {
      const ready = [...remaining].filter((table) => {
        const entry = this.entry(table);
        return entry.columns.every((col) => {
          const fk = this.effectiveFk(table, col);
          // A nullable ownership column is filled by `buildInsert` (the policy
          // keys on it), so it is a real dependency here too -- otherwise the row
          // can be ordered before the user it points at and the insert dies on
          // the foreign key.
          if (!fk || (col.nullable && !this.fillsNullableRef(table, col))) {
            return true;
          }
          if (fk.refTable === table) return true;
          if (!inSet.has(fk.refTable)) return true;
          return !remaining.has(fk.refTable);
        });
      });
      if (ready.length === 0) {
        throw new Error(
          `Cyclic NOT NULL foreign keys among: ${[...remaining].join(", ")}`,
        );
      }
      for (const table of ready.sort()) {
        remaining.delete(table);
        ordered.push(table);
      }
    }
    return ordered;
  }

  /**
   * Builds an INSERT for one fresh row owned by `ownerId`. Every call generates
   * new unique values, so a second call for the same (table, owner) yields a
   * distinct row -- which is what the WITH CHECK assertions need. `overrides`
   * force specific columns (delegation fixtures use this).
   */
  buildInsert(
    table: string,
    ownerId: string,
    explicit: Record<string, unknown> = {},
  ): BuiltInsert {
    // The catalog cannot infer a valid branch of a discriminated CHECK.
    // Supply one valid credential shape; every table/owner still participates
    // in the catalog-driven visibility and WITH CHECK sweeps.
    const rowDefaults: Record<string, unknown> =
      table === "bank_sync_credentials"
        ? {
            provider: "simplefin",
            application_id: null,
            private_key_enc: null,
            access_url_enc: "rls-fixture-ciphertext",
          }
        : table === "accrual_system_accounts"
          ? { family: "expense" }
          : table === "accrual_schedules"
            ? {
                family: "expense",
                preset: "CUSTOM",
                start_month: "2026-01-01",
                month_count: 12,
                source_fingerprint: "a".repeat(64),
              }
            : table === "accrual_allocations"
              ? { period_index: 0, recognition_date: "2026-01-31" }
              : {};
    const entry = this.entry(table);
    const overrides = { ...PRODUCTION_SHAPED_VALUES[table], ...explicit };
    const rowValues = { ...rowDefaults, ...overrides };
    const columns: string[] = [];
    const values: unknown[] = [];

    for (const col of entry.columns) {
      if (col.name in rowValues) {
        columns.push(col.name);
        values.push(rowValues[col.name]);
        continue;
      }

      if (table === "account_delegates" && col.name === "delegate_user_id") {
        if (!this.counterpartyUserId) {
          throw new Error(
            "Seeding account_delegates needs a delegate other than its owner: " +
              "call seedAll first, or pass delegate_user_id as an override",
          );
        }
        columns.push(col.name);
        values.push(this.counterpartyUserId);
        continue;
      }

      // users.id is the one owner column that also has a generated default:
      // the owner IS the row, so the id must be the owner's, not a fresh uuid.
      if (table === "users" && col.name === "id") {
        columns.push(col.name);
        values.push(ownerId);
        continue;
      }

      const fk = this.effectiveFk(table, col);
      if (fk) {
        // A nullable *ownership* column is still the row's ownership, and the
        // policy keys on it -- so it gets the owner even though it may be NULL in
        // production. `attachment_blob_tombstones.user_id` is nullable on purpose
        // (ON DELETE SET NULL: a tombstone has to outlive its owner, because that
        // is exactly when the bytes most need removing), and skipping it left an
        // ownerless row that neither user could see. The sweep then reported
        // "saw 0 rows" for a table whose policy is fine.
        if (col.nullable && !this.fillsNullableRef(table, col)) continue;
        columns.push(col.name);
        values.push(this.resolveForeignKey(table, fk, ownerId));
        continue;
      }

      if (col.hasDefault || col.nullable) continue;

      columns.push(col.name);
      values.push(this.generateValue(table, col));
    }

    if (columns.length === 0) {
      // A table of nothing but defaulted columns (no ownership at all) still
      // gets a row, so the bucket test can report it instead of seeding crashing.
      return {
        sql: `INSERT INTO "${table}" DEFAULT VALUES RETURNING *`,
        values,
      };
    }
    const columnList = columns.map((c) => `"${c}"`).join(", ");
    const params = columns.map((_, i) => `$${i + 1}`).join(", ");
    return {
      sql: `INSERT INTO "${table}" (${columnList}) VALUES (${params}) RETURNING *`,
      values,
    };
  }

  /** Inserts (as the connection's role -- the owner) and records the row. */
  async seedRowFor(
    table: string,
    ownerId: string,
  ): Promise<Record<string, unknown>> {
    const { sql, values } = this.buildInsert(table, ownerId);
    const [row] = await this.dataSource.query(sql, values);
    if (!this.seededRows.has(table)) {
      this.seededRows.set(table, new Map());
    }
    this.seededRows.get(table)!.set(ownerId, row);
    return row;
  }

  /** Seeds one row per (table, owner), parents before children. */
  async seedAll(tables: string[], ownerIds: string[]): Promise<void> {
    if (!this.counterpartyUserId) {
      const id = randomUUID();
      const { sql, values } = this.buildInsert("users", id);
      await this.dataSource.query(sql, values);
      this.counterpartyUserId = id;
    }
    const order = this.topoOrder(tables);
    for (const ownerId of ownerIds) {
      for (const table of order) {
        await this.seedRowFor(table, ownerId);
      }
    }
  }

  seededRowFor(table: string, ownerId: string): Record<string, unknown> {
    const row = this.seededRows.get(table)?.get(ownerId);
    if (!row) {
      throw new Error(`No seeded row for ${table} / owner ${ownerId}`);
    }
    return row;
  }

  /**
   * The column's reference, whether or not the schema declares it: a real FK
   * constraint, a known FK-less parent reference, or -- by naming convention --
   * an ownership column pointing at `users(id)`.
   */
  private effectiveFk(
    table: string,
    column: ColumnInfo,
  ): ForeignKeyInfo | undefined {
    const real = this.entry(table).foreignKeys.get(column.name);
    if (real) return real;
    const fallback = FKLESS_PARENT_REFS[`${table}.${column.name}`];
    if (fallback) return fallback;
    if (column.udtName === "uuid" && USER_REF_COLUMNS.has(column.name)) {
      return { column: column.name, refTable: "users", refColumn: "id" };
    }
    return undefined;
  }

  /**
   * Whether a nullable reference is filled anyway: an ownership column (the
   * policy keys on it) or a parent a production CHECK requires.
   */
  private fillsNullableRef(table: string, column: ColumnInfo): boolean {
    return (
      USER_REF_COLUMNS.has(column.name) ||
      REQUIRED_NULLABLE_PARENTS.has(`${table}.${column.name}`)
    );
  }

  private entry(table: string): TableCatalogEntry {
    const entry = this.catalog.get(table);
    if (!entry) {
      throw new Error(`Table "${table}" not found in catalog`);
    }
    return entry;
  }

  private resolveForeignKey(
    table: string,
    fk: ForeignKeyInfo,
    ownerId: string,
  ): unknown {
    if (fk.refTable === "users") return ownerId;
    // Global RLS-exempt reference data: every seeded row shares one currency.
    if (fk.refTable === "currencies") return "USD";
    const parent = this.seededRows.get(fk.refTable)?.get(ownerId);
    if (!parent) {
      throw new Error(
        `Seeding ${table}.${fk.column}: no seeded parent row in ${fk.refTable} ` +
          `for owner ${ownerId} -- check the topological order`,
      );
    }
    return parent[fk.refColumn];
  }

  private generateValue(table: string, col: ColumnInfo): unknown {
    const enumValue = this.enumFirstValues.get(col.udtName);
    if (enumValue !== undefined) return enumValue;

    switch (col.dataType) {
      case "character varying":
      case "character":
      case "text": {
        const value = `t${(++this.uniq).toString(36)}`;
        // Keep the counter (the tail) when the column is shorter than the
        // generated string, so uniqueness survives truncation.
        return col.maxLength && value.length > col.maxLength
          ? value.slice(-col.maxLength)
          : value;
      }
      case "uuid":
        return randomUUID();
      case "integer":
      case "bigint":
      case "smallint":
        return ++this.uniq;
      case "numeric":
      case "double precision":
      case "real":
        return 1;
      case "boolean":
        return false;
      case "date":
        return "2026-01-01";
      case "timestamp with time zone":
      case "timestamp without time zone":
        return "2026-01-01T00:00:00.000Z";
      case "json":
      case "jsonb":
        return "{}";
      case "bytea":
        return Buffer.from([0]);
      case "ARRAY":
        return "{}";
      default:
        throw new Error(
          `RlsRowSeeder cannot generate a value for ${table}.${col.name} ` +
            `(${col.dataType}/${col.udtName}) -- extend the generator`,
        );
    }
  }
}
