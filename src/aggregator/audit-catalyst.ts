/**
 * audit_catalyst — forensic verdict on a binary biopharma catalyst.
 *
 * Runs all 8 connectors in parallel against (ticker, drug), applies the
 * Tactical Auditor verdict logic from the spec, returns a single deterministic
 * verdict. The LLM narrates; the math is here.
 */
import { searchTrialsByIntervention } from '../connectors/clinical-trials.js';
import { searchPubMed } from '../connectors/pubmed.js';
import { getCIK, getRecentFilings } from '../connectors/sec.js';
import { getOptionsData, getPriceData } from '../connectors/market-data.js';
import { getRecentFdaActivity } from '../connectors/fda.js';
import { getXbrlFacts } from '../connectors/xbrl.js';
import { getInsiderTransactions } from '../connectors/insider.js';
import { getProtocolSnapshot } from '../connectors/trial-history.js';
import { getShortInterest } from '../connectors/short-interest.js';

export type Verdict = 'CLEAN' | 'FLAG' | 'BEAR_SIGNAL' | 'BLACK_FLAG' | 'DISQUALIFIED';
export type Confidence = 'HIGH' | 'MED' | 'LOW';
export type Tier = 'S' | 'A' | 'B';
export type Side = 'BEAR' | 'BULL';

export interface Signal {
  tier: Tier;
  side: Side;
  label: string;
  detail?: string;
}

export interface AuditVerdict {
  ticker: string;
  drug: string;
  sponsor?: string;
  verdict: Verdict;
  confidence: Confidence;
  primaryFinding: string;
  signalsFired: Signal[];
  math: {
    runwayMonths?: number | null;
    monthsToCatalyst?: number;
    catalystDate?: string;
    catalystTrialId?: string;
    netInsiderSentimentDollars?: number;
    atmCallIvPct?: number;
    atmPutIvPct?: number;
    shortPct?: number | null;
    daysToCover?: number | null;
    shortDeltaPct?: number | null;
  };
  dataDensity: {
    sourcesQueried: number;
    sourcesWithSignal: number;
    label: 'OK' | 'LOW';
  };
  notes: string[];
}

interface TrialLite {
  nctId?: string;
  title?: string;
  status?: string;
  completionDate?: string;
  hasResults?: boolean;
  auditFlag?: string;
  leadSponsor?: string;
  sponsorClass?: string;
  phase?: string[];
}

const SKEPTIC_KEYWORDS = [
  'controversial',
  'mixed results',
  'safety concerns',
  'marginal improvement',
  'failed to demonstrate',
  'no significant difference',
  'inconsistent',
];

export async function auditCatalyst(
  ticker: string,
  drug: string,
  sponsor?: string,
): Promise<AuditVerdict> {
  const TICKER = ticker.toUpperCase();
  const signals: Signal[] = [];
  const notes: string[] = [];
  let sourcesQueried = 0;
  let sourcesWithSignal = 0;

  // Resolve CIK first; many forensic checks need it
  const cik = await getCIK(TICKER);
  if (!cik) {
    notes.push(`No SEC CIK for ${TICKER} — likely delisted, foreign, or invalid.`);
  }

  // Fire all connectors in parallel (with cik gating where needed)
  const [
    trialsResult,
    pubmedResult,
    secFilingsResult,
    marketResult,
    fdaResult,
    xbrlResult,
    insiderResult,
    shortInterestResult,
  ] = await Promise.allSettled([
    searchTrialsByIntervention(drug),
    searchPubMed(drug),
    cik ? getRecentFilings(cik) : Promise.resolve([]),
    Promise.all([getPriceData(TICKER), getOptionsData(TICKER)]),
    sponsor
      ? getRecentFdaActivity(drug, 'drug').then(async (r) =>
          r.recent.length === 0 ? getRecentFdaActivity(sponsor!, 'sponsor') : r,
        )
      : getRecentFdaActivity(drug, 'drug'),
    cik ? getXbrlFacts(cik) : Promise.resolve(null),
    cik ? getInsiderTransactions(cik, 90) : Promise.resolve(null),
    getShortInterest(TICKER),
  ]);

  const allTrials: TrialLite[] = unwrap(trialsResult, []);

  // Critical filter: drug names appear in many unrelated trials (investigator-
  // initiated, generic-class, academic). Only count trials sponsored by the
  // company we're auditing for forensic signals like terminations / amendments.
  // Without sponsor match, a healthy company can fire BEAR_SIGNAL because some
  // grad-student trial using their drug got withdrawn in 2014.
  const trials: TrialLite[] = sponsor
    ? allTrials.filter((t) => {
        if (!t.leadSponsor) return false;
        const sponsorLower = sponsor.toLowerCase();
        const trialSponsorLower = t.leadSponsor.toLowerCase();
        // Bidirectional substring match handles trailing entity suffixes (e.g.
        // "Pfizer Inc" vs "Pfizer", "Sarepta Therapeutics, Inc." vs "Sarepta Therapeutics").
        return (
          trialSponsorLower.includes(sponsorLower) ||
          sponsorLower.includes(trialSponsorLower)
        );
      })
    : allTrials;

  if (sponsor && trials.length === 0 && allTrials.length > 0) {
    notes.push(
      `Drug "${drug}" appears in ${allTrials.length} CT.gov trials but none are sponsored by "${sponsor}". Check sponsor spelling, or drug may be off-patent / class name.`,
    );
  }
  const pubmedPapers: any[] = unwrap(pubmedResult, []);
  const secFilings: any[] = unwrap(secFilingsResult, []);
  const market = unwrap(marketResult, [null, null]) as [any, any];
  const [priceData, optionsData] = market;
  const fda = unwrap(fdaResult, { upcoming: [], recent: [], approved: [] });
  const xbrl = unwrap(xbrlResult, null);
  const insider = unwrap(insiderResult, null);
  const shortInterest = unwrap(shortInterestResult, null);

  sourcesQueried = 9;

  // === Disqualifiers ===

  if ((!trials || trials.length === 0) && (!fda || fda.recent.length === 0)) {
    return earlyReturn(TICKER, drug, sponsor, 'DISQUALIFIED', 'LOW', signals, {}, {
      sourcesQueried,
      sourcesWithSignal: 0,
      label: 'LOW',
    }, ['Drug has no CT.gov entries and no FDA records — preclinical or invalid name.']);
  }

  if (priceData && priceData.regularMarketPrice === undefined && !cik) {
    return earlyReturn(TICKER, drug, sponsor, 'DISQUALIFIED', 'LOW', signals, {}, {
      sourcesQueried,
      sourcesWithSignal: 0,
      label: 'LOW',
    }, ['Ticker has no live market data and no SEC CIK — likely defunct.']);
  }

  // === Pick pivotal trial for goalpost analysis ===

  const pivotalTrial = pickPivotalTrial(trials);
  let trialHistory: any = null;
  if (pivotalTrial?.nctId) {
    try {
      trialHistory = await getProtocolSnapshot(pivotalTrial.nctId);
      sourcesQueried += 1;
    } catch (e) {
      notes.push(`trial history fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // === Catalyst clock ===

  let catalystDate: string | undefined;
  let catalystTrialId: string | undefined;
  let monthsToCatalyst: number | undefined;
  const now = Date.now();
  for (const t of trials) {
    if (!t.completionDate) continue;
    if (t.status === 'WITHDRAWN' || t.status === 'TERMINATED') continue;
    const ms = new Date(t.completionDate).getTime();
    if (ms < now) continue; // past catalysts don't count
    const candidate = ms;
    if (catalystDate === undefined || candidate < new Date(catalystDate).getTime()) {
      catalystDate = t.completionDate;
      catalystTrialId = t.nctId;
    }
  }
  if (catalystDate) {
    monthsToCatalyst = (new Date(catalystDate).getTime() - now) / (1000 * 60 * 60 * 24 * 30);
  }

  // === S-tier signals ===

  // BEAR: pivotal trial TERMINATED or WITHDRAWN
  const terminated = trials.find((t) => t.status === 'TERMINATED' || t.status === 'WITHDRAWN');
  if (terminated) {
    signals.push({
      tier: 'S',
      side: 'BEAR',
      label: 'PIVOTAL_TRIAL_TERMINATED',
      detail: `${terminated.nctId}: ${terminated.status}`,
    });
    sourcesWithSignal++;
  }

  // BEAR: FDA CRL within 12 months
  const recentCrl = (fda.recent ?? []).find((s: any) => {
    if (s.submissionStatus !== 'CRL') return false;
    if (!s.submissionStatusDate) return false;
    const d = parseFdaDate(s.submissionStatusDate);
    return d && (now - d) < 365 * 24 * 60 * 60 * 1000;
  });
  if (recentCrl) {
    signals.push({
      tier: 'S',
      side: 'BEAR',
      label: 'RECENT_FDA_REJECTION',
      detail: `CRL on ${recentCrl.submissionStatusDate}`,
    });
    sourcesWithSignal++;
  }

  // BEAR: late-stage protocol amendment (goalpost) — only on ONGOING trials.
  // Post-completion amendments on trials that already have results posted are
  // normal lifecycle hygiene (AE reports, results updates), not goalpost moves.
  if (trialHistory?.amendmentFlag === 'GOALPOST_RISK') {
    signals.push({
      tier: 'S',
      side: 'BEAR',
      label: 'MGT_MOVING_THE_GOALPOSTS',
      detail: `Late-stage amendment on ongoing trial ${trialHistory.nctId} (${(trialHistory.amendmentProgressPct * 100).toFixed(0)}% through timeline)`,
    });
    sourcesWithSignal++;
  } else if (
    trialHistory?.amendmentFlag === 'POST_COMPLETION_AMENDMENT' &&
    trialHistory.hasResults === false
  ) {
    // Trial completed AND was further amended AND no results were ever posted —
    // that's a real bear signal, suggests undisclosed problems.
    signals.push({
      tier: 'A',
      side: 'BEAR',
      label: 'AMENDED_AFTER_COMPLETION_NO_RESULTS',
      detail: `${trialHistory.nctId} completed but was amended again with no results posted`,
    });
    sourcesWithSignal++;
  }

  // BEAR: dilution risk (runway < months to catalyst)
  if (xbrl && xbrl.runwayMonths !== null && Number.isFinite(xbrl.runwayMonths) && monthsToCatalyst !== undefined) {
    if (xbrl.runwayMonths < monthsToCatalyst) {
      signals.push({
        tier: 'S',
        side: 'BEAR',
        label: 'DILUTION_RISK',
        detail: `${xbrl.runwayMonths.toFixed(1)} months runway vs ${monthsToCatalyst.toFixed(1)} months to catalyst — equity raise priced in before readout`,
      });
      sourcesWithSignal++;
    }
  }

  // BLACK FLAG: Going Concern + low runway
  if (xbrl?.goingConcernDisclosed && xbrl.runwayMonths !== null && Number.isFinite(xbrl.runwayMonths) && xbrl.runwayMonths < 6) {
    signals.push({
      tier: 'S',
      side: 'BEAR',
      label: 'GOING_CONCERN_DISCLOSED',
      detail: `Auditor flagged substantial doubt about ability to continue + ${xbrl.runwayMonths.toFixed(1)} months runway`,
    });
    sourcesWithSignal++;
  }

  // INSIDER signals — role-weighted + cluster detection
  if (insider && insider.transactionCount > 0) {
    sourcesWithSignal++;

    // S-BEAR: clinical insider (CMO/CSO/Head of R&D) sold — they know the science
    if (insider.clinicalSalesCount > 0) {
      signals.push({
        tier: 'S',
        side: 'BEAR',
        label: 'CLINICAL_INSIDER_SALE',
        detail: `${insider.clinicalSalesCount} clinical officer(s) sold $${(insider.clinicalSalesValue / 1e6).toFixed(2)}M — CMO/CSO/R&D level knowledge`,
      });
    }

    // S-BEAR: coordinated exit — 3+ distinct officers Code S within 72h
    if (insider.clusterExits.length > 0) {
      const worst = insider.clusterExits.reduce((a, b) => a.sellerCount >= b.sellerCount ? a : b);
      const clinicalTag = worst.hasClinicalInsider ? ' including clinical officer' : '';
      signals.push({
        tier: 'S',
        side: 'BEAR',
        label: 'COORDINATED_INSIDER_EXIT',
        detail: `${worst.sellerCount} distinct insiders sold within 72h${clinicalTag} — $${(worst.totalValue / 1e6).toFixed(2)}M`,
      });
    }

    // S-BEAR: general net selling (financial/admin roles driving it)
    if (insider.netSentimentDollars < -1_000_000 && insider.clinicalSalesCount === 0 && insider.clusterExits.length === 0) {
      const label10b = insider.transactions.some((t: any) => t.scheduled10b5_1) ? ' (scheduled 10b5-1 included)' : '';
      signals.push({
        tier: 'S',
        side: 'BEAR',
        label: 'INSIDERS_UNLOADING',
        detail: `Net insider selling: $${(insider.netSentimentDollars / 1e6).toFixed(2)}M over ${insider.windowDays}d${label10b}`,
      });
    }

    // A-BULL: net buying
    if (insider.netSentimentLabel === 'bullish' && insider.totalPurchasesValue > 50_000) {
      signals.push({
        tier: 'A',
        side: 'BULL',
        label: 'INSIDER_BUYING',
        detail: `Net insider buying: $${(insider.netSentimentDollars / 1e6).toFixed(2)}M over ${insider.windowDays}d`,
      });
    }
  }

  // SHORT INTEREST signals
  if (shortInterest && shortInterest.shortPct !== null) {
    sourcesWithSignal++;

    // A-BEAR: significant short interest buildup month-over-month
    if (shortInterest.deltaPercent !== null && shortInterest.deltaPercent > 20) {
      signals.push({
        tier: 'A',
        side: 'BEAR',
        label: 'SHORT_INTEREST_SPIKE',
        detail: `Short interest up ${shortInterest.deltaPercent.toFixed(1)}% MoM — ${shortInterest.shortPct.toFixed(1)}% of float short`,
      });
    }

    // A-BULL: high days-to-cover creates squeeze potential when data is positive
    if (shortInterest.daysToCover !== null && shortInterest.daysToCover > 5) {
      signals.push({
        tier: 'A',
        side: 'BULL',
        label: 'SHORT_SQUEEZE_POTENTIAL',
        detail: `${shortInterest.daysToCover.toFixed(1)} days to cover — shorts heavily trapped, squeeze risk on positive catalyst`,
      });
    }
  }

  // BULL: recent FDA approval
  const recentApproval = (fda.recent ?? []).find((s: any) => {
    if (s.submissionStatus !== 'AP') return false;
    if (!s.submissionStatusDate) return false;
    const d = parseFdaDate(s.submissionStatusDate);
    return d && (now - d) < 90 * 24 * 60 * 60 * 1000;
  });
  if (recentApproval) {
    signals.push({
      tier: 'S',
      side: 'BULL',
      label: 'RECENT_FDA_APPROVAL',
      detail: `Approved ${recentApproval.submissionStatusDate}`,
    });
    sourcesWithSignal++;
  }

  // === A-tier signals ===

  // BEAR: trial overdue without readout
  const overdue = trials.find((t) => t.auditFlag === 'overdue_no_readout');
  if (overdue) {
    signals.push({
      tier: 'A',
      side: 'BEAR',
      label: 'OVERDUE_NO_READOUT',
      detail: `${overdue.nctId} completed >6mo ago, no results posted`,
    });
  }

  // BEAR: 8-K cluster (3+ in 30 days)
  if (secFilings.length > 0) {
    sourcesWithSignal++;
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const recent8Ks = secFilings.filter(
      (f: any) => f.form === '8-K' && new Date(f.filingDate).getTime() > thirtyDaysAgo,
    );
    if (recent8Ks.length >= 3) {
      signals.push({
        tier: 'A',
        side: 'BEAR',
        label: '8K_CLUSTER',
        detail: `${recent8Ks.length} 8-K filings in last 30 days`,
      });
    }
  }

  // BEAR: skeptic keywords in PubMed
  if (pubmedPapers.length > 0) {
    sourcesWithSignal++;
    const skepticHits: string[] = [];
    for (const p of pubmedPapers) {
      const text = `${p.title ?? ''} ${p.abstract ?? ''}`.toLowerCase();
      for (const kw of SKEPTIC_KEYWORDS) {
        if (text.includes(kw)) {
          skepticHits.push(`"${kw}" in PMID ${p.pmid}`);
          break;
        }
      }
    }
    if (skepticHits.length > 0) {
      signals.push({
        tier: 'A',
        side: 'BEAR',
        label: 'LITERATURE_SKEPTIC',
        detail: skepticHits.slice(0, 2).join('; '),
      });
    }
  }

  // BEAR: high IV + binary catalyst <30 days
  let atmCallIv: number | undefined;
  let atmPutIv: number | undefined;
  if (optionsData?.options?.[0]) {
    sourcesWithSignal++;
    const chain = optionsData.options[0];
    const atmCall = chain.calls?.find((c: any) => c.inTheMoney === false) ?? chain.calls?.[0];
    const atmPut = chain.puts?.find((p: any) => p.inTheMoney === false) ?? chain.puts?.[0];
    atmCallIv = atmCall?.impliedVolatility ? atmCall.impliedVolatility * 100 : undefined;
    atmPutIv = atmPut?.impliedVolatility ? atmPut.impliedVolatility * 100 : undefined;
    if (atmCallIv && atmCallIv > 150 && monthsToCatalyst !== undefined && monthsToCatalyst < 1) {
      signals.push({
        tier: 'A',
        side: 'BEAR',
        label: 'IV_PRICING_FAILURE',
        detail: `ATM call IV ${atmCallIv.toFixed(0)}% with catalyst <30d — market pricing binary failure`,
      });
    }
  }

  // BEAR: prior CRL on different drug from same sponsor
  const priorCrls = (fda.recent ?? []).filter((s: any) => {
    if (s.submissionStatus !== 'CRL') return false;
    if (s === recentCrl) return false; // already counted above
    return true;
  });
  if (priorCrls.length > 0) {
    signals.push({
      tier: 'A',
      side: 'BEAR',
      label: 'SPONSOR_REGULATORY_FRICTION',
      detail: `${priorCrls.length} prior CRL(s) on sponsor's history`,
    });
  }

  // === Verdict resolution ===

  const sTierBear = signals.filter((s) => s.tier === 'S' && s.side === 'BEAR');
  const sTierBull = signals.filter((s) => s.tier === 'S' && s.side === 'BULL');
  const aTierBear = signals.filter((s) => s.tier === 'A' && s.side === 'BEAR');
  const aTierBull = signals.filter((s) => s.tier === 'A' && s.side === 'BULL');

  const goingConcernFired = signals.some((s) => s.label === 'GOING_CONCERN_DISCLOSED');

  let verdict: Verdict;
  let confidence: Confidence;
  let primaryFinding: string;

  if (goingConcernFired) {
    verdict = 'BLACK_FLAG';
    confidence = 'HIGH';
    primaryFinding = 'Going Concern disclosed by auditors with cash runway under 6 months — equity at high risk of zero before catalyst.';
  } else if (sTierBear.length > 0) {
    verdict = 'BEAR_SIGNAL';
    confidence = sTierBear.length >= 2 ? 'HIGH' : 'MED';
    primaryFinding = sTierBear[0].detail ?? sTierBear[0].label;
  } else if (sTierBull.length > 0) {
    // S-tier bull dominates absent any S-tier bear. A-tier concerns get surfaced
    // in signals[] but don't flip the verdict — that's what the noise channel is for.
    verdict = 'CLEAN';
    if (aTierBear.length === 0) confidence = 'HIGH';
    else if (aTierBear.length === 1) confidence = 'MED';
    else confidence = 'LOW';
    const noiseNote = aTierBear.length > 0 ? ` (${aTierBear.length} secondary concern(s) noted in signals)` : '';
    primaryFinding = `Tried to break thesis. ${sTierBull[0].detail ?? sTierBull[0].label}.${noiseNote}`;
  } else if (aTierBear.length >= 2) {
    verdict = 'BEAR_SIGNAL';
    confidence = 'MED';
    primaryFinding = aTierBear.map((s) => s.label).join(' + ');
  } else if (aTierBear.length >= 1) {
    verdict = 'FLAG';
    confidence = 'LOW';
    primaryFinding = aTierBear[0]?.detail ?? aTierBear[0]?.label ?? 'A-tier bear signal fired';
  } else if (aTierBull.length >= 1) {
    verdict = 'CLEAN';
    confidence = 'LOW';
    primaryFinding = `Tried to break thesis. ${aTierBull[0].detail ?? aTierBull[0].label}`;
  } else {
    verdict = 'CLEAN';
    confidence = 'LOW';
    primaryFinding = 'No bear signals fired; data thin, treat with skepticism.';
  }

  const densityLabel = sourcesWithSignal < 3 ? 'LOW' : 'OK';
  if (densityLabel === 'LOW' && confidence !== 'LOW') {
    confidence = 'LOW';
  }

  return {
    ticker: TICKER,
    drug,
    sponsor,
    verdict,
    confidence,
    primaryFinding,
    signalsFired: signals,
    math: {
      runwayMonths: xbrl?.runwayMonths ?? undefined,
      monthsToCatalyst,
      catalystDate,
      catalystTrialId,
      netInsiderSentimentDollars: insider?.netSentimentDollars,
      atmCallIvPct: atmCallIv,
      atmPutIvPct: atmPutIv,
      shortPct: shortInterest?.shortPct ?? null,
      daysToCover: shortInterest?.daysToCover ?? null,
      shortDeltaPct: shortInterest?.deltaPercent ?? null,
    },
    dataDensity: {
      sourcesQueried,
      sourcesWithSignal,
      label: densityLabel,
    },
    notes,
  };
}

function unwrap<T>(r: PromiseSettledResult<T>, fallback: T): T {
  if (r.status === 'fulfilled') return r.value;
  return fallback;
}

function pickPivotalTrial(trials: TrialLite[]): TrialLite | null {
  if (!trials || trials.length === 0) return null;

  const now = Date.now();
  const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;
  const isRelevantPhase3 = (t: TrialLite) =>
    Array.isArray(t.phase) && t.phase.some((p) => p === 'PHASE3' || p?.includes('3'));
  const isRelevantPhase2or3 = (t: TrialLite) =>
    Array.isArray(t.phase) && t.phase.some((p) => p === 'PHASE2' || p === 'PHASE3' || p?.includes('2') || p?.includes('3'));

  // Tier 1: Phase 3 with upcoming or very recent completion (true catalyst)
  const recentP3 = trials.filter((t) => {
    if (!t.completionDate || !isRelevantPhase3(t)) return false;
    const ms = new Date(t.completionDate).getTime();
    return ms > now - SIX_MONTHS_MS && ms < now + 18 * SIX_MONTHS_MS / 6;
  });
  if (recentP3.length > 0) return recentP3[0];

  // Tier 2: any TERMINATED/WITHDRAWN (always relevant — hard bear signal)
  const terminated = trials.find((t) => t.status === 'TERMINATED' || t.status === 'WITHDRAWN');
  if (terminated) return terminated;

  // Tier 3: Phase 3 with completed but no results (overdue catalyst)
  const overdue = trials.find(
    (t) => isRelevantPhase3(t) && t.status === 'COMPLETED' && t.hasResults === false,
  );
  if (overdue) return overdue;

  // Tier 4: most recent active Phase 2 or 3
  const active = trials.find(
    (t) =>
      isRelevantPhase2or3(t) &&
      (t.status === 'RECRUITING' || t.status === 'ACTIVE_NOT_RECRUITING'),
  );
  if (active) return active;

  // Tier 5: any Phase 3 (fallback)
  const anyPhase3 = trials.find((t) => isRelevantPhase3(t));
  if (anyPhase3) return anyPhase3;

  return trials[0];
}

function parseFdaDate(s: string): number | null {
  // FDA dates are YYYYMMDD format
  if (!s || s.length !== 8) return null;
  const y = s.slice(0, 4);
  const m = s.slice(4, 6);
  const d = s.slice(6, 8);
  const t = new Date(`${y}-${m}-${d}`).getTime();
  return Number.isNaN(t) ? null : t;
}

function earlyReturn(
  ticker: string,
  drug: string,
  sponsor: string | undefined,
  verdict: Verdict,
  confidence: Confidence,
  signals: Signal[],
  math: AuditVerdict['math'],
  dataDensity: AuditVerdict['dataDensity'],
  notes: string[],
): AuditVerdict {
  return {
    ticker,
    drug,
    sponsor,
    verdict,
    confidence,
    primaryFinding: notes[0] ?? '',
    signalsFired: signals,
    math,
    dataDensity,
    notes,
  };
}
