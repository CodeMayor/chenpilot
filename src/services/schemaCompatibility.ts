/**
 * Database schema compatibility check (#1064).
 *
 * Migrations are applied explicitly (`npm run migration:run`), never on boot.
 * This compares the migrations the running build ships with against the rows
 * in the TypeORM migrations table so a schema mismatch shows up as a failed
 * readiness probe with an actionable command instead of a false "healthy".
 *
 *  - pending  (in the build, not applied)  → incompatible, readiness fails
 *  - unknown  (applied, not in the build)  → database is ahead of this build
 *    (e.g. mid-rollback); reported as degraded, never healthy
 */

export const MIGRATION_RUN_COMMAND = "npm run migration:run";

export type SchemaCompatibilityStatus = "COMPATIBLE" | "PENDING_MIGRATIONS" | "DATABASE_AHEAD";

export interface SchemaCompatibilityResult {
  status: SchemaCompatibilityStatus;
  /** Latest migration this build requires (by timestamp), or null if none. */
  requiredVersion: string | null;
  /** Latest migration applied to the database, or null if none. */
  appliedVersion: string | null;
  pending: string[];
  unknown: string[];
  /** Human-readable next step; absent when compatible. */
  action?: string;
}

/** The parts of a TypeORM DataSource this check needs (kept small for tests). */
export interface SchemaSource {
  migrations: ReadonlyArray<{ name?: string; constructor: { name: string } }>;
  options: { migrationsTableName?: string; schema?: string };
  query(sql: string): Promise<Array<{ name: string }>>;
}

/** TypeORM convention: the migration timestamp is the trailing 13 digits of the name. */
function timestampOf(name: string): number {
  const match = /(\d{13})$/.exec(name);
  return match ? Number(match[1]) : 0;
}

function latest(names: string[]): string | null {
  if (names.length === 0) return null;
  return [...names].sort((a, b) => timestampOf(a) - timestampOf(b) || a.localeCompare(b))[
    names.length - 1
  ];
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export async function checkSchemaCompatibility(
  source: SchemaSource
): Promise<SchemaCompatibilityResult> {
  const required = source.migrations.map((m) => m.name || m.constructor.name);

  const table = source.options.migrationsTableName || "migrations";
  const qualified = source.options.schema
    ? `${quoteIdent(source.options.schema)}.${quoteIdent(table)}`
    : quoteIdent(table);

  let applied: string[];
  try {
    const rows = await source.query(`SELECT "name" FROM ${qualified}`);
    applied = rows.map((r) => r.name);
  } catch (err) {
    // Missing migrations table: a fresh database where nothing has been applied.
    const code = (err as { code?: string }).code;
    if (code !== "42P01") throw err;
    applied = [];
  }

  const appliedSet = new Set(applied);
  const requiredSet = new Set(required);
  const pending = required.filter((n) => !appliedSet.has(n));
  const unknown = applied.filter((n) => !requiredSet.has(n));

  const base = {
    requiredVersion: latest(required),
    appliedVersion: latest(applied),
    pending,
    unknown,
  };

  if (pending.length > 0) {
    return {
      ...base,
      status: "PENDING_MIGRATIONS",
      action:
        `Database schema is behind this build: ${pending.length} pending migration(s) ` +
        `(${pending.join(", ")}). Run \`${MIGRATION_RUN_COMMAND}\` against this database, ` +
        `then retry readiness.`,
    };
  }

  if (unknown.length > 0) {
    return {
      ...base,
      status: "DATABASE_AHEAD",
      action:
        `Database has ${unknown.length} migration(s) this build does not know ` +
        `(${unknown.join(", ")}). Deploy the build that ships them, or revert them with ` +
        "`npm run migration:revert` if this rollback is intended.",
    };
  }

  return { ...base, status: "COMPATIBLE" };
}
