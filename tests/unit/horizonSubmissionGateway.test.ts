import * as fs from "fs";
import * as path from "path";
import { HorizonSubmissionGateway } from "../../src/transactions/submission/HorizonSubmissionGateway";
import {
  AmbiguousSubmissionError,
  ProviderUnavailableError,
} from "../../src/transactions/submission/SubmissionGateway";

// The shared tests/stellar.mock.ts stub does not provide Transaction, and the
// real SDK is unnecessary here: the gateway only constructs it and hands it
// to the (stubbed) Horizon server.
jest.mock("@stellar/stellar-sdk", () => ({
  Transaction: jest
    .fn()
    .mockImplementation((envelopeXdr: string, passphrase: string) => ({
      envelopeXdr,
      passphrase,
    })),
  Horizon: { Server: jest.fn() },
}));

interface ProviderErrorCase {
  name: string;
  description: string;
  error: unknown;
  expect: "rejected" | "ambiguous";
  reason?: string;
}

const corpus = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../fixtures/horizon/providerErrors.json"),
    "utf-8"
  )
) as { submitCases: ProviderErrorCase[] };

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const ENVELOPE_XDR = "AAAAA-envelope-xdr";

function makeGateway(submitTransaction: jest.Mock) {
  const server = { submitTransaction } as never;
  return new HorizonSubmissionGateway(server, NETWORK_PASSPHRASE);
}

describe("HorizonSubmissionGateway — malformed provider error payloads", () => {
  describe.each(corpus.submitCases)("$name", (testCase) => {
    it(testCase.description, async () => {
      const gateway = makeGateway(jest.fn().mockRejectedValue(testCase.error));

      if (testCase.expect === "rejected") {
        const outcome = await gateway.submit(ENVELOPE_XDR);
        expect(outcome.status).toBe("rejected");
        if (testCase.reason) {
          expect((outcome as { reason?: string }).reason).toBe(testCase.reason);
        }
      } else {
        await expect(gateway.submit(ENVELOPE_XDR)).rejects.toBeInstanceOf(
          AmbiguousSubmissionError
        );
      }
    });
  });

  it("propagates the original provider error as the ambiguous error cause", async () => {
    const providerError = { response: { status: 503, data: "oops" } };
    const gateway = makeGateway(jest.fn().mockRejectedValue(providerError));

    await expect(gateway.submit(ENVELOPE_XDR)).rejects.toMatchObject({
      name: "AmbiguousSubmissionError",
      cause: providerError,
    });
  });
});

describe("HorizonSubmissionGateway — findTransactionByHash error mapping", () => {
  function makeLookupGateway(call: jest.Mock) {
    const server = {
      transactions: () => ({
        transaction: () => ({ call }),
      }),
    } as never;
    return new HorizonSubmissionGateway(server, NETWORK_PASSPHRASE);
  }

  it("returns null when Horizon responds 404", async () => {
    const gateway = makeLookupGateway(
      jest.fn().mockRejectedValue({ response: { status: 404 } })
    );
    await expect(gateway.findTransactionByHash("hash-1")).resolves.toBeNull();
  });

  it("maps malformed provider errors to ProviderUnavailableError", async () => {
    const gateway = makeLookupGateway(
      jest.fn().mockRejectedValue({
        response: { status: 400, data: "<html>not json</html>" },
      })
    );
    await expect(
      gateway.findTransactionByHash("hash-1")
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("returns the ledger transaction record on success", async () => {
    const gateway = makeLookupGateway(
      jest.fn().mockResolvedValue({
        hash: "hash-1",
        ledger_attr: 123,
        successful: true,
        result_xdr: "AAAA",
      })
    );
    await expect(gateway.findTransactionByHash("hash-1")).resolves.toEqual({
      hash: "hash-1",
      ledger: 123,
      successful: true,
      resultXdr: "AAAA",
    });
  });
});
