import { SERVICES } from "@/lib/services";
import Marketplace, { type ServiceMeta } from "@/components/Marketplace";

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

  return <Marketplace services={services} />;
}
