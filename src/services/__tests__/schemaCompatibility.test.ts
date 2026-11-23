import {
  checkSchemaCompatibility,
  MIGRATION_RUN_COMMAND,
  type SchemaSource,
} from "../schemaCompatibility";

class CreateUsers1700000000000 {}
class AddIndex1700000000001 {}
class AddColumn1800000000000 {}

const source = (
  migrations: Array<new () => object>,
  rows: string[] | Error,
  options: SchemaSource["options"] = {}
): SchemaSource & { query: jest.Mock } => ({
  migrations: migrations.map((M) => new M()),
  options,
  query: jest.fn(async () => {
    if (rows instanceof Error) throw rows;
    return rows.map((name) => ({ name }));
  }),
});

describe("checkSchemaCompatibility (#1064)", () => {
  it("is compatible when every shipped migration is applied", async () => {
    const result = await checkSchemaCompatibility(
      source(
        [CreateUsers1700000000000, AddIndex1700000000001],
        ["CreateUsers1700000000000", "AddIndex1700000000001"]
      )
    );

    expect(result).toMatchObject({
      status: "COMPATIBLE",
      requiredVersion: "AddIndex1700000000001",
      appliedVersion: "AddIndex1700000000001",
      pending: [],
      unknown: [],
    });
    expect(result.action).toBeUndefined();
  });

  it("reports pending migrations with the migration command", async () => {
    const result = await checkSchemaCompatibility(
      source(
        [CreateUsers1700000000000, AddIndex1700000000001, AddColumn1800000000000],
        ["CreateUsers1700000000000"]
      )
    );

    expect(result.status).toBe("PENDING_MIGRATIONS");
    expect(result.pending).toEqual(["AddIndex1700000000001", "AddColumn1800000000000"]);
    expect(result.requiredVersion).toBe("AddColumn1800000000000");
    expect(result.appliedVersion).toBe("CreateUsers1700000000000");
    expect(result.action).toContain(MIGRATION_RUN_COMMAND);
    expect(result.action).toContain("AddColumn1800000000000");
  });

  it("treats a missing migrations table as a fresh database with everything pending", async () => {
    const missing = Object.assign(new Error('relation "migrations" does not exist'), {
      code: "42P01",
    });
    const result = await checkSchemaCompatibility(source([CreateUsers1700000000000], missing));

    expect(result.status).toBe("PENDING_MIGRATIONS");
    expect(result.appliedVersion).toBeNull();
    expect(result.pending).toEqual(["CreateUsers1700000000000"]);
  });

  it("flags a database that is ahead of this build without calling it compatible", async () => {
    const result = await checkSchemaCompatibility(
      source([CreateUsers1700000000000], ["CreateUsers1700000000000", "AddColumn1800000000000"])
    );

    expect(result.status).toBe("DATABASE_AHEAD");
    expect(result.unknown).toEqual(["AddColumn1800000000000"]);
    expect(result.action).toMatch(/migration:revert/);
  });

  it("propagates other database errors instead of guessing", async () => {
    const down = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    await expect(
      checkSchemaCompatibility(source([CreateUsers1700000000000], down))
    ).rejects.toThrow("connection refused");
  });

  it("queries the configured, schema-qualified migrations table", async () => {
    const s = source([], [], { migrationsTableName: "typeorm_migrations", schema: "app" });
    const result = await checkSchemaCompatibility(s);

    expect(s.query).toHaveBeenCalledWith('SELECT "name" FROM "app"."typeorm_migrations"');
    expect(result.status).toBe("COMPATIBLE");
    expect(result.requiredVersion).toBeNull();
  });
});
