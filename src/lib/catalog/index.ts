/**
 * Aggregated service catalog and fast O(1) lookup map.
 */

import type { ServiceDef } from "./types";
import { ONCHAIN_SERVICES } from "./onchain";
import { B20_SERVICES } from "./b20";
import { NEAR_SERVICES } from "./near";
import { AI_SERVICES } from "./ai";
import { MARKETS_SERVICES } from "./markets";
import { BUSINESS_SERVICES } from "./business";
import { UTILITY_SERVICES } from "./utility";

export * from "./types";
export { ONCHAIN_SERVICES } from "./onchain";
export { B20_SERVICES } from "./b20";
export { NEAR_SERVICES } from "./near";
export { AI_SERVICES } from "./ai";
export { MARKETS_SERVICES } from "./markets";
export { BUSINESS_SERVICES } from "./business";
export { UTILITY_SERVICES } from "./utility";

export const SERVICES: ServiceDef[] = [
  ...ONCHAIN_SERVICES,
  ...B20_SERVICES,
  ...NEAR_SERVICES,
  ...AI_SERVICES,
  ...MARKETS_SERVICES,
  ...BUSINESS_SERVICES,
  ...UTILITY_SERVICES,
];

// O(1) index map for ultra-fast lookup by ID
const serviceMap = new Map<string, ServiceDef>(
  SERVICES.map((s) => [s.id, s])
);

export function getService(id: string): ServiceDef | undefined {
  return serviceMap.get(id);
}
