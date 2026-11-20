/** Generate a throwaway Solana payer, write its secret to .env.test (gitignored),
 *  print ONLY the address. Fund this address with a little USDC, then run:
 *    node --env-file=.env.test scripts/test-solana-pay.mjs
 */
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");   // 32
const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url"); // 32
const secret64 = new Uint8Array(Buffer.concat([seed, pub]));                   // 64

const signer = await createKeyPairSignerFromBytes(secret64);
writeFileSync(".env.test", `SOLANA_PAYER_SECRET=[${Array.from(secret64).join(",")}]\n`);

console.log("NEW PAYER ADDRESS:", signer.address);
console.log("→ secret written to .env.test (gitignored); fund the address above with ~$0.10 USDC on Solana.");
