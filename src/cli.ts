/**
 * Generic CLI: analyze any ticker + drug combo.
 *
 * Usage:
 *   node build/cli.js <TICKER> <DRUG_NAME> [SPONSOR_NAME]
 *
 * Examples:
 *   node build/cli.js PFE "Comirnaty" "Pfizer"
 *   node build/cli.js MRK "Keytruda" "Merck"
 */
import { searchTrialsByIntervention } from "./connectors/clinical-trials.js";
import { searchPubMed } from "./connectors/pubmed.js";
import { getCIK, getRecentFilings } from "./connectors/sec.js";
import { getPriceData, getOptionsData } from "./connectors/market-data.js";
import { getRecentFdaActivity } from "./connectors/fda.js";

const [, , tickerArg, drugArg, sponsorArg] = process.argv;

if (!tickerArg || !drugArg) {
  console.error("Usage: node build/cli.js <TICKER> <DRUG_NAME> [SPONSOR_NAME]");
  process.exit(1);
}

const TICKER = tickerArg.toUpperCase();
const DRUG = drugArg;
const SPONSOR = sponsorArg;

function header(label: string) {
  console.log(`\n${"=".repeat(70)}\n${label}\n${"=".repeat(70)}`);
}

async function run() {
  header(`${TICKER} / ${DRUG}${SPONSOR ? ` / ${SPONSOR}` : ""} — research snapshot`);

  header("[1] MARKET SNAPSHOT");
  try {
    const price: any = await getPriceData(TICKER);
    if (price?.regularMarketPrice === undefined) {
      console.log(`  Ticker ${TICKER}: no live data (delisted, merged, or invalid).`);
    } else {
      console.log(`Price        : $${price.regularMarketPrice} (${price?.regularMarketChangePercent?.toFixed(2) ?? "?"}%)`);
      console.log(`52W Range    : $${price?.fiftyTwoWeekLow} – $${price?.fiftyTwoWeekHigh}`);
      console.log(`Market cap   : ${price?.marketCap ? "$" + (price.marketCap / 1e6).toFixed(1) + "M" : "n/a"}`);
    }
  } catch (e) {
    console.error(`  (market data failed: ${(e as Error).message})`);
  }

  header("[2] OPTIONS — IMPLIED MOVE");
  try {
    const opts: any = await getOptionsData(TICKER);
    const expirations: Date[] = opts?.expirationDates ?? [];
    console.log(`Expirations available: ${expirations.length}`);
    const chain = opts?.options?.[0];
    if (chain) {
      const atmCall = chain.calls?.find((c: any) => c.inTheMoney === false) ?? chain.calls?.[0];
      const atmPut = chain.puts?.find((p: any) => p.inTheMoney === false) ?? chain.puts?.[0];
      if (atmCall) console.log(`ATM call IV  : ${(atmCall.impliedVolatility * 100).toFixed(1)}% (strike $${atmCall.strike})`);
      if (atmPut) console.log(`ATM put IV   : ${(atmPut.impliedVolatility * 100).toFixed(1)}% (strike $${atmPut.strike})`);
    }
  } catch (e) {
    console.error(`  (options failed: ${(e as Error).message})`);
  }

  header("[3] SEC FILINGS — last 5");
  try {
    const cik = await getCIK(TICKER);
    if (cik) {
      const filings = await getRecentFilings(cik);
      filings.slice(0, 5).forEach((f) => {
        console.log(`  ${f.filingDate}  ${f.form.padEnd(8)}  ${f.description ?? ""}`);
      });
    } else {
      console.log("  (no CIK found)");
    }
  } catch (e) {
    console.error(`  (SEC failed: ${(e as Error).message})`);
  }

  header(`[4] FDA ACTIVITY — drug "${DRUG}"`);
  try {
    const fda = await getRecentFdaActivity(DRUG, "drug");
    console.log(`Upcoming actions : ${fda.upcoming.length}`);
    console.log(`Approvals        : ${fda.approved.length}`);
    fda.recent.slice(0, 5).forEach((s) => {
      console.log(`  ${s.submissionStatusDate ?? "????????"}  ${(s.submissionType ?? "?").padEnd(6)}  ${s.submissionStatus ?? "?"}  ${s.brandName ?? s.genericName ?? ""}`);
    });
    if (fda.recent.length === 0 && SPONSOR) {
      console.log(`  (no openFDA records for drug; falling back to sponsor "${SPONSOR}")`);
      const fdaSponsor = await getRecentFdaActivity(SPONSOR, "sponsor");
      fdaSponsor.recent.slice(0, 5).forEach((s) => {
        console.log(`  ${s.submissionStatusDate ?? "????????"}  ${(s.submissionType ?? "?").padEnd(6)}  ${s.submissionStatus ?? "?"}  ${s.brandName ?? s.genericName ?? ""}`);
      });
    }
  } catch (e) {
    console.error(`  (FDA failed: ${(e as Error).message})`);
  }

  header(`[5] CLINICAL TRIALS — intervention "${DRUG}"`);
  try {
    const studies = await searchTrialsByIntervention(DRUG);
    console.log(`Studies found: ${studies.length}`);
    studies.slice(0, 5).forEach((s: any) => {
      console.log(`  [${(s.status ?? "?").padEnd(20)}] ${s.nctId ?? ""}  ${s.title ?? ""}`);
      if (s.completionDate) console.log(`    completion: ${s.completionDate}`);
    });
  } catch (e) {
    console.error(`  (CT.gov failed: ${(e as Error).message})`);
  }

  header(`[6] PUBMED — literature on "${DRUG}"`);
  try {
    const papers = await searchPubMed(DRUG);
    console.log(`Papers: ${papers.length}`);
    papers.slice(0, 5).forEach((p) => {
      console.log(`  (${p.date}) ${p.title}`);
    });
  } catch (e) {
    console.error(`  (PubMed failed: ${(e as Error).message})`);
  }

  console.log(`\n${"=".repeat(70)}\nDONE\n${"=".repeat(70)}\n`);
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
