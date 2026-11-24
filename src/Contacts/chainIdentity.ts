/**
 * Canonical chain identity for recipients.
 *
 * A recipient is identified by the pair (chain, address). Raw user input
 * varies in case and whitespace, so duplicates must be detected on a
 * canonical form rather than the raw strings.
 */

/**
 * Normalize a chain/network identifier: trimmed and lowercased so that
 * "Starknet", "STARKNET" and " starknet " all resolve to the same chain.
 */
export function canonicalizeChainId(chain: string): string {
  return chain.trim().toLowerCase();
}

/**
 * Normalize an on-chain address for duplicate detection.
 *
 * - Hex-style addresses (EVM `0x…`, StarkNet felt252, bare hex) are
 *   case-insensitive, so they are lowercased.
 * - Case-sensitive encodings (Stellar StrKey `G…`/`M…`, base58) are preserved
 *   as-is after trimming.
 */
export function canonicalizeAddress(address: string): string {
  const trimmed = address.trim();
  if (/^0x[0-9a-f]*$/i.test(trimmed) || /^[0-9a-f]+$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

/**
 * Canonical identity string for a (chain, address) pair. Two recipients with
 * the same canonical chain identity are duplicates.
 */
export function canonicalChainIdentity(chain: string, address: string): string {
  return `${canonicalizeChainId(chain)}:${canonicalizeAddress(address)}`;
}

/**
 * Thrown when a recipient is created or updated to an identity that already
 * exists for the same owner.
 */
export class DuplicateRecipientError extends Error {
  constructor(
    public readonly chainIdentity: string,
    public readonly existingRecipientId?: string
  ) {
    super(
      `Duplicate recipient: canonical chain identity "${chainIdentity}" already exists`
    );
    this.name = "DuplicateRecipientError";
  }
}
