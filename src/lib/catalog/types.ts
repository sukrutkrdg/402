export interface ServiceParam {
  name: string;
  label: string;
  placeholder: string;
  required?: boolean;
  multiline?: boolean;
}

export interface ServiceDef {
  id: string;
  name: string;
  tagline: string;
  description: string;
  /** Human price string passed straight to x402 (USD → USDC on Base). */
  price: string;
  icon: string;
  category: string;
  params: ServiceParam[];
  handler: (params: Record<string, string>) => Promise<unknown>;
  /**
   * Exclude from the free tier — payment always required. Set on services backed
   * by a metered/paid upstream (e.g. Covalent) so free calls can't drain credits
   * for zero revenue. AI services are already paid-only via their category.
   */
  noFreeTier?: boolean;
  /** Hidden from the marketplace UI + public catalog listing (still callable/indexed). */
  hidden?: boolean;
}
