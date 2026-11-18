import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — x402 Bazaar",
  description:
    "Privacy Policy for x402 Bazaar (402.com.tr). We collect minimal data — no accounts, no sign-up. What we log, why, and the third parties involved.",
  alternates: { canonical: "https://402.com.tr/privacy" },
};

const UPDATED = "18 November 2026";

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-8 text-lg font-bold text-gray-100">{children}</h2>;
}

export default function PrivacyPage() {
  return (
    <article className="mx-auto max-w-3xl text-sm leading-relaxed text-gray-300">
      <h1 className="text-2xl font-bold tracking-tight text-gray-100">Privacy Policy</h1>
      <p className="mt-2 text-xs text-gray-500">Last updated: {UPDATED}</p>

      <p className="mt-6">
        <strong className="text-gray-200">x402 Bazaar</strong> (
        <a className="text-sky-400 hover:underline" href="https://402.com.tr">402.com.tr</a>) is built to
        need as little personal data as possible. There are no accounts, no sign-up, and no API keys.
        This policy explains the limited data we do process and why.
      </p>

      <H>1. What we collect</H>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          <strong className="text-gray-200">Request data &amp; server logs</strong> — standard technical
          logs such as IP address, timestamp, endpoint called and user-agent. We use these to operate
          the Service, prevent abuse, and enforce the free tier (one free call per service per IP per
          day).
        </li>
        <li>
          <strong className="text-gray-200">Call parameters</strong> — values you pass to an endpoint,
          such as a token or wallet address. These are public on-chain identifiers, processed only to
          compute and return your result.
        </li>
        <li>
          <strong className="text-gray-200">On-chain payments</strong> — x402/USDC settlements occur on
          the public Base blockchain. The payer address, amount and transaction are public by nature of
          the chain. We do not collect card, bank or other traditional payment details.
        </li>
      </ul>
      <p className="mt-2">
        We do <strong className="text-gray-200">not</strong> ask for your name, email, or any identity
        document to use the Service. If you choose to email us, we receive whatever you send.
      </p>

      <H>2. Cookies &amp; advertising</H>
      <p className="mt-2">
        The site serves ads via <strong className="text-gray-200">Google AdSense</strong>, which may set
        cookies and process data to show and measure ads in accordance with{" "}
        <a className="text-sky-400 hover:underline" href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">Google&rsquo;s privacy policy</a>.
        We also store a small theme preference locally in your browser. Core API calls themselves do not
        require cookies.
      </p>

      <H>3. How we use data</H>
      <p className="mt-2">
        Solely to provide and secure the Service: returning your requested result, rate-limiting and
        fraud prevention, maintaining aggregate usage statistics, and debugging. We do{" "}
        <strong className="text-gray-200">not sell</strong> personal data, and we do not build advertising
        profiles beyond what the AdSense integration performs.
      </p>

      <H>4. Service providers</H>
      <p className="mt-2">We rely on a small number of processors to run the Service:</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li><strong className="text-gray-200">Vercel</strong> — hosting and edge delivery.</li>
        <li><strong className="text-gray-200">Upstash</strong> — ephemeral key-value store for rate limits, credits and caches.</li>
        <li><strong className="text-gray-200">Coinbase Developer Platform</strong> — the x402 payment facilitator.</li>
        <li><strong className="text-gray-200">Blockchain RPC &amp; data providers</strong> — to read public on-chain state.</li>
        <li><strong className="text-gray-200">Google AdSense</strong> — advertising.</li>
      </ul>

      <H>5. Retention</H>
      <p className="mt-2">
        Operational logs and rate-limit records are short-lived and kept only as long as needed for
        security and troubleshooting. On-chain records are permanent and outside our control, as they
        live on the public blockchain.
      </p>

      <H>6. Your choices</H>
      <p className="mt-2">
        Because we hold no account and minimal data, there is little tied to you personally. You can use
        the Service without providing identifying information, control cookies through your browser or
        Google&rsquo;s ad settings, and contact us with any privacy request at the address below.
      </p>

      <H>7. Children</H>
      <p className="mt-2">
        The Service is not directed to children under 18 and is intended for developers and autonomous
        agents.
      </p>

      <H>8. Changes</H>
      <p className="mt-2">
        We may update this policy; the &ldquo;Last updated&rdquo; date above reflects the latest version.
      </p>

      <H>9. Contact</H>
      <p className="mt-2">
        Operated from Türkiye. Questions or requests:{" "}
        <a className="text-sky-400 hover:underline" href="mailto:sukrutkrdg@gmail.com">sukrutkrdg@gmail.com</a>.
      </p>

      <p className="mt-8 text-xs text-gray-500">
        See also our{" "}
        <a className="text-sky-400 hover:underline" href="/terms">Terms of Service</a>.
      </p>
    </article>
  );
}
