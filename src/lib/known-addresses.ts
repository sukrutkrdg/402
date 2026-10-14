/**
 * known-addresses — a small, sourced registry of Base addresses that hold
 * tokens for reasons other than "a whale who might sell".
 *
 * Why it exists: dump-risk treated every GoPlus top holder that was not tagged
 * locked/burn/pool as a dumpable whale. USDC's largest Base holder is Morpho
 * Blue — a lending market, not a seller — so USDC read "exit_trap", and the
 * pre-trade bundle answered HOLD on nearly every real token.
 *
 * Rules for an entry (enforced by test/known-addresses.test.ts):
 *   - `source` is a URL that names this exact address: the protocol's own docs
 *     or deployments file, or Basescan's public name tag for it. No entry is
 *     here on recollection alone, and no label is claimed beyond what the
 *     source says.
 *   - `address` is EIP-55 checksummed.
 *   - `hasCode` records the eth_getCode result on Base (https://mainnet.base.org)
 *     at CHECKED_AT: true for every contract entry; false only where the entry
 *     is an exchange hot wallet observed as an EOA, or a burn sink.
 *
 * Kinds and what they mean for a holder:
 *   lending           tokens supplied to a money market — borrowers' collateral
 *                     and lenders' deposits, not one party's bag
 *   dex               DEX singleton / router — pooled liquidity (v4 PoolManager)
 *                     or in-flight swap balances
 *   bridge            escrow backing tokens on another chain
 *   vesting/locker    time-locked streams, LP lockers, vote-escrow, launch vaults
 *   burn              irrecoverable sinks
 *   cex               exchange wallet — pooled USER funds. Still dumpable (an
 *                     exchange can sell deposits), reported separately.
 *   protocol-treasury a protocol's reserve — controlled by governance, can sell
 *
 * Generic classes (no list needed) are detected at the call site:
 *   "dex pool" — the address is one of the token's own DexScreener pairs
 *   "vault"    — an ERC-4626 vault whose asset() is the token being read
 */

import { getAddress } from "viem";

export type KnownKind = "lending" | "dex" | "bridge" | "cex" | "vesting/locker" | "burn" | "protocol-treasury";

export interface KnownAddress {
  address: `0x${string}`;
  label: string;
  kind: KnownKind;
  /** Where this address is published under this label. */
  source: string;
  /** eth_getCode on Base was non-empty at KNOWN_ADDRESSES_CHECKED_AT. */
  hasCode: boolean;
}

/** When every `hasCode` value below was checked against https://mainnet.base.org. */
export const KNOWN_ADDRESSES_CHECKED_AT = "2026-10-14";

const AAVE = "https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Base.sol";
const MORPHO = "https://docs.morpho.org/get-started/resources/addresses/";
const COMET = (m: string) => `https://github.com/compound-finance/comet/blob/main/deployments/base/${m}/roots.json`;
const MOONWELL = "https://docs.moonwell.fi/moonwell/protocol-information/contracts";
const UNI_V2 = "https://developers.uniswap.org/docs/protocols/v2/deployments";
const UNI_V3 = "https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments";
const UNI_V4 = "https://developers.uniswap.org/docs/protocols/v4/deployments";
const AERO = "https://github.com/aerodrome-finance/contracts#deployment";
const SLIPSTREAM = "https://github.com/aerodrome-finance/slipstream#deployments";
const BASE_DOCS = "https://docs.base.org/base-chain/network-information/base-contracts";
const ACROSS = "https://github.com/across-protocol/contracts/blob/master/broadcast/deployed-addresses.json";
const STARGATE = "https://stargateprotocol.gitbook.io/stargate/v2-developer-docs/technical-reference/mainnet-contracts";
const CCTP = "https://developers.circle.com/cctp/evm-smart-contracts";
const SABLIER = (v?: string) =>
  v ? `https://docs.sablier.com/guides/lockup/previous-deployments/${v}` : "https://docs.sablier.com/guides/lockup/deployments";
const CLANKER = "https://clanker.gitbook.io/clanker-documentation/references/deployed-contracts";
const UNCX = "https://github.com/uncx-network/liquidity-locker-univ2-contracts#readme";
/** Basescan public name tag — the tag text is quoted in `label`. */
const BASESCAN = (a: string) => `https://basescan.org/address/${a}`;

const e = (address: string, label: string, kind: KnownKind, source: string, hasCode = true): KnownAddress => ({
  address: address as `0x${string}`,
  label,
  kind,
  source,
  hasCode,
});

export const KNOWN_ADDRESSES: readonly KnownAddress[] = [
  // ---- lending ----
  e("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", "Morpho Blue (Morpho)", "lending", MORPHO),
  e("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", "Aave v3 Pool", "lending", AAVE),
  e("0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", "Aave v3 aBasUSDC", "lending", AAVE),
  e("0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7", "Aave v3 aBasWETH", "lending", AAVE),
  e("0xcf3D55c10DB69f28fD1A75Bd73f3D8A2d9c595ad", "Aave v3 aBascbETH", "lending", AAVE),
  e("0x99CBC45ea5bb7eF3a5BC08FB1B7E56bB2442Ef0D", "Aave v3 aBaswstETH", "lending", AAVE),
  e("0xBdb9300b7CDE636d9cD4AFF00f6F009fFBBc8EE6", "Aave v3 aBascbBTC", "lending", AAVE),
  e("0x0a1d576f3eFeF75b330424287a95A366e8281D54", "Aave v3 aBasUSDbC", "lending", AAVE),
  e("0x7C307e128efA31F540F2E2d976C995E0B65F51F6", "Aave v3 aBasweETH", "lending", AAVE),
  e("0x90DA57E0A6C0d166Bf15764E03b83745Dc90025B", "Aave v3 aBasEURC", "lending", AAVE),
  e("0x067ae75628177FD257c2B1e500993e1a0baBcBd1", "Aave v3 aBasGHO", "lending", AAVE),
  e("0xb125E6687d4313864e53df431d5425969c15Eb2F", "Compound v3 cUSDCv3 (Comet)", "lending", COMET("usdc")),
  e("0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", "Compound v3 cUSDbCv3 (Comet)", "lending", COMET("usdbc")),
  e("0x46e6b214b524310239732D51387075E0e70970bf", "Compound v3 cWETHv3 (Comet)", "lending", COMET("weth")),
  e("0x784efeB622244d2348d4F2522f8860B96fbEcE89", "Compound v3 cAEROv3 (Comet)", "lending", COMET("aero")),
  e("0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22", "Moonwell USDC (mToken)", "lending", MOONWELL),
  e("0x628ff693426583D9a7FB391E54366292F509D457", "Moonwell WETH (mToken)", "lending", MOONWELL),
  e("0x3bf93770f2d4a794c3d9EBEfBAeBAE2a8f09A5E5", "Moonwell cbETH (mToken)", "lending", MOONWELL),
  e("0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b", "Moonwell wstETH (mToken)", "lending", MOONWELL),
  e("0xF877ACaFA28c19b96727966690b2f44d35aD5976", "Moonwell cbBTC (mToken)", "lending", MOONWELL),
  e("0x703843C3379b52F9FF486c9f5892218d2a065cC8", "Moonwell USDbC (mToken)", "lending", MOONWELL),
  e("0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6", "Moonwell AERO (mToken)", "lending", MOONWELL),
  e("0xb682c840B5F4FC58B20769E691A6fa1305A501a2", "Moonwell EURC (mToken)", "lending", MOONWELL),
  e("0xdC7810B47eAAb250De623F0eE07764afa5F71ED1", "Moonwell WELL (mToken)", "lending", MOONWELL),
  e("0xdE8Df9d942D78edE3Ca06e60712582F79CFfFC64", "Moonwell VIRTUAL (mToken)", "lending", MOONWELL),
  e("0x8F44Fd754285aa6A2b8B9B97739B79746e0475a7", "Seamless Protocol: Pool Proxy Base", "lending", BASESCAN("0x8F44Fd754285aa6A2b8B9B97739B79746e0475a7")),

  // ---- dex ----
  e("0x498581fF718922c3f8e6A244956aF099B2652b2b", "Uniswap v4 PoolManager", "dex", UNI_V4),
  e("0x6fF5693b99212Da76ad316178A184AB56D299b43", "Uniswap Universal Router", "dex", UNI_V4),
  e("0xFdf682F51FE81Aa4898F0AE2163d8A55c127fbC7", "Uniswap Universal Router 2.1.1", "dex", UNI_V4),
  e("0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40", "Uniswap Universal Router 2.1.2", "dex", UNI_V4),
  e("0x2626664c2603336E57B271c5C0b26F421741e481", "Uniswap v3 SwapRouter02", "dex", UNI_V3),
  e("0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", "Uniswap v2 Router02", "dex", UNI_V2),
  e("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", "Aerodrome Router", "dex", AERO),
  e("0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5", "Aerodrome Slipstream SwapRouter", "dex", SLIPSTREAM),
  e("0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D", "Aerodrome Slipstream SwapRouter (gauge caps deployment)", "dex", SLIPSTREAM),
  e("0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F", "Aerodrome Slipstream SwapRouter (gauges v3 deployment)", "dex", SLIPSTREAM),
  e("0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86", "PancakeSwap V3: Smart Router", "dex", BASESCAN("0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86")),
  e("0x111111125421cA6dc452d289314280a0f8842A65", "1inch: Aggregation Router V6", "dex", BASESCAN("0x111111125421cA6dc452d289314280a0f8842A65")),
  e("0x9008D19f58AAbD9eD0D60971565AA8510560ab41", "CoW Protocol: GPv2 Settlement", "dex", BASESCAN("0x9008D19f58AAbD9eD0D60971565AA8510560ab41")),

  // ---- bridge ----
  e("0x4200000000000000000000000000000000000010", "Base L2StandardBridge", "bridge", BASE_DOCS),
  e("0x4200000000000000000000000000000000000007", "Base L2CrossDomainMessenger", "bridge", BASE_DOCS),
  e("0x4200000000000000000000000000000000000016", "Base L2ToL1MessagePasser", "bridge", BASE_DOCS),
  e("0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64", "Across SpokePool (Base)", "bridge", ACROSS),
  e("0x27a16dc786820B16E5c9028b75B99F6f604b5d26", "Stargate v2 StargatePoolUSDC", "bridge", STARGATE),
  e("0xdc181Bd607330aeeBEF6ea62e03e5e1Fb4B6F7C7", "Stargate v2 StargatePoolNative", "bridge", STARGATE),
  e("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", "Circle CCTP TokenMessengerV2", "bridge", CCTP),
  e("0x1682Ae6375C4E4A97e4B583BC394c861A46D8962", "Circle: Token Messenger", "bridge", BASESCAN("0x1682Ae6375C4E4A97e4B583BC394c861A46D8962")),
  e("0x8d2de8d2f73F1F4cAB472AC9A881C9b123C79627", "Wormhole: Token Bridge", "bridge", BASESCAN("0x8d2de8d2f73F1F4cAB472AC9A881C9b123C79627")),

  // ---- vesting / locker ----
  e("0xc19a09A66887017F603E5dF420ed3Cb9a5c07C0A", "Sablier Lockup v4.0", "vesting/locker", SABLIER()),
  e("0xe261B366f231B12FCB58D6BbD71e57fAEE82431D", "Sablier Lockup v3.0", "vesting/locker", SABLIER("v3.0")),
  e("0xb5D78DD3276325f5FAF3106Cc4Acc56E28e0Fe3B", "Sablier Lockup v2.0", "vesting/locker", SABLIER("v2.0")),
  e("0x4CB16D4153123A74Bc724d161050959754f378D8", "Sablier V2 LockupLinear v1.2", "vesting/locker", SABLIER("v1.2")),
  e("0xF9E9eD67DD2Fab3b3ca024A2d66Fcf0764d36742", "Sablier V2 LockupDynamic v1.2", "vesting/locker", SABLIER("v1.2")),
  e("0xf4937657Ed8B3f3cB379Eed47b8818eE947BEb1e", "Sablier V2 LockupTranched v1.2", "vesting/locker", SABLIER("v1.2")),
  e("0xFCF737582d167c7D20A336532eb8BCcA8CF8e350", "Sablier V2 LockupLinear v1.1", "vesting/locker", SABLIER("v1.1")),
  e("0x461E13056a3a3265CEF4c593F01b2e960755dE91", "Sablier V2 LockupDynamic v1.1", "vesting/locker", SABLIER("v1.1")),
  e("0x8E845EAd15737bF71904A30BdDD3aEE76d6ADF6C", "Clanker v4 ClankerVault", "vesting/locker", CLANKER),
  e("0x56Fa0Da89eD94822e46734e736d34Cab72dF344F", "Clanker v4 ClankerAirdrop", "vesting/locker", CLANKER),
  e("0x29d17C1A8D851d7d4cA97FAe97AcAdb398D9cCE0", "Clanker v4 ClankerLpLocker", "vesting/locker", CLANKER),
  e("0x42A95190B4088C88Dd904d930c79deC1158bF09D", "Clanker v3.1 ClankerVault", "vesting/locker", CLANKER),
  e("0x33e2Eda238edcF470309b8c6D228986A1204c8f9", "Clanker v3.1 LpLockerv2", "vesting/locker", CLANKER),
  e("0x5eC4f99F342038c67a312a166Ff56e6D70383D86", "Clanker v3 LPLockerv2", "vesting/locker", CLANKER),
  e("0x618A9840691334eE8d24445a4AdA4284Bf42417D", "Clanker v2 LPLockerv2", "vesting/locker", CLANKER),
  e("0xc4E637D37113192F4F1F060DaEbD7758De7F4131", "UNCX LP Locker (Uniswap V2)", "vesting/locker", UNCX),
  e("0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4", "Aerodrome VotingEscrow (veAERO)", "vesting/locker", AERO),

  // ---- burn ----
  e("0x0000000000000000000000000000000000000000", "Null: 0x000…000 (burn)", "burn", BASESCAN("0x0000000000000000000000000000000000000000"), false),
  e("0x000000000000000000000000000000000000dEaD", "Null: 0x00…dEaD (burn)", "burn", BASESCAN("0x000000000000000000000000000000000000dEaD"), false),

  // ---- protocol treasury (controlled by governance — can sell) ----
  e("0x65A633E8E379F9358C389c75ff1D913a92ab95B8", "Moonwell Ecosystem Reserve", "protocol-treasury", MOONWELL),

  // ---- cex (Basescan public name tags; pooled user funds) ----
  e("0x71660c4005BA85c37ccec55d0C4493E66Fe775d3", "Coinbase 1", "cex", BASESCAN("0x71660c4005BA85c37ccec55d0C4493E66Fe775d3"), false),
  e("0x77696bb39917C91A0c3908D577d5e322095425cA", "Coinbase 3", "cex", BASESCAN("0x77696bb39917C91A0c3908D577d5e322095425cA"), false),
  e("0x503828976D22510aad0201ac7EC88293211D23Da", "Coinbase 12", "cex", BASESCAN("0x503828976D22510aad0201ac7EC88293211D23Da"), false),
  e("0xddfAbCdc4D8FfC6d5beaf154f18B778f892A0740", "Coinbase 23", "cex", BASESCAN("0xddfAbCdc4D8FfC6d5beaf154f18B778f892A0740"), false),
  e("0x3cD751E6b0078Be393132286c442345e5DC49699", "Coinbase 33", "cex", BASESCAN("0x3cD751E6b0078Be393132286c442345e5DC49699"), false),
  e("0xb5d85CBf7cB3EE0D56b3bB207D5Fc4B82f43F511", "Coinbase 44", "cex", BASESCAN("0xb5d85CBf7cB3EE0D56b3bB207D5Fc4B82f43F511"), false),
  e("0xeB2629a2734e272Bcc07BDA959863f316F4bD4Cf", "Coinbase 54", "cex", BASESCAN("0xeB2629a2734e272Bcc07BDA959863f316F4bD4Cf"), false),
  e("0xEe7aE85f2Fe2239E27D9c1E23fFFe168D63b4055", "Binance: Hot Wallet 34", "cex", BASESCAN("0xEe7aE85f2Fe2239E27D9c1E23fFFe168D63b4055"), true),
  e("0xF977814e90dA44bFA03b6295A0616a897441aceC", "Binance: Hot Wallet 20", "cex", BASESCAN("0xF977814e90dA44bFA03b6295A0616a897441aceC"), false),
  e("0x3c783c21a0383057D128bae431894a5C19F9Cf06", "Binance 47", "cex", BASESCAN("0x3c783c21a0383057D128bae431894a5C19F9Cf06"), false),
  e("0xBaeD383EDE0e5d9d72430661f3285DAa77E9439F", "Bybit: Hot Wallet 6", "cex", BASESCAN("0xBaeD383EDE0e5d9d72430661f3285DAa77E9439F"), false),
  e("0xf89d7b9c864f589bbF53a82105107622B35EaA40", "Bybit: Hot Wallet", "cex", BASESCAN("0xf89d7b9c864f589bbF53a82105107622B35EaA40"), false),
  e("0x7061f0B28F5a95AaE717905Bb59AA4e08C165268", "Bithumb 362", "cex", BASESCAN("0x7061f0B28F5a95AaE717905Bb59AA4e08C165268"), false),
  e("0x0529ea5885702715e83923c59746ae8734c553B7", "Bitpanda 18", "cex", BASESCAN("0x0529ea5885702715e83923c59746ae8734c553B7"), false),
  e("0x0D0707963952f2fBA59dD06f2b425ace40b492Fe", "Gate 1", "cex", BASESCAN("0x0D0707963952f2fBA59dD06f2b425ace40b492Fe"), false),
  e("0xC882b111A75C0c657fC507C04FbFcD2cC984F071", "Gate 5", "cex", BASESCAN("0xC882b111A75C0c657fC507C04FbFcD2cC984F071"), false),
  e("0x1AB4973a48dc892Cd9971ECE8e01DcC7688f8F23", "Bitget 6", "cex", BASESCAN("0x1AB4973a48dc892Cd9971ECE8e01DcC7688f8F23"), false),
  e("0x9642b23Ed1E01Df1092B92641051881a322F5D4E", "MEXC 16", "cex", BASESCAN("0x9642b23Ed1E01Df1092B92641051881a322F5D4E"), false),
];

const BY_ADDR = new Map(KNOWN_ADDRESSES.map((k) => [k.address.toLowerCase(), k]));

/** Registry match for an address (any case), or null. Never guesses. */
export function lookupKnown(address: string | null | undefined): KnownAddress | null {
  if (!address) return null;
  return BY_ADDR.get(address.trim().toLowerCase()) ?? null;
}

/** Every class a holder can be put in. Registry kinds plus the generically detected ones. */
export type HolderClass = KnownKind | "dex pool" | "vault" | "goplus-tag" | "unknown contract" | "wallet";

/** Classes that cannot market-sell the token as one party's decision. cex and
 *  protocol-treasury are deliberately absent: both can sell. */
export const NON_DUMPABLE: ReadonlySet<HolderClass> = new Set<HolderClass>([
  "lending",
  "dex",
  "bridge",
  "vesting/locker",
  "burn",
  "dex pool",
  "vault",
  "goplus-tag",
]);

const REASON: Record<HolderClass, string> = {
  lending: "lending market — pooled deposits/collateral of many users, not one seller",
  dex: "DEX contract — pooled liquidity or in-flight swap balances, not a seller",
  bridge: "bridge escrow — backs the token on another chain",
  "vesting/locker": "time-locked (vesting stream, LP/launch locker or vote-escrow)",
  burn: "burn sink — irrecoverable",
  "dex pool": "one of this token's own DEX pools — the liquidity itself",
  vault: "ERC-4626 vault for this token — pooled depositor funds",
  "goplus-tag": "GoPlus marks this holder as locked / pool / burn",
  cex: "exchange wallet — pooled user funds; the exchange can sell deposits",
  "protocol-treasury": "protocol treasury — governance-controlled, can sell",
  "unknown contract": "unlabelled contract — could be a protocol or a team multisig that can sell",
  wallet: "unlabelled wallet (EOA)",
};

export interface HolderLabel {
  /** Human label. Only ever a sourced name or a generic class — never a guess. */
  label: string;
  kind: HolderClass;
  /** Where the label comes from (URL, or the detection method). */
  source: string;
  reason: string;
  nonDumpable: boolean;
}

export interface LabelContext {
  /** Lowercased pair addresses of this token's DEX pools (DexScreener). */
  pairAddresses?: ReadonlySet<string>;
  /** Lowercased addresses confirmed as ERC-4626 vaults whose asset() is this token. */
  vaultsForToken?: ReadonlySet<string>;
  /** GoPlus already marked it locked / pool / burn. */
  goPlusNonDumpable?: boolean;
  goPlusTag?: string | null;
  isContract?: boolean | null;
}

/**
 * Classify one holder. Order: registry (sourced) → this token's own pools →
 * ERC-4626 vault for this token → GoPlus lock/pool/burn mark → contract / wallet.
 */
export function labelHolder(address: string | null | undefined, ctx: LabelContext = {}): HolderLabel {
  const a = (address ?? "").toLowerCase();
  const known = lookupKnown(a);
  const mk = (label: string, kind: HolderClass, source: string): HolderLabel => ({
    label,
    kind,
    source,
    reason: REASON[kind],
    nonDumpable: NON_DUMPABLE.has(kind),
  });
  if (known) {
    return mk(known.kind === "cex" ? `${known.label} — cex (pooled user funds)` : known.label, known.kind, known.source);
  }
  if (a && ctx.pairAddresses?.has(a)) return mk("dex pool (this token's pair)", "dex pool", "DexScreener pairs for this token");
  if (a && ctx.vaultsForToken?.has(a)) return mk("ERC-4626 vault (asset() is this token)", "vault", "onchain asset() read on Base");
  if (ctx.goPlusNonDumpable) return mk(ctx.goPlusTag ? `GoPlus: ${ctx.goPlusTag}` : "GoPlus: locked/burn", "goplus-tag", "GoPlus token_security holders");
  if (ctx.isContract) return mk("unknown contract", "unknown contract", "GoPlus is_contract");
  return mk("unlabelled wallet", "wallet", "GoPlus is_contract");
}

/** Compact registry annotation for display-only call sites (no RPC, no pairs). */
export function knownLabel(address: string | null | undefined): { label: string | null; labelKind: KnownKind | null; labelSource: string | null } {
  const k = lookupKnown(address);
  return k
    ? { label: k.kind === "cex" ? `${k.label} — cex (pooled user funds)` : k.label, labelKind: k.kind, labelSource: k.source }
    : { label: null, labelKind: null, labelSource: null };
}

/** Normalise an address for comparisons; null when it is not one. */
export function normAddr(a: string | null | undefined): string | null {
  try {
    return a ? getAddress(a.trim()).toLowerCase() : null;
  } catch {
    return null;
  }
}
