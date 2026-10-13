export interface AgentBounty {
  id: string;
  title: string;
  category: "FORENSIC_AUDIT" | "MEV_ARBITRAGE" | "DATA_ORACLE" | "LIQUIDITY_MANAGEMENT";
  creator: string;
  rewardUsdc: number;
  rewardCents: number;
  status: "OPEN" | "IN_PROGRESS" | "COMPLETED";
  requiredServiceId: string;
  deadlineSeconds: number;
  createdAt: string;
  completedAt?: string;
  workerAgent?: string;
  settledTxHash?: string;
  easAttestationUid?: string;
  description: string;
}
