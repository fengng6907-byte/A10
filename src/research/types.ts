export const financialMetricNames = [
  'revenue', 'net_income', 'eps_diluted', 'gross_profit', 'operating_income',
  'operating_cash_flow', 'capital_expenditure', 'free_cash_flow',
  'cash_and_equivalents', 'debt', 'outstanding_shares',
] as const;

export type FinancialMetricName = typeof financialMetricNames[number];
export type ResearchAssessment = 'ATTRACTIVE FOR FURTHER RESEARCH' | 'FAIRLY VALUED' | 'POTENTIALLY OVERVALUED' | 'HIGH-RISK SPECULATIVE' | 'INSUFFICIENT DATA';
export type NotificationCategory = 'NEW_STOCK_DISCOVERED' | 'FINANCIAL_PERFORMANCE_CHANGE' | 'SIGNIFICANT_COMPANY_ANNOUNCEMENT' | 'VALUATION_THRESHOLD_REACHED' | 'RESEARCH_RATING_CHANGED' | 'MATERIAL_INVESTMENT_RISK' | 'DAILY_INVESTMENT_BRIEF_READY';
export type NotificationPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type DiscoveryCategory = 'QUALITY_COMPOUNDER' | 'EMERGING_GROWTH' | 'RECENT_IPO';

export type NormalizedFact = {
  metric: FinancialMetricName;
  value: number;
  unit: string;
  start: string | null;
  end: string;
  fiscalYear: number | null;
  fiscalPeriod: string | null;
  form: string;
  filedAt: string;
  accession: string | null;
  frame: string | null;
};

export type EvidenceStatement = { text: string; evidenceIds: number[] };
export type ResearchOutput = {
  companyId: number;
  executiveSummary: EvidenceStatement[];
  businessSummary: EvidenceStatement[];
  businessModel: EvidenceStatement[];
  financialPerformance: EvidenceStatement[];
  financialStrengths: EvidenceStatement[];
  financialWeaknesses: EvidenceStatement[];
  growthCatalysts: EvidenceStatement[];
  competitiveAdvantages: EvidenceStatement[];
  valuationObservations: EvidenceStatement[];
  bullCase: EvidenceStatement[];
  baseCase: EvidenceStatement[];
  bearCase: EvidenceStatement[];
  risks: EvidenceStatement[];
  keyEvents: EvidenceStatement[];
  conclusion: EvidenceStatement[];
  assessment: ResearchAssessment;
  missingInformation: string[];
  dataCompletenessConfidence: 'HIGH' | 'MEDIUM' | 'LOW';
};

export type ScoreComponent = {
  key: string;
  weight: number;
  points: number | null;
  explanation: string;
  evidenceIds: number[];
};
export type ScoreResult = {
  score: number | null;
  rawPoints: number;
  completeness: number;
  components: ScoreComponent[];
};

export type ScreeningInput = {
  companyId: number;
  ticker: string;
  company: string;
  sector?: string | null;
  industry?: string | null;
  listingDate?: string | null;
  marketCap?: number | null;
  revenue?: number | null;
  previousRevenue?: number | null;
  yearAgoRevenue?: number | null;
  netIncome?: number | null;
  operatingIncome?: number | null;
  operatingCashFlow?: number | null;
  freeCashFlow?: number | null;
  grossProfit?: number | null;
  cash?: number | null;
  debt?: number | null;
  outstandingShares?: number | null;
  eps?: number | null;
  qualitative?: {
    marketOpportunity?: { score: number; evidenceIds: number[]; assumption: string };
    competitiveStrength?: { score: number; evidenceIds: number[]; assumption: string };
    differentiation?: { score: number; evidenceIds: number[]; assumption: string };
    execution?: { score: number; evidenceIds: number[]; assumption: string };
  };
  financialEvidenceIds?: number[];
};
