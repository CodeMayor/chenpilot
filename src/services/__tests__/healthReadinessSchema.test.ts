import { computeOverall, type DependencyHealth, type HealthReport } from "../healthService";

const up: DependencyHealth = { status: "UP", latencyMs: 1 };

const deps = (schema: DependencyHealth): HealthReport["dependencies"] => ({
  database: up,
  redis: up,
  horizon: up,
  sorobanRpc: up,
  email: up,
  llm: up,
  clockSkew: up,
  schema,
});

describe("readiness with schema compatibility (#1064)", () => {
  it("is not ready (UNHEALTHY → 503) when migrations are pending", () => {
    expect(
      computeOverall(
        deps({ status: "DOWN", latencyMs: 2, error: "Run `npm run migration:run`" })
      )
    ).toBe("UNHEALTHY");
  });

  it("never reports HEALTHY when the database is ahead of the build", () => {
    expect(computeOverall(deps({ status: "DEGRADED", latencyMs: 2 }))).toBe("DEGRADED");
  });

  it("is HEALTHY only when the schema is compatible", () => {
    expect(computeOverall(deps(up))).toBe("HEALTHY");
  });
});
