/**
 * Alternate route path for RE-INDEXING stuck services.
 *
 * When a service's first settlement happened while its /api/x402/{id} resource
 * was free-tier / echo-broken, the CDP facilitator stamped that exact URL
 * "not paywalled" and never re-indexes it — re-paying the same URL doesn't help.
 * The stamp is keyed on the resource URL, and per CDP's own docs a distinct PATH
 * segment (not a query param) creates a distinct resource. So the stuck services
 * advertise their canonical resource as /api/x402r/{id}, served by this route,
 * which delegates to the exact same handler. Agents call whichever URL the
 * discovery index shows; both paths behave identically.
 *
 * Next.js route segment config must be statically declared here (it can't be
 * re-exported), so we redeclare it and wrap the shared GET.
 */
import { NextRequest } from "next/server";
import { GET as baseGET } from "@/app/api/x402/[service]/route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function GET(req: NextRequest, ctx: { params: Promise<{ service: string }> }) {
  return baseGET(req, ctx);
}
