/**
 * `/mcp` — the address people actually type.
 *
 * The hosted MCP server lives at `/api/mcp`. This mounts the same handlers at
 * the short path, because that is the shape every connector UI, directory
 * listing and piece of documentation assumes: `https://<host>/mcp`. Smithery's
 * publish flow, Claude's custom-connector dialog and ChatGPT's connector field
 * all take a bare URL, and a reviewer who tries the obvious one and gets a 404
 * does not try the second one.
 *
 * Delegated rather than redirected: a 307 on a JSON-RPC POST is honoured by some
 * clients and quietly dropped by others, and the ones that drop it fail in a way
 * that looks like our server is broken.
 *
 * The route segment config has to be declared here rather than re-exported —
 * Next collects it per file at build time, not through a barrel.
 */

import type { NextRequest } from "next/server";
import { POST as mcpPost, OPTIONS as mcpOptions, GET as mcpGet } from "../api/mcp/route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function POST(req: NextRequest) {
  return mcpPost(req);
}

export function OPTIONS() {
  return mcpOptions();
}

export function GET() {
  return mcpGet();
}
