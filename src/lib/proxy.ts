/**
 * Proxy / Upgradeability Detector — "can this contract be changed under you?"
 *
 * An upgradeable contract can have its logic swapped after you've approved or
 * deposited — a rug vector static token scans miss. Reads the EIP-1967 proxy
 * slots (implementation / admin / beacon) live from Base, resolves who can
 * upgrade, and flags the dangerous case: an EOA admin that can swap the logic at
 * will with no timelock or multisig.
 *
 * Free upstream (Base RPC) → stays in the standard tier.
 */

import "server-only";
import { createPublicClient, http, getAddress, type Address } from "viem";
import { base } from "viem/chains";
import { getConfig } from "./config";
import { baseTransport } from "./base-transport";

// EIP-1967 storage slots.
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as const;
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as const;
// Legacy implementation slots for broader coverage (OZ-legacy, EIP-1822 UUPS,
// and the FiatToken/USDC pattern).
const LEGACY_IMPL_SLOTS = [
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3", // OZ zeppelinos
  "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7", // EIP-1822 PROXIABLE
  "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b", // FiatToken (USDC) _IMPLEMENTATION_SLOT
] as const;

function reqAddr(raw: string): Address {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("Provide a valid 0x… contract address");
  return getAddress(v);
}

// Last 20 bytes of a 32-byte storage word → address (or null if zero).
function slotToAddress(word?: string | null): string | null {
  if (!word || word === "0x" || /^0x0*$/.test(word)) return null;
  const hex = word.slice(2).padStart(64, "0");
  const addr = "0x" + hex.slice(24);
  if (/^0x0+$/.test(addr)) return null;
  return getAddress(addr as Address);
}

export async function proxyCheck(params: Record<string, string>) {
  const address = reqAddr(params.address || "");
  const c = createPublicClient({ chain: base, transport: baseTransport(8000) });

  let implWord: string | undefined, adminWord: string | undefined, beaconWord: string | undefined;
  let code = "0x";
  try {
    [implWord, adminWord, beaconWord, code] = await Promise.all([
      c.getStorageAt({ address, slot: IMPL_SLOT }),
      c.getStorageAt({ address, slot: ADMIN_SLOT }),
      c.getStorageAt({ address, slot: BEACON_SLOT }),
      c.getBytecode({ address }).then((b) => b ?? "0x"),
    ]);
  } catch (err) {
    throw new Error(`Proxy check unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!code || code === "0x") throw new Error("Address is not a contract (no bytecode)");

  let implementation = slotToAddress(implWord);
  const admin = slotToAddress(adminWord);
  const beacon = slotToAddress(beaconWord);
  let proxyStandard = implementation ? "eip1967" : beacon ? "beacon" : null;

  // Fallback: check legacy implementation slots (OZ, EIP-1822, FiatToken/USDC).
  if (!implementation && !beacon) {
    for (const slot of LEGACY_IMPL_SLOTS) {
      try {
        const w = await c.getStorageAt({ address, slot });
        const a = slotToAddress(w);
        if (a) {
          implementation = a;
          proxyStandard = "legacy";
          break;
        }
      } catch {
        /* try next */
      }
    }
  }
  const isProxy = Boolean(implementation || beacon);

  // Who can upgrade, and is that dangerous?
  let adminType: "none" | "eoa" | "contract" = "none";
  if (admin) {
    try {
      const adminCode = await c.getBytecode({ address: admin as Address });
      adminType = adminCode && adminCode !== "0x" ? "contract" : "eoa";
    } catch {
      adminType = "eoa";
    }
  }

  const flags: string[] = [];
  if (isProxy) flags.push("upgradeable_proxy");
  if (beacon) flags.push("beacon_proxy");
  if (admin && adminType === "eoa") flags.push("eoa_admin_can_upgrade_at_will");
  if (admin && adminType === "contract") flags.push("admin_is_contract_review_timelock_multisig");
  if (isProxy && !admin) flags.push("uups_or_hidden_admin");

  // Risk: upgradeable + a single EOA admin = highest (logic can be swapped any block).
  const level = !isProxy
    ? "low"
    : admin && adminType === "eoa"
      ? "high"
      : "medium";

  return {
    address,
    isProxy,
    upgradeable: isProxy,
    proxyStandard, // eip1967 | beacon | legacy | null
    implementation, // current logic contract (can change if upgradeable)
    admin, // who can upgrade (transparent proxy)
    adminType, // none | eoa | contract
    beacon,
    upgradeRisk: level, // low (not a proxy) | medium (proxy) | high (EOA can upgrade at will)
    flags,
    note:
      isProxy
        ? "Upgradeable: the logic behind this address can be replaced. If the admin is an EOA, one key can swap the code at any time — approvals/deposits carry ongoing risk. A timelock/multisig admin is safer but still upgradeable."
        : "No EIP-1967 proxy slots set — logic is not upgradeable via the standard proxy pattern. (Other upgrade mechanisms are rare but possible.)",
    checkedAt: new Date().toISOString(),
  };
}
