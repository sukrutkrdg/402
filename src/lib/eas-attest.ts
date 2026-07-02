/**
 * On-chain Scam Registry via EAS (Ethereum Attestation Service) on Base.
 *
 * When the scout catches a scam, we publish a verifiable on-chain attestation to
 * Base EAS — a public, tamper-proof record that "x402 Bazaar flagged token X as a
 * honeypot at time T". This turns our scam detection into a public good, gives us
 * real meaningful Base on-chain footprint, and is exactly the Base-native building
 * (EAS is a Base predeploy, Coinbase-backed) that gets a builder noticed.
 *
 * Best-effort: never throws into the caller. Gated on config (schema UID + a
 * signer wallet with a little ETH on Base for gas).
 *
 * ONE-TIME SETUP (see registerScamSchema below or docs):
 *   Register the schema, then set EAS_SCHEMA_UID. Fund EAS_SIGNER_KEY (or the
 *   reused BUYER_PRIVATE_KEY) with a few cents of ETH on Base for gas.
 *
 * Schema: "address token,string symbol,string scamType,string reasons,uint64 detectedAt"
 */

import "server-only";
import {
  createWalletClient,
  http,
  encodeAbiParameters,
  parseAbiParameters,
  encodePacked,
  keccak256,
  getAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { getConfig } from "./config";

// EAS predeploys on Base mainnet.
const EAS = "0x4200000000000000000000000000000000000021" as const;
const SCHEMA_REGISTRY = "0x4200000000000000000000000000000000000020" as const;

const EAS_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "schema", type: "bytes32" },
          {
            components: [
              { name: "recipient", type: "address" },
              { name: "expirationTime", type: "uint64" },
              { name: "revocable", type: "bool" },
              { name: "refUID", type: "bytes32" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
            ],
            name: "data",
            type: "tuple",
          },
        ],
        name: "request",
        type: "tuple",
      },
    ],
    name: "attest",
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "payable",
    type: "function",
  },
] as const;

const SCHEMA_REGISTRY_ABI = [
  {
    inputs: [
      { name: "schema", type: "string" },
      { name: "resolver", type: "address" },
      { name: "revocable", type: "bool" },
    ],
    name: "register",
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const SCHEMA_STRING = "address token,string symbol,string scamType,string reasons,uint64 detectedAt";
const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

function signerKey(): Hex | null {
  const raw = process.env.EAS_SIGNER_KEY?.trim() || getConfig().buyerPrivateKey;
  if (!raw) return null;
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

function wallet() {
  const key = signerKey();
  if (!key) return null;
  const account = privateKeyToAccount(key);
  return createWalletClient({ account, chain: base, transport: http(getConfig().rpcUrl) });
}

export function easEnabled(): boolean {
  return Boolean(process.env.EAS_SCHEMA_UID?.trim() && signerKey());
}

export interface ScamAttestation {
  uid: string;
  txHash: string;
  scanUrl: string;
}

/** Publish a scam attestation on Base EAS. Best-effort → returns null on any failure. */
export async function attestScam(input: {
  token: string;
  symbol?: string | null;
  scamType: string; // "honeypot" | "unsellable" | "extreme_tax" | ...
  reasons: string[];
}): Promise<ScamAttestation | null> {
  try {
    const schemaUid = process.env.EAS_SCHEMA_UID?.trim();
    const w = wallet();
    if (!schemaUid || !w) return null;

    const token = getAddress(input.token);
    const data = encodeAbiParameters(
      parseAbiParameters(SCHEMA_STRING),
      [token, input.symbol || "", input.scamType, input.reasons.join("; "), BigInt(Math.floor(Date.now() / 1000))],
    );

    const txHash = await w.writeContract({
      address: EAS,
      abi: EAS_ABI,
      functionName: "attest",
      args: [
        {
          schema: schemaUid as Hex,
          data: {
            recipient: token, // the flagged token is the subject
            expirationTime: 0n,
            revocable: true,
            refUID: ZERO32,
            data,
            value: 0n,
          },
        },
      ],
    });

    // The attestation UID is emitted in the receipt; the tx hash is enough for a
    // public link. Return the tx as the verifiable pointer (UID resolvable from it).
    return {
      uid: txHash, // tx serves as the on-chain proof pointer
      txHash,
      scanUrl: `https://base.easscan.org/attestation/tx/${txHash}`,
    };
  } catch {
    return null; // never break the caller
  }
}

/**
 * ONE-TIME: register the scam schema and return its UID. Run this once (e.g. from
 * a script or admin call) with a funded signer, then set EAS_SCHEMA_UID to the
 * returned value. Not called at runtime.
 */
export async function registerScamSchema(): Promise<{ txHash: string; schemaUid: string } | null> {
  try {
    const w = wallet();
    if (!w) return null;
    const txHash = await w.writeContract({
      address: SCHEMA_REGISTRY,
      abi: SCHEMA_REGISTRY_ABI,
      functionName: "register",
      args: [SCHEMA_STRING, ZERO_ADDR, true],
    });
    return { txHash, schemaUid: computeSchemaUid() };
  } catch {
    return null;
  }
}

/** EAS schema UID is deterministic: keccak256(abi.encodePacked(schema, resolver, revocable)). */
export function computeSchemaUid(): string {
  return keccak256(encodePacked(["string", "address", "bool"], [SCHEMA_STRING, ZERO_ADDR, true]));
}
