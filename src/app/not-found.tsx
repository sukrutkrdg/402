import Link from "next/link";

export const metadata = { title: "Not found — x402 Bazaar" };

export default function NotFound() {
  return (
    <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 text-center">
      <span className="pill">404</span>
      <h1 className="text-2xl font-bold tracking-tight">Page not found</h1>
      <p className="text-sm text-gray-400">
        That page doesn’t exist. Head back to the marketplace or the agent docs.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Link href="/" className="btn-primary">
          Marketplace
        </Link>
        <Link href="/agents" className="btn-ghost">
          For agents
        </Link>
      </div>
    </div>
  );
}
