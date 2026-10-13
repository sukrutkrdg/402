export interface AgentCreditProfile {
  wallet: string;
  agentName: string;
  creditScore: number; // 300 to 850
  rating: "PRIME" | "VERIFIED" | "STANDARD" | "UNPROVEN";
  maxCreditLimitUsdc: number;
  availableCreditUsdc: number;
  outstandingDebtUsdc: number;
  onchainTxCount: number;
  successfulRepayments: number;
  interestRateBps: number; // e.g. 50 = 0.5%
  easAttestationUid?: string;
}

export interface CreditLoanReceipt {
  loanId: string;
  wallet: string;
  principalUsdc: number;
  feeUsdc: number;
  totalDueUsdc: number;
  issuedAt: string;
  dueAt: string;
  status: "ACTIVE" | "REPAID";
  txHash: string;
  basescanUrl: string;
}
