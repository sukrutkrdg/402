import { getService } from "@/lib/services";
import { TEMPLATES } from "@/lib/workflows";
import TerminalClient, { type TerminalCommand } from "./TerminalClient";

export const metadata = {
  title: "Terminal — x402 Bazaar",
  description: "Type a command, call the real paid endpoint, read the real JSON. Free tier where a service allows it, your prepaid credit token otherwise.",
};

/** Command → service. Prices and free-tier eligibility are read from the catalogue, not restated. */
const COMMANDS: Array<{ cmd: string; service: string; args: string[] }> = [
  { cmd: "risk", service: "token-risk", args: ["address"] },
  { cmd: "sell", service: "sellability", args: ["address", "size"] },
  { cmd: "gate", service: "pre-trade-gate", args: ["address", "amountUsd"] },
  { cmd: "price", service: "token-price", args: ["address"] },
];

export default function TerminalPage() {
  const commands: TerminalCommand[] = COMMANDS.flatMap((c) => {
    const s = getService(c.service);
    if (!s) return [];
    return [
      {
        cmd: c.cmd,
        service: s.id,
        name: s.name,
        price: s.price,
        // The same rule the paid route applies to `?free=1`.
        freeEligible: s.category !== "AI" && !s.noFreeTier,
        args: c.args.filter((a) => s.params.some((p) => p.name === a)),
      },
    ];
  });
  const templates = TEMPLATES.map((t) => ({ id: t.id, name: t.name, inputs: t.inputs.map((i) => ({ name: i.name, required: !!i.required })) }));
  return <TerminalClient commands={commands} templates={templates} />;
}
