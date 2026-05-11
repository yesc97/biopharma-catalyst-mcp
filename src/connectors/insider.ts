import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { throttleSec } from './sec-throttle.js';

const USER_AGENT = process.env.SEC_USER_AGENT || 'biopharma-catalyst-mcp/1.0 (YOUR_EMAIL@example.com)';

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

export type InsiderRole = 'clinical' | 'financial' | 'administrative' | 'unknown';

const CLINICAL_RE = /\b(medical|chief medical|cmo|scientific|chief scientific|cso|r&d|research|clinical|discovery)\b/i;
const FINANCIAL_RE = /\b(chief executive|ceo|chief financial|cfo|president|chief operating|coo|treasurer)\b/i;
const ADMIN_RE = /\b(general counsel|legal|compliance|secretary|governance|chair|board)\b/i;

export function classifyInsiderRole(title?: string): InsiderRole {
  if (!title) return 'unknown';
  if (CLINICAL_RE.test(title)) return 'clinical';
  if (FINANCIAL_RE.test(title)) return 'financial';
  if (ADMIN_RE.test(title)) return 'administrative';
  return 'unknown';
}

export interface ClusterExit {
  windowStart: string;
  windowEnd: string;
  sellerCount: number;
  totalValue: number;
  hasClinicalInsider: boolean;
  sellers: Array<{ name: string; title?: string; role: InsiderRole; value?: number }>;
}

export interface InsiderTransaction {
  date: string;
  ownerName: string;
  ownerTitle?: string;
  role: InsiderRole;
  isOfficer: boolean;
  isDirector: boolean;
  isTenPctOwner: boolean;
  code: string;
  codeMeaning: string;
  shares: number;
  pricePerShare?: number;
  totalValue?: number;
  sharesOwnedAfter?: number;
  scheduled10b5_1: boolean;
  accession: string;
}

export interface InsiderActivity {
  cik: string;
  windowDays: number;
  transactionCount: number;
  totalSalesValue: number;
  totalPurchasesValue: number;
  netSentimentDollars: number;
  netSentimentLabel: 'bullish' | 'neutral' | 'bearish' | 'no_data';
  clinicalSalesValue: number;
  clinicalSalesCount: number;
  clusterExits: ClusterExit[];
  transactions: InsiderTransaction[];
  notes: string[];
}

const TRANSACTION_CODE_MEANINGS: Record<string, string> = {
  S: 'open_market_sale',
  P: 'open_market_purchase',
  A: 'grant_or_award',
  M: 'option_exercise',
  F: 'tax_withholding',
  D: 'disposition_other',
  G: 'gift',
  V: 'transaction_voluntary',
  X: 'option_exercise_in_the_money',
};

export async function getInsiderTransactions(cik: string, windowDays = 90): Promise<InsiderActivity> {
  const paddedCik = cik.padStart(10, '0');
  const numericCik = paddedCik.replace(/^0+/, '');
  const notes: string[] = [];

  const submissionsUrl = `https://data.sec.gov/submissions/CIK${paddedCik}.json`;
  let subs: any;
  try {
    const resp = await throttleSec(() => axios.get(submissionsUrl, { headers: { 'User-Agent': USER_AGENT } }));
    subs = resp.data;
  } catch (e) {
    if (axios.isAxiosError(e) && e.response?.status === 404) {
      return empty(paddedCik, windowDays, ['CIK not found in EDGAR submissions']);
    }
    throw new Error(`EDGAR submissions error: ${e instanceof Error ? e.message : String(e)}`);
  }

  const recent = subs?.filings?.recent;
  if (!recent || !recent.form) return empty(paddedCik, windowDays, ['no recent filings']);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);

  const form4s: Array<{ accession: string; date: string; primaryDoc: string }> = [];
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] !== '4') continue;
    if (new Date(recent.filingDate[i]) < cutoff) continue;
    form4s.push({
      accession: recent.accessionNumber[i],
      date: recent.filingDate[i],
      primaryDoc: recent.primaryDocument[i],
    });
  }

  if (form4s.length === 0) {
    return empty(paddedCik, windowDays, [`no Form 4 filings in last ${windowDays} days`]);
  }

  // Cap to most recent 25 Form 4s to keep audit calls bounded
  const form4sCapped = form4s.slice(0, 25);
  if (form4s.length > 25) {
    notes.push(`Limited to 25 most recent Form 4s of ${form4s.length} in window`);
  }

  const transactions: InsiderTransaction[] = [];
  for (const filing of form4sCapped) {
    const accNoDashes = filing.accession.replace(/-/g, '');
    const folderUrl = `https://www.sec.gov/Archives/edgar/data/${numericCik}/${accNoDashes}`;

    // EDGAR's `primaryDocument` field points to the HTML wrapper for Form 4s.
    // The structured XML lives separately in the same folder; list the folder
    // via index.json and find the .xml entry.
    let xmlFilename: string | undefined;
    try {
      const idxResp = await throttleSec(() => axios.get(`${folderUrl}/index.json`, {
        headers: { 'User-Agent': USER_AGENT },
      }));
      const items: Array<{ name: string; type: string }> = idxResp.data?.directory?.item ?? [];
      // Prefer the canonical primary_doc.xml; otherwise any .xml that isn't a feed/index
      const primary = items.find((i) => i.name === 'primary_doc.xml');
      const fallbackXml = items.find(
        (i) => i.name.toLowerCase().endsWith('.xml') && !i.name.toLowerCase().includes('rendering'),
      );
      xmlFilename = primary?.name ?? fallbackXml?.name;
    } catch (e) {
      notes.push(`failed to list ${filing.accession}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (!xmlFilename) {
      notes.push(`no XML found in ${filing.accession}`);
      continue;
    }

    const xmlUrl = `${folderUrl}/${xmlFilename}`;
    try {
      const xmlResp = await throttleSec(() => axios.get(xmlUrl, {
        headers: { 'User-Agent': USER_AGENT },
        responseType: 'text',
      }));
      const parsed = parser.parse(xmlResp.data);
      const doc = parsed?.ownershipDocument;
      if (!doc) {
        notes.push(`malformed Form 4: ${filing.accession}`);
        continue;
      }

      const owners = ensureArray(doc.reportingOwner);
      const ownerInfo = owners[0] ?? {};
      const ownerName = String(unwrap(ownerInfo.reportingOwnerId?.rptOwnerName) ?? 'Unknown');
      const rel = ownerInfo.reportingOwnerRelationship ?? {};
      const isOfficer = boolish(unwrap(rel.isOfficer));
      const isDirector = boolish(unwrap(rel.isDirector));
      const isTenPctOwner = boolish(unwrap(rel.isTenPercentOwner));
      const ownerTitle = unwrap(rel.officerTitle) ? String(unwrap(rel.officerTitle)) : undefined;

      const footnotesText = collectFootnotes(doc.footnotes);
      const has10b5_1 = /10b5-?1/i.test(footnotesText);

      const ndTrans = ensureArray(doc.nonDerivativeTable?.nonDerivativeTransaction);
      for (const tx of ndTrans) {
        if (!tx) continue;
        const date = unwrap(tx.transactionDate?.value);
        const code = String(unwrap(tx.transactionCoding?.transactionCode) ?? '');
        const shares = num(unwrap(tx.transactionAmounts?.transactionShares?.value));
        const price = num(unwrap(tx.transactionAmounts?.transactionPricePerShare?.value));
        const sharesAfter = num(unwrap(tx.postTransactionAmounts?.sharesOwnedFollowingTransaction?.value));

        if (!date || !code || !shares) continue;

        transactions.push({
          date: String(date),
          ownerName,
          ownerTitle,
          role: classifyInsiderRole(ownerTitle),
          isOfficer,
          isDirector,
          isTenPctOwner,
          code,
          codeMeaning: TRANSACTION_CODE_MEANINGS[code] ?? 'unknown',
          shares,
          pricePerShare: price > 0 ? price : undefined,
          totalValue: price > 0 ? shares * price : undefined,
          sharesOwnedAfter: sharesAfter > 0 ? sharesAfter : undefined,
          scheduled10b5_1: has10b5_1,
          accession: filing.accession,
        });
      }
    } catch (e) {
      notes.push(`failed to fetch ${filing.accession}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let totalSalesValue = 0;
  let totalPurchasesValue = 0;
  let clinicalSalesValue = 0;
  let clinicalSalesCount = 0;
  for (const tx of transactions) {
    if (!tx.totalValue) continue;
    if (tx.code === 'S' || tx.code === 'D') {
      totalSalesValue += tx.totalValue;
      if (tx.role === 'clinical') {
        clinicalSalesValue += tx.totalValue;
        clinicalSalesCount++;
      }
    }
    if (tx.code === 'P') totalPurchasesValue += tx.totalValue;
  }

  const net = totalPurchasesValue - totalSalesValue;
  let label: InsiderActivity['netSentimentLabel'];
  if (totalSalesValue === 0 && totalPurchasesValue === 0) label = 'no_data';
  else if (net > 0) label = 'bullish';
  else if (net < -100_000) label = 'bearish';
  else label = 'neutral';

  const sorted = transactions.sort((a, b) => b.date.localeCompare(a.date));
  const clusterExits = detectClusterExits(sorted);

  return {
    cik: paddedCik,
    windowDays,
    transactionCount: transactions.length,
    totalSalesValue,
    totalPurchasesValue,
    netSentimentDollars: net,
    netSentimentLabel: label,
    clinicalSalesValue,
    clinicalSalesCount,
    clusterExits,
    transactions: sorted,
    notes,
  };
}

function detectClusterExits(transactions: InsiderTransaction[]): ClusterExit[] {
  const openSales = transactions.filter(
    (tx) => tx.code === 'S' && (tx.isOfficer || tx.isDirector),
  );
  if (openSales.length < 3) return [];

  const byDate = [...openSales].sort((a, b) => a.date.localeCompare(b.date));
  const WINDOW_MS = 72 * 60 * 60 * 1000;
  const clusters: ClusterExit[] = [];

  for (let i = 0; i < byDate.length; i++) {
    const windowStart = new Date(byDate[i].date).getTime();
    const windowEnd = windowStart + WINDOW_MS;

    const inWindow = byDate.filter((tx) => {
      const t = new Date(tx.date).getTime();
      return t >= windowStart && t <= windowEnd;
    });

    const distinctSellers = new Map<string, InsiderTransaction>();
    for (const tx of inWindow) {
      if (!distinctSellers.has(tx.ownerName)) distinctSellers.set(tx.ownerName, tx);
    }

    if (distinctSellers.size < 3) continue;

    // Skip if this window overlaps one we already recorded
    const overlaps = clusters.some((c) => {
      const cs = new Date(c.windowStart).getTime();
      const ce = cs + WINDOW_MS;
      return windowStart < ce && windowEnd > cs;
    });
    if (overlaps) continue;

    const sellers = Array.from(distinctSellers.values());
    clusters.push({
      windowStart: byDate[i].date,
      windowEnd: new Date(windowEnd).toISOString().split('T')[0],
      sellerCount: sellers.length,
      totalValue: sellers.reduce((s, tx) => s + (tx.totalValue ?? 0), 0),
      hasClinicalInsider: sellers.some((tx) => tx.role === 'clinical'),
      sellers: sellers.map((tx) => ({
        name: tx.ownerName,
        title: tx.ownerTitle,
        role: tx.role,
        value: tx.totalValue,
      })),
    });
  }

  return clusters;
}

function empty(cik: string, windowDays: number, notes: string[]): InsiderActivity {
  return {
    cik,
    windowDays,
    transactionCount: 0,
    totalSalesValue: 0,
    totalPurchasesValue: 0,
    netSentimentDollars: 0,
    netSentimentLabel: 'no_data',
    clinicalSalesValue: 0,
    clinicalSalesCount: 0,
    clusterExits: [],
    transactions: [],
    notes,
  };
}

function ensureArray<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function unwrap(x: any): any {
  if (x === null || x === undefined) return undefined;
  if (typeof x === 'object' && !Array.isArray(x) && 'value' in x) return x.value;
  return x;
}

function num(x: any): number {
  if (x === undefined || x === null) return 0;
  const n = Number(x);
  return isNaN(n) ? 0 : n;
}

function boolish(x: any): boolean {
  if (x === undefined || x === null) return false;
  const s = String(x).toLowerCase();
  return s === '1' || s === 'true';
}

function collectFootnotes(footnotes: any): string {
  if (!footnotes) return '';
  const arr = ensureArray(footnotes.footnote);
  return arr
    .map((f: any) => (typeof f === 'string' ? f : f?.['#text'] ?? ''))
    .join(' ');
}

