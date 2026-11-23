# Running the JWT Migration

## Quick Start

Run this command to create the refresh_token table:

```bash
npm run migration:run
```

## What This Does

The migration will:

1. Create the `refresh_token` table
2. Add all necessary columns
3. Create an index on the `token` column for fast lookups
4. Add a foreign key to the `user` table with cascade delete

## Expected Output

```
query: SELECT * FROM current_schema()
query: SELECT version();
query: SELECT * FROM "information_schema"."tables" WHERE "table_schema
```

## Startup Schema Compatibility Check (#1064)

Migrations are never applied automatically. On boot, and on every `GET /ready`,
the service compares the migrations shipped in this build with the rows in the
TypeORM `migrations` table:

| State | `dependencies.schema.status` | `/ready` |
|---|---|---|
| All shipped migrations applied | `UP` | 200 (if other critical deps are up) |
| Pending migrations | `DOWN` | **503**, `error` says: run `npm run migration:run` |
| Database has migrations this build doesn't ship | `DEGRADED` | 200, `overallStatus: "DEGRADED"` |
| Migration state can't be read | `DOWN` | **503** |

Startup logs `Database schema mismatch` with the pending migration names and the
command to run. After running `npm run migration:run`, readiness recovers on the
next probe without a restart.
