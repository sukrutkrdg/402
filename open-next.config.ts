import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Default Cloudflare adapter config. Incremental cache / tag cache can be wired
// to Cloudflare KV or R2 later; our public data routes are force-dynamic, so the
// default (no durable cache) is fine to start.
export default defineCloudflareConfig();
