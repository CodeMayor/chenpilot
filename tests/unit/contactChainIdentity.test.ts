import ContactService from "../../src/Contacts/contact.service";
import AppDataSource from "../../src/config/Datasource";
import {
  canonicalChainIdentity,
  canonicalizeAddress,
  canonicalizeChainId,
  DuplicateRecipientError,
} from "../../src/Contacts/chainIdentity";
import { RecipientGovernanceService } from "../../src/Contacts/recipientGovernance.service";

jest.mock("../../src/config/Datasource");
jest.mock("../../src/config/logger");

describe("canonical chain identity", () => {
  it("normalizes chain identifiers case- and whitespace-insensitively", () => {
    expect(canonicalizeChainId(" Starknet ")).toBe("starknet");
    expect(canonicalizeChainId("STARKNET")).toBe("starknet");
    expect(canonicalizeChainId("stellar:mainnet")).toBe("stellar:mainnet");
  });

  it("lowercases hex-style addresses", () => {
    expect(canonicalizeAddress("0xAbCdEf0123")).toBe("0xabcdef0123");
    expect(canonicalizeAddress("DEADBEEF")).toBe("deadbeef");
    expect(canonicalizeAddress("  0xABC  ")).toBe("0xabc");
  });

  it("preserves case-sensitive address encodings", () => {
    const stellar = "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A";
    expect(canonicalizeAddress(`  ${stellar}  `)).toBe(stellar);
    expect(canonicalizeAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe(
      "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
    );
  });

  it("builds a stable identity string", () => {
    expect(canonicalChainIdentity("STRK", "0xABC")).toBe("strk:0xabc");
    expect(canonicalChainIdentity("strk", "0xabc")).toBe("strk:0xabc");
  });
});

describe("ContactService duplicate recipient detection", () => {
  let service: ContactService;
  let mockContactRepository: {
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };

  beforeEach(() => {
    mockContactRepository = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((entity) => entity),
      save: jest.fn((entity) => Promise.resolve({ id: "new-id", ...entity })),
    };
    (AppDataSource.getRepository as jest.Mock).mockReturnValue(
      mockContactRepository
    );
    service = new ContactService();
  });

  it("rejects a duplicate canonical (chain, address) for the same user", async () => {
    mockContactRepository.find.mockResolvedValue([
      {
        id: "existing-1",
        name: "alice",
        address: "0xAbCdEf",
        tokenType: "STRK",
        userId: "user-1",
      },
    ]);

    await expect(
      service.createContact(
        { name: "alice2", address: " 0xABCDEF ", tokenType: "strk" },
        "user-1"
      )
    ).rejects.toBeInstanceOf(DuplicateRecipientError);
    expect(mockContactRepository.save).not.toHaveBeenCalled();
  });

  it("allows the same address on a different chain identity", async () => {
    mockContactRepository.find.mockResolvedValue([
      {
        id: "existing-1",
        name: "alice",
        address: "0xABCDEF",
        tokenType: "STRK",
        userId: "user-1",
      },
    ]);

    const created = await service.createContact(
      { name: "alice-eth", address: "0xABCDEF", tokenType: "ETH" },
      "user-1"
    );
    expect(created.name).toBe("alice-eth");
    expect(mockContactRepository.save).toHaveBeenCalled();
  });

  it("scopes duplicate detection to the owning user", async () => {
    mockContactRepository.find.mockImplementation(({ where }) =>
      Promise.resolve(
        where.userId === "user-2"
          ? []
          : [
              {
                id: "existing-1",
                name: "alice",
                address: "0xABCDEF",
                tokenType: "STRK",
                userId: "user-1",
              },
            ]
      )
    );

    const created = await service.createContact(
      { name: "alice2", address: "0xabcdef", tokenType: "STRK" },
      "user-2"
    );
    expect(created.id).toBe("new-id");
  });

  it("saves when no canonical duplicate exists", async () => {
    const created = await service.createContact(
      { name: "bob", address: "GBOB123", tokenType: "XLM" },
      "user-1"
    );
    expect(created.name).toBe("bob");
    expect(mockContactRepository.find).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
  });
});

describe("RecipientGovernanceService duplicate identity detection", () => {
  let service: RecipientGovernanceService;

  beforeEach(() => {
    service = new RecipientGovernanceService();
  });

  it("rejects a second recipient claiming an existing canonical identity", () => {
    service.createRecipient({
      recipientId: "r1",
      identityKey: "id1",
      address: "0xAbCd",
      network: "Starknet",
    });

    expect(() =>
      service.createRecipient({
        recipientId: "r2",
        identityKey: "id2",
        address: " 0xabcd ",
        network: "starknet",
      })
    ).toThrow(DuplicateRecipientError);
  });

  it("rejects updateRecipient that collides with another recipient", () => {
    service.createRecipient({
      recipientId: "r1",
      identityKey: "id1",
      address: "0xAAA",
      network: "ethereum",
    });
    service.createRecipient({
      recipientId: "r2",
      identityKey: "id2",
      address: "0xBBB",
      network: "ethereum",
    });

    expect(() =>
      service.updateRecipient({
        recipientId: "r2",
        address: "0xaaa",
        network: "Ethereum",
      })
    ).toThrow(DuplicateRecipientError);
  });

  it("treats case-variant identical input as a no-op update, not a duplicate", () => {
    service.createRecipient({
      recipientId: "r1",
      identityKey: "id1",
      address: "0xAbC",
      network: "ethereum",
    });

    const revision = service.updateRecipient({
      recipientId: "r1",
      address: "0xabc",
      network: "ETHEREUM",
    });
    expect(revision.version).toBe(1);
    expect(service.history("r1")).toHaveLength(1);
  });

  it("allows the same address on a different network", () => {
    service.createRecipient({
      recipientId: "r1",
      identityKey: "id1",
      address: "0xABC",
      network: "ethereum",
    });

    expect(() =>
      service.createRecipient({
        recipientId: "r2",
        identityKey: "id2",
        address: "0xabc",
        network: "stellar",
      })
    ).not.toThrow();
  });
});
