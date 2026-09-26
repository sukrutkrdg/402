/**
 * NEAR account analysis — the NEAR counterpart of wallet-summary/address-trust:
 * before an agent pays, trusts or trades with a NEAR account, what is it?
 *
 *   - does it exist, and what kind of id is it (named, implicit, 0x eth-implicit)
 *   - how much NEAR it holds: liquid, staked, and what storage keeps locked
 *   - is it a contract, and if so a NEP-141 token
 *   - who controls it: full-access keys (can do anything, incl. redeploy code)
 *     and function-call keys (limited to one contract's methods, with allowance)
 *
 * On NEAR the account's keys ARE its control model, so the flags say it plainly:
 * a wallet held by one key, a contract anyone with a key can replace, a locked
 * contract, or an account nobody can sign for at all.
 */

import "server-only";
import {
  NEAR_ACCOUNT_RE,
  EMPTY_CODE_HASH,
  STORAGE_YOCTO_PER_BYTE,
  rpcQuery,
  viewCall,
  formatUnits,
  accountKind,
} from "./near-rpc";

interface AccessKey {
  public_key: string;
  access_key: {
    nonce: number;
    permission: "FullAccess" | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
  };
}

export async function nearAccount(params: Record<string, string>) {
  const id = (params.account || params.address || "").trim().toLowerCase();
  if (!NEAR_ACCOUNT_RE.test(id)) {
    throw new Error("Provide a NEAR account, e.g. alice.near, a 64-hex implicit account, or a 0x eth-implicit account");
  }
  const checkedAt = new Date().toISOString();
  const kind = accountKind(id);
  const base = { chain: "near" as const, account: id, kind, checkedAt };

  const acct = await rpcQuery<{ amount: string; locked: string; code_hash: string; storage_usage: number }>({
    request_type: "view_account",
    account_id: id,
  });
  if (!acct.ok) {
    if (acct.unknownAccount) {
      return {
        ...base,
        exists: false,
        flags: [
          kind === "implicit" || kind === "eth-implicit"
            ? "Not created yet. An implicit account comes into existence when it is first funded — sending NEAR here creates it, and the holder of its key controls it."
            : "No such account. A named account must be created before it can receive anything — funds sent here would fail.",
        ],
      };
    }
    throw new Error(`NEAR RPC error (${acct.message}) — not charged, retry shortly`);
  }

  const a = acct.value;
  const liquid = BigInt(a.amount);
  const storageLocked = BigInt(a.storage_usage) * STORAGE_YOCTO_PER_BYTE;
  const available = liquid > storageLocked ? liquid - storageLocked : 0n;
  const isContract = a.code_hash !== EMPTY_CODE_HASH;

  const [keysRes, ftMeta] = await Promise.all([
    rpcQuery<{ keys: AccessKey[] }>({ request_type: "view_access_key_list", account_id: id }),
    isContract ? viewCall<{ symbol?: string; decimals?: number }>(id, "ft_metadata") : Promise.resolve(null),
  ]);
  const keys = keysRes.ok ? keysRes.value.keys : null;
  const fullAccess = keys ? keys.filter((k) => k.access_key.permission === "FullAccess").length : null;
  const functionCall = keys
    ? keys.flatMap((k) =>
        k.access_key.permission === "FullAccess"
          ? []
          : [
              {
                contract: k.access_key.permission.FunctionCall.receiver_id,
                methods: k.access_key.permission.FunctionCall.method_names.length
                  ? k.access_key.permission.FunctionCall.method_names
                  : "any",
                allowanceNear:
                  k.access_key.permission.FunctionCall.allowance === null
                    ? "unlimited"
                    : formatUnits(k.access_key.permission.FunctionCall.allowance, 24),
              },
            ],
      )
    : null;

  const flags: string[] = [];
  const isToken = Boolean(ftMeta && typeof ftMeta.decimals === "number");
  if (fullAccess === null) {
    flags.push("Access keys could not be read — who controls this account is unknown.");
  } else if (isContract) {
    if (fullAccess > 0)
      flags.push(`Contract, upgradeable by key: ${fullAccess} full-access key${fullAccess === 1 ? "" : "s"} can redeploy its code.`);
    else flags.push("Locked contract: no full-access key; its code changes only through its own methods.");
  } else if (fullAccess > 0) {
    flags.push(`Wallet controlled by ${fullAccess} full-access key${fullAccess === 1 ? "" : "s"}${fullAccess > 1 ? " — any one of them can move everything" : ""}.`);
  } else {
    flags.push("No full-access key and no contract: nobody can sign a transfer from this account — anything sent here is stuck.");
  }
  if (isToken) flags.push(`This is a NEP-141 token contract (${ftMeta?.symbol ?? "?"}) — for token checks use near-token-safety.`);
  if (functionCall && functionCall.some((k) => k.allowanceNear === "unlimited"))
    flags.push("Has a function-call key with unlimited gas allowance.");
  if (BigInt(a.locked) > 0n) flags.push("Holds staked (locked) NEAR — a validator or staking account.");
  if (kind === "sub-account")
    flags.push(`Sub-account of ${id.slice(id.indexOf(".") + 1)}: created by it, but after creation the parent holds no control unless it also holds a key.`);

  return {
    ...base,
    exists: true,
    balance: {
      totalNear: formatUnits(a.amount, 24),
      availableNear: formatUnits(available.toString(), 24),
      storageLockedNear: formatUnits(storageLocked.toString(), 24),
      stakedNear: formatUnits(a.locked, 24),
    },
    storageBytes: a.storage_usage,
    contract: { deployed: isContract, codeHash: isContract ? a.code_hash : null, isToken, symbol: isToken ? (ftMeta?.symbol ?? null) : null },
    control: {
      fullAccessKeys: fullAccess,
      functionCallKeys: functionCall ? functionCall.length : null,
      functionCallGrants: functionCall ? functionCall.slice(0, 10) : null,
    },
    flags,
  };
}
