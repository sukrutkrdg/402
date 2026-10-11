import { SERVICES } from "@/lib/services";
import PlaygroundClient from "@/components/PlaygroundClient";
import type { ServiceMeta } from "@/components/Marketplace";

export const metadata = {
  title: "API Playground & AI Console — x402 Bazaar",
  description: "Test and inspect all 225 x402 Bazaar micro-services live in your browser. Generate cURL, Python, and TypeScript code in real time.",
};

export default function PlaygroundPage() {
  const services: ServiceMeta[] = SERVICES.filter((s) => !s.hidden).map((s) => ({
    id: s.id,
    name: s.name,
    tagline: s.tagline,
    description: s.description,
    price: s.price,
    icon: s.icon,
    category: s.category,
    params: s.params,
  }));

  return <PlaygroundClient services={services} />;
}
