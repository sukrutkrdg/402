import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service — x402 Bazaar",
  description:
    "Terms of Service for x402 Bazaar (402.com.tr): a pay-per-call API marketplace for AI agents on Base and NEAR. Informational data only, non-custodial, no accounts.",
  alternates: { canonical: "https://402.com.tr/terms" },
};

const UPDATED = "18 November 2026";

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-8 text-lg font-bold text-gray-100">{children}</h2>;
}

export default function TermsPage() {
  return (
    <article className="mx-auto max-w-3xl text-sm leading-relaxed text-gray-300">
      <h1 className="text-2xl font-bold tracking-tight text-gray-100">Terms of Service</h1>
      <p className="mt-2 text-xs text-gray-500">Last updated: {UPDATED}</p>

      <p className="mt-6">
        These Terms govern your use of <strong className="text-gray-200">x402 Bazaar</strong> at{" "}
        <a className="text-sky-400 hover:underline" href="https://402.com.tr">402.com.tr</a>{" "}
        (the &ldquo;Service&rdquo;), a pay-per-call API marketplace for software agents on the Base and
        NEAR networks. By calling an endpoint, making a payment, or otherwise using the Service, you
        agree to these Terms. If you are using the Service on behalf of an organisation or an
        autonomous agent you operate, you accept these Terms for that party.
      </p>

      <H>1. What the Service is</H>
      <p className="mt-2">
        The Service exposes HTTP endpoints that return data and computed results — on-chain token and
        wallet analytics, risk checks, swap route construction, and AI-generated reports. Each call is
        paid with a small USDC micro-payment over the{" "}
        <strong className="text-gray-200">x402</strong> protocol settled on Base mainnet, or debited
        from prepaid credits. There are no user accounts, no sign-up, and no API keys.
      </p>

      <H>2. No financial advice</H>
      <p className="mt-2">
        All outputs — including any verdict such as SAFE, CAUTION or AVOID, risk scores, size
        suggestions, prices and reports — are <strong className="text-gray-200">informational only</strong>{" "}
        and are <strong className="text-gray-200">not financial, investment, legal or tax advice</strong>,
        and not a recommendation to buy, sell or hold any asset. On-chain markets are volatile and
        risky. You are solely responsible for your own decisions and transactions. Do your own research.
      </p>

      <H>3. Non-custodial</H>
      <p className="mt-2">
        The Service never takes custody of your funds and never holds your private keys. Where an
        endpoint builds a swap or transaction, it returns an unsigned payload; nothing moves until{" "}
        <strong className="text-gray-200">you</strong> sign and broadcast it from your own wallet. You
        are responsible for reviewing any transaction before signing.
      </p>

      <H>4. Payments, credits and refunds</H>
      <p className="mt-2">
        Prices are shown per endpoint and charged in USDC on Base. A call whose required safety check
        could not run is returned as <strong className="text-gray-200">UNKNOWN / degraded and is not
        charged</strong>. Because settlements are on-chain and final, completed payments are generally
        non-refundable except where a charge was taken for a call that returned an error on our side; in
        that case contact us and we will review it. Prepaid credit balances are consumed per call and
        are non-transferable.
      </p>

      <H>5. Acceptable use</H>
      <p className="mt-2">You agree not to:</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>use the Service for any unlawful purpose, or to facilitate sanctioned, fraudulent or criminal activity;</li>
        <li>attempt to overload, disrupt, reverse the rate limits of, or gain unauthorised access to the Service or its infrastructure;</li>
        <li>abuse the free tier (one free call per service per IP per day) through automated evasion; or</li>
        <li>resell or redistribute the outputs in a way that misrepresents them as independent, guaranteed or advisory.</li>
      </ul>

      <H>6. Third-party data and networks</H>
      <p className="mt-2">
        The Service reads public blockchain data and relies on third parties — including the Base and
        NEAR networks, the x402 facilitator, RPC and data providers, and hosting infrastructure. We do
        not control these and are not responsible for their availability, accuracy or fees. On-chain
        data can be incomplete, delayed or manipulated.
      </p>

      <H>7. No warranty</H>
      <p className="mt-2">
        The Service is provided <strong className="text-gray-200">&ldquo;as is&rdquo; and &ldquo;as
        available&rdquo;</strong>, without warranties of any kind, express or implied, including
        merchantability, fitness for a particular purpose, accuracy, or non-infringement. We do not
        warrant that any output is correct, complete, or that any token flagged SAFE is in fact safe or
        that any token flagged AVOID is in fact unsafe.
      </p>

      <H>8. Limitation of liability</H>
      <p className="mt-2">
        To the maximum extent permitted by law, the operator of the Service will not be liable for any
        indirect, incidental, special, consequential or exemplary damages, or for any trading losses,
        lost profits, or loss of funds, arising from your use of or reliance on the Service. Our total
        aggregate liability for any claim will not exceed the amount you paid to the Service for the
        specific call giving rise to the claim.
      </p>

      <H>9. Changes</H>
      <p className="mt-2">
        We may update these Terms from time to time. Continued use after a change constitutes acceptance
        of the updated Terms. Material changes will be reflected by the &ldquo;Last updated&rdquo; date
        above.
      </p>

      <H>10. Contact &amp; governing law</H>
      <p className="mt-2">
        The Service is operated from Türkiye and these Terms are governed by Turkish law, without regard
        to conflict-of-law rules. Questions:{" "}
        <a className="text-sky-400 hover:underline" href="mailto:sukrutkrdg@gmail.com">sukrutkrdg@gmail.com</a>.
      </p>

      <p className="mt-8 text-xs text-gray-500">
        See also our{" "}
        <a className="text-sky-400 hover:underline" href="/privacy">Privacy Policy</a>.
      </p>
    </article>
  );
}
