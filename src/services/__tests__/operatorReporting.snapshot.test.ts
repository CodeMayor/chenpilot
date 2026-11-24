import { OperatorReportingService } from "../operatorReporting.service";
import AppDataSource from "../../config/Datasource";
import { AgentExecutionMetrics } from "../../Agents/agentExecutionMetrics.entity";
import { AuditLog } from "../../AuditLog/auditLog.entity";
import { BotSession } from "../../Bot/botSession.entity";

jest.mock("../../config/Datasource");
jest.mock("../../config/logger");
jest.mock("../contracts", () => ({
  contractMetadataRegistry: {
    listContracts: jest.fn(() => [
      {
        key: "contract-a",
        capabilities: [{ name: "payments" }, { name: "transfers" }],
        bindings: [{ enabled: true }, { enabled: false }],
      },
      {
        key: "contract-b",
        capabilities: [{ name: "payments" }],
        bindings: [{ enabled: true }],
      },
    ]),
  },
}));

function createQueryBuilder() {
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    clone: jest.fn(),
    getCount: jest.fn(),
    getRawMany: jest.fn(),
    getRawOne: jest.fn(),
  };
  qb.clone.mockReturnValue(qb);
  return qb;
}

type QueryBuilderMock = ReturnType<typeof createQueryBuilder>;

const FIXED_PERIOD = {
  startDate: new Date("2024-03-01T00:00:00.000Z"),
  endDate: new Date("2024-03-02T00:00:00.000Z"),
};

// GROUP BY row order is deliberately scrambled: the service must emit
// deterministic, sorted count maps regardless of DB row order.
const STATUS_ROWS = [
  { key: "failed", count: "1" },
  { key: "success", count: "3" },
];
const AGENT_ROWS = [
  { key: "executor", count: "2" },
  { key: "planner", count: "2" },
];
const ACTION_ROWS = [
  { key: "contract.invoke", count: "6" },
  { key: "data_export", count: "4" },
];
const PLATFORM_ROWS = [
  { key: "slack", count: "2" },
  { key: "discord", count: "1" },
];

describe("OperatorReportingService — deterministic export snapshots", () => {
  let service: OperatorReportingService;
  let executionQb: QueryBuilderMock;
  let auditQb: QueryBuilderMock;
  let botSessionQb: QueryBuilderMock;

  function primeMocks() {
    executionQb.getCount.mockReset().mockResolvedValue(4);
    executionQb.getRawMany
      .mockReset()
      .mockResolvedValueOnce(STATUS_ROWS)
      .mockResolvedValueOnce(AGENT_ROWS)
      .mockResolvedValue([]);
    executionQb.getRawOne.mockReset().mockResolvedValue({ average: "120.5" });

    auditQb.getCount
      .mockReset()
      .mockResolvedValueOnce(10) // totalEvents
      .mockResolvedValueOnce(6) // contractActions
      .mockResolvedValueOnce(2) // securityEvents
      .mockResolvedValue(0);
    auditQb.getRawMany.mockReset().mockResolvedValue(ACTION_ROWS);
    auditQb.getRawOne.mockReset();

    botSessionQb.getCount
      .mockReset()
      .mockResolvedValueOnce(3) // active
      .mockResolvedValueOnce(1) // expired
      .mockResolvedValue(0);
    botSessionQb.getRawMany.mockReset().mockResolvedValue(PLATFORM_ROWS);
    botSessionQb.getRawOne.mockReset();
  }

  beforeEach(() => {
    executionQb = createQueryBuilder();
    auditQb = createQueryBuilder();
    botSessionQb = createQueryBuilder();
    primeMocks();

    (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) => {
      if (entity === AgentExecutionMetrics) {
        return { createQueryBuilder: jest.fn(() => executionQb) };
      }
      if (entity === AuditLog) {
        return { createQueryBuilder: jest.fn(() => auditQb) };
      }
      if (entity === BotSession) {
        return { createQueryBuilder: jest.fn(() => botSessionQb) };
      }
      return null;
    });

    service = new OperatorReportingService();
  });

  it("returns identical reports and snapshot hashes for repeated requests", async () => {
    const first = await service.buildReport(FIXED_PERIOD);
    primeMocks();
    const second = await service.buildReport(FIXED_PERIOD);

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pins the report period to asOf when no explicit dates are given", async () => {
    const asOf = new Date("2024-05-10T12:00:00.000Z");

    const first = await service.buildReport({ asOf });
    primeMocks();
    const second = await service.buildReport({ asOf });

    expect(first.periodEnd).toBe(asOf.toISOString());
    expect(first.periodStart).toBe(
      new Date(asOf.getTime() - 24 * 60 * 60 * 1000).toISOString()
    );
    expect(second.snapshotHash).toBe(first.snapshotHash);
  });

  it("sorts count-map keys regardless of GROUP BY row order", async () => {
    const report = await service.buildReport(FIXED_PERIOD);

    expect(Object.keys(report.execution.byStatus)).toEqual([
      "failed",
      "success",
    ]);
    expect(Object.keys(report.execution.byAgentType)).toEqual([
      "executor",
      "planner",
    ]);
    expect(Object.keys(report.audit.byAction)).toEqual([
      "contract.invoke",
      "data_export",
    ]);
    expect(Object.keys(report.botSessions.byPlatform)).toEqual([
      "discord",
      "slack",
    ]);
  });

  it("produces a different snapshot hash when the underlying data changes", async () => {
    const before = await service.buildReport(FIXED_PERIOD);

    primeMocks();
    executionQb.getCount.mockReset().mockResolvedValue(5);
    executionQb.getRawMany
      .mockReset()
      .mockResolvedValueOnce([
        { key: "failed", count: "1" },
        { key: "success", count: "4" },
      ])
      .mockResolvedValueOnce([
        { key: "executor", count: "2" },
        { key: "planner", count: "3" },
      ])
      .mockResolvedValue([]);

    const after = await service.buildReport(FIXED_PERIOD);

    expect(after.snapshotHash).not.toBe(before.snapshotHash);
  });
});
