import {
  DataExportService,
  type UserProfileExport,
} from "../../src/services/DataExportService";
import { User } from "../../src/Auth/user.entity";
import { Contact } from "../../src/Contacts/contact.entity";
import { RefreshToken } from "../../src/Auth/refreshToken.entity";
import { memoryStore } from "../../src/Agents/memory/memory";
import AppDataSource from "../../src/config/Datasource";
import { auditLogService } from "../../src/AuditLog/auditLog.service";

jest.mock("../../src/config/Datasource");
jest.mock("../../src/Agents/memory/memory");
jest.mock("../../src/config/logger");
jest.mock("../../src/AuditLog/auditLog.service", () => ({
  auditLogService: {
    log: jest.fn().mockResolvedValue({ id: "audit-1" }),
  },
}));

const FIXED_NOW = new Date("2024-06-01T12:00:00.000Z");

function buildUser(): Partial<User> {
  return {
    id: "user-123",
    name: "testuser",
    email: "test@example.com",
    address: "GTEST123ADDRESS",
    tokenType: "XLM",
    role: "user",
    isDeployed: true,
    isFunded: true,
    isEmailVerified: true,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-15T00:00:00.000Z"),
  };
}

describe("DataExportService — deterministic export snapshots", () => {
  let service: DataExportService;
  let mockUserRepository: { findOne: jest.Mock };
  let mockContactRepository: { find: jest.Mock };
  let mockRefreshTokenRepository: { find: jest.Mock };

  beforeEach(() => {
    mockUserRepository = {
      findOne: jest.fn().mockResolvedValue(buildUser()),
    };
    mockContactRepository = {
      find: jest.fn().mockResolvedValue([
        {
          id: "contact-1",
          name: "Alice",
          address: "GALICE123",
          tokenType: "XLM",
          createdAt: new Date("2024-01-05T00:00:00.000Z"),
          updatedAt: new Date("2024-01-05T00:00:00.000Z"),
        },
      ]),
    };
    mockRefreshTokenRepository = {
      find: jest.fn().mockResolvedValue([
        {
          id: "session-1",
          createdAt: new Date("2024-01-10T00:00:00.000Z"),
          expiresAt: new Date("2024-02-10T00:00:00.000Z"),
          isRevoked: false,
        },
      ]),
    };

    (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) => {
      if (entity === User) return mockUserRepository;
      if (entity === Contact) return mockContactRepository;
      if (entity === RefreshToken) return mockRefreshTokenRepository;
      return null;
    });

    (memoryStore.get as jest.Mock).mockReturnValue(["memory entry 1"]);
    (auditLogService.log as jest.Mock).mockResolvedValue({ id: "audit-1" });

    service = new DataExportService();
  });

  it("produces byte-identical exports for repeated requests with a pinned clock", async () => {
    const first = await service.exportUserData("user-123", undefined, {
      now: FIXED_NOW,
    });
    const second = await service.exportUserData("user-123", undefined, {
      now: FIXED_NOW,
    });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.exportMetadata.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.exportMetadata.snapshotHash).toBe(
      first.exportMetadata.snapshotHash
    );
    expect(second.exportMetadata.exportDate).toBe(FIXED_NOW.toISOString());
  });

  it("produces identical JSON via exportUserDataAsJSON", async () => {
    const first = await service.exportUserDataAsJSON("user-123", {
      now: FIXED_NOW,
    });
    const second = await service.exportUserDataAsJSON("user-123", {
      now: FIXED_NOW,
    });

    expect(second).toBe(first);
  });

  it("changes the snapshot hash when exported data changes", async () => {
    const before = await service.exportUserData("user-123", undefined, {
      now: FIXED_NOW,
    });

    (memoryStore.get as jest.Mock).mockReturnValue([
      "memory entry 1",
      "memory entry 2",
    ]);

    const after = await service.exportUserData("user-123", undefined, {
      now: FIXED_NOW,
    });

    expect(after.exportMetadata.snapshotHash).not.toBe(
      before.exportMetadata.snapshotHash
    );
  });

  it("passes the pinned clock to memory expiry filtering", async () => {
    await service.exportUserData("user-123", undefined, { now: FIXED_NOW });
    expect(memoryStore.get).toHaveBeenCalledWith(
      "user-123",
      FIXED_NOW.getTime()
    );
  });

  it("orders contacts and sessions deterministically with an id tiebreak", async () => {
    await service.exportUserData("user-123", undefined, { now: FIXED_NOW });

    expect(mockContactRepository.find).toHaveBeenCalledWith({
      where: { userId: "user-123" },
      order: { createdAt: "DESC", id: "DESC" },
    });
    expect(mockRefreshTokenRepository.find).toHaveBeenCalledWith({
      where: { userId: "user-123" },
      order: { createdAt: "DESC", id: "DESC" },
    });
  });

  it("computes account age against the pinned clock", async () => {
    const exportData: UserProfileExport = await service.exportUserData(
      "user-123",
      undefined,
      { now: new Date("2024-06-01T00:00:00.000Z") }
    );

    // createdAt 2024-01-01 → ~5 months at the pinned now.
    expect(exportData.statistics.accountAge).toBe("5 months");
  });
});
