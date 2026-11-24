import crypto from "crypto";
import {
  canonicalChainIdentity,
  DuplicateRecipientError,
} from "./chainIdentity";

export type RecipientRevisionStatus = "pending_verification" | "verified" | "superseded";

export interface RecipientRevision {
  revisionId: string;
  recipientId: string;
  identityKey: string;
  address: string;
  network: string;
  version: number;
  status: RecipientRevisionStatus;
  createdAt: string;
  verifiedAt?: string;
  supersededAt?: string;
}

export interface PreparedTransfer {
  transferId: string;
  recipientId: string;
  approvedRevisionId: string;
  approvalHash: string;
}

export class RecipientGovernanceService {
  private readonly revisions = new Map<string, RecipientRevision[]>();

  createRecipient(input: { recipientId: string; identityKey: string; address: string; network: string }, now = new Date()): RecipientRevision {
    this.assertNoDuplicateIdentity(input.network, input.address, input.recipientId);
    const revision = this.revision(input, 1, "pending_verification", now);
    this.revisions.set(input.recipientId, [revision]);
    return revision;
  }

  verifyRevision(recipientId: string, revisionId: string, now = new Date()): RecipientRevision {
    const revision = this.mustFind(recipientId, revisionId);
    revision.status = "verified";
    revision.verifiedAt = now.toISOString();
    return { ...revision };
  }

  updateRecipient(input: { recipientId: string; address: string; network: string }, now = new Date()): RecipientRevision {
    const history = this.revisions.get(input.recipientId);
    if (!history?.length) {
      throw new Error(`Unknown recipient: ${input.recipientId}`);
    }

    const current = history[history.length - 1];
    if (
      canonicalChainIdentity(current.network, current.address) ===
      canonicalChainIdentity(input.network, input.address)
    ) {
      return { ...current };
    }

    this.assertNoDuplicateIdentity(input.network, input.address, input.recipientId);

    current.status = "superseded";
    current.supersededAt = now.toISOString();
    const next = this.revision(
      { ...input, identityKey: current.identityKey },
      current.version + 1,
      "pending_verification",
      now,
    );
    history.push(next);
    return { ...next };
  }

  prepareTransfer(input: { transferId: string; recipientId: string; revisionId: string; amount: string; asset: string }): PreparedTransfer {
    const revision = this.mustFind(input.recipientId, input.revisionId);
    if (revision.status !== "verified") {
      throw new Error("Recipient revision must be verified before transfer approval");
    }

    const approvalHash = crypto.createHash("sha256").update(JSON.stringify({ ...input, address: revision.address, network: revision.network })).digest("hex");
    return { transferId: input.transferId, recipientId: input.recipientId, approvedRevisionId: revision.revisionId, approvalHash };
  }

  submitTransfer(transfer: PreparedTransfer): RecipientRevision {
    const revision = this.mustFind(transfer.recipientId, transfer.approvedRevisionId);
    if (revision.status !== "verified") {
      throw new Error("Prepared transfer is bound to a recipient revision that is no longer verified");
    }
    return { ...revision };
  }

  history(recipientId: string): RecipientRevision[] {
    return (this.revisions.get(recipientId) ?? []).map((revision) => ({ ...revision }));
  }

  /**
   * Reject identities already claimed by a different recipient's latest
   * (non-superseded) revision, comparing canonical chain identity so case
   * and whitespace variants cannot bypass the check.
   */
  private assertNoDuplicateIdentity(
    network: string,
    address: string,
    recipientId: string
  ): void {
    const identity = canonicalChainIdentity(network, address);
    for (const [otherId, history] of this.revisions) {
      if (otherId === recipientId || history.length === 0) {
        continue;
      }
      const latest = history[history.length - 1];
      if (
        canonicalChainIdentity(latest.network, latest.address) === identity
      ) {
        throw new DuplicateRecipientError(identity, latest.revisionId);
      }
    }
  }

  private revision(input: { recipientId: string; identityKey: string; address: string; network: string }, version: number, status: RecipientRevisionStatus, now: Date): RecipientRevision {
    const revisionId = crypto.createHash("sha256").update(`${input.recipientId}:${version}:${input.address}:${input.network}`).digest("hex").slice(0, 16);
    return { ...input, revisionId, version, status, createdAt: now.toISOString() };
  }

  private mustFind(recipientId: string, revisionId: string): RecipientRevision {
    const revision = this.revisions.get(recipientId)?.find((item) => item.revisionId === revisionId);
    if (!revision) {
      throw new Error(`Unknown recipient revision: ${revisionId}`);
    }
    return revision;
  }
}
