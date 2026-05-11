import axios from 'axios';
import { throttleSec } from './sec-throttle.js';

const USER_AGENT = process.env.SEC_USER_AGENT || 'biopharma-catalyst-mcp/1.0 (YOUR_EMAIL@example.com)';

// Fallback chains — biotech filers don't always tag the canonical concept.
// Order matters: the first hit wins.
const CASH_CONCEPTS = [
  'CashAndCashEquivalentsAtCarryingValue',
  'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
  'CashAndCashEquivalentsAtFairValue',
  'Cash',
];

const BURN_CONCEPTS = [
  'NetCashProvidedByUsedInOperatingActivities',
  'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
];

const GOING_CONCERN_TAG = 'SubstantialDoubtAboutGoingConcernTextBlock';

interface XbrlUsdFact {
  end: string;
  start?: string;
  val: number;
  fp: string;
  fy: number;
  form: string;
  filed: string;
}

export interface FinancialFact {
  value: number;
  concept: string;
  period: string;
  reportedIn: string;
}

export interface FinancialSnapshot {
  cik: string;
  cash: FinancialFact | null;
  quarterlyBurn: FinancialFact | null;
  runwayMonths: number | null;
  goingConcernDisclosed: boolean;
  notes: string[];
}

export async function getXbrlFacts(cik: string): Promise<FinancialSnapshot> {
  const paddedCik = cik.padStart(10, '0');
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${paddedCik}.json`;
  const notes: string[] = [];

  let companyFacts: any;
  try {
    const resp = await throttleSec(() => axios.get(url, { headers: { 'User-Agent': USER_AGENT } }));
    companyFacts = resp.data;
  } catch (e) {
    if (axios.isAxiosError(e) && e.response?.status === 404) {
      return {
        cik: paddedCik,
        cash: null,
        quarterlyBurn: null,
        runwayMonths: null,
        goingConcernDisclosed: false,
        notes: ['no XBRL facts available — likely small filer, foreign issuer, or invalid CIK'],
      };
    }
    throw new Error(`XBRL companyfacts error: ${e instanceof Error ? e.message : String(e)}`);
  }

  const usgaap = companyFacts?.facts?.['us-gaap'] ?? {};

  const cashHit = pickFromFallback(usgaap, CASH_CONCEPTS);
  if (cashHit && cashHit.concept !== CASH_CONCEPTS[0]) {
    notes.push(`cash sourced from non-canonical tag: ${cashHit.concept}`);
  }

  const burnHit = pickFromFallback(usgaap, BURN_CONCEPTS);
  if (!burnHit) {
    notes.push('operating cash flow not tagged — runway not calculable');
  }

  let runwayMonths: number | null = null;
  if (cashHit && burnHit) {
    const burnVal = burnHit.fact.val;
    const monthsCovered = inferMonthsCovered(burnHit.fact);
    const monthlyBurn = Math.abs(burnVal) / monthsCovered;
    if (burnVal >= 0) {
      runwayMonths = Number.POSITIVE_INFINITY;
      notes.push('operating cash flow positive — company is not burning');
    } else if (monthlyBurn > 0) {
      runwayMonths = cashHit.fact.val / monthlyBurn;
    }
  }

  const goingConcernDisclosed = Boolean(usgaap[GOING_CONCERN_TAG]);

  return {
    cik: paddedCik,
    cash: cashHit ? toFinancialFact(cashHit) : null,
    quarterlyBurn: burnHit ? toFinancialFact(burnHit) : null,
    runwayMonths,
    goingConcernDisclosed,
    notes,
  };
}

function pickFromFallback(
  usgaap: any,
  concepts: string[],
): { concept: string; fact: XbrlUsdFact } | null {
  for (const concept of concepts) {
    const facts: XbrlUsdFact[] | undefined = usgaap[concept]?.units?.USD;
    if (facts && facts.length > 0) {
      const latest = pickLatestQuarterly(facts);
      if (latest) return { concept, fact: latest };
    }
  }
  return null;
}

function pickLatestQuarterly(facts: XbrlUsdFact[]): XbrlUsdFact | null {
  const sorted = [...facts].sort((a, b) => b.end.localeCompare(a.end));
  return sorted.find((f) => f.fp.startsWith('Q')) ?? sorted[0] ?? null;
}

function inferMonthsCovered(fact: XbrlUsdFact): number {
  if (fact.fp === 'FY') return 12;
  if (!fact.start) return 3;
  const startMs = new Date(fact.start).getTime();
  const endMs = new Date(fact.end).getTime();
  const days = (endMs - startMs) / (1000 * 60 * 60 * 24);
  if (days <= 0) return 3;
  return Math.max(1, Math.round(days / 30));
}

function toFinancialFact(hit: { concept: string; fact: XbrlUsdFact }): FinancialFact {
  return {
    value: hit.fact.val,
    concept: hit.concept,
    period: hit.fact.end,
    reportedIn: `${hit.fact.form} ${hit.fact.fy} ${hit.fact.fp}`,
  };
}
