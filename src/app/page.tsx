import { SERVICES } from "@/lib/services";
import Marketplace, { type ServiceMeta } from "@/components/Marketplace";
import { Providers } from "./app/providers";

export default function Home() {
  // Strip the server-only handler before handing the catalog to the client.
  const services: ServiceMeta[] = SERVICES.map((s) => ({
    id: s.id,
    name: s.name,
    tagline: s.tagline,
    description: s.description,
    price: s.price,
    icon: s.icon,
    category: s.category,
    params: s.params,
  }));

  // Wrap in the wagmi provider so every service card can charge the visitor's
  // own browser wallet over x402.
  return (
    <Providers>
      <Marketplace services={services} />
    </Providers>
  );
}
