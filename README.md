# biopharma-catalyst-mcp

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![CI](https://github.com/yesc97/biopharma-catalyst-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/yesc97/biopharma-catalyst-mcp/actions/workflows/ci.yml)

A forensic biopharma research MCP server — pulls catalyst-grade signals from 6 free, authoritative sources (ClinicalTrials.gov, PubMed, SEC EDGAR, SEC XBRL companyfacts, openFDA, Yahoo Finance) and hands them to your LLM. Includes a **server-side aggregator** that runs the full forensic workflow in one tool call and returns a deterministic verdict.

Built for the workflow most retail biopharma analysts actually run: a ticker hits the radar, you spend 2–4 hours grinding Google Scholar, FDA pages, EDGAR, and the options chain to decide if the catalyst story holds up. This compresses that to ~30 seconds.

## Table of Contents
- [The headline tool: audit_catalyst](#the-headline-tool-audit_catalyst)
- [The Tactical Auditor system prompt (alternative)](#the-tactical-auditor-system-prompt-alternative)
- [Tools](#tools)
- [Install](#install)
- [Configure as an MCP server](#configure-as-an-mcp-server)
- [CLI mode](#cli-mode)
- [Why search by drug name, not ticker](#why-search-by-drug-name-not-ticker)
- [Live analysis examples](#live-analysis-examples)
- [Roadmap](#roadmap)
- [Technical reference & maintenance](#technical-reference--maintenance)
- [Contributing](#contributing)
- [Contact](#contact)
- [Notes](#notes)
- [License](#license)

## The headline tool: `audit_catalyst`

Single tool, single call, single verdict. Works on any sponsor / drug combination — no hardcoded tickers anywhere.

### Big Pharma example — the "Clean" case

```
audit_catalyst(ticker="MRK", drug="Keytruda", sponsor="Merck")

→ Verdict: CLEAN (MED)
  Primary finding: Tried to break thesis. Approved 20260424. (1 secondary
                   concern noted in signals)
  Signals fired:
    [A-BEAR] AMENDED_AFTER_COMPLETION_NO_RESULTS — NCT04700072
    [S-BULL] RECENT_FDA_APPROVAL — 20260424
  Math: positive cash flow, IV 29.1%, insider net $0.00M
```

A `CLEAN` verdict is the highest praise this tool gives. It means the auditor cross-referenced 9 sources, tried to break the bull thesis, and couldn't (or could only surface secondary concerns that don't outweigh an S-tier bull signal). That's a stronger long signal than a generic "BUY" rating, because failing to break a thesis is harder than confirming it.

The verdict scale:

- `CLEAN` — tried to break the thesis, couldn't. Confidence drops if A-tier concerns surface.
- `FLAG` — A-tier bear signal fired without an offsetting S-tier bull. Data ambiguous; look harder.
- `BEAR_SIGNAL` — at least one S-tier bear fired (terminated trial, FDA rejection, dilution risk, etc.). Confidence rises with multiple S-tier bears.
- `BLACK_FLAG` — Going Concern disclosed by auditors + cash runway under 6 months. Equity at high risk of zero.
- `DISQUALIFIED` — insufficient data tied to the company. Try a different drug or query the underlying connectors directly.

The math (cash runway, months to catalyst, insider sentiment, ATM IV, catalyst date) is also returned for the user to inspect. The LLM narrates; the verdict is code.

## The Tactical Auditor system prompt (alternative)

If you'd rather have the LLM run the workflow itself across the individual tools, drop this prompt into your MCP client as a custom instruction or system prompt:

```
You are a Tactical Biopharma Auditor. Your goal is to cross-reference company PR
against raw data from ClinicalTrials.gov, PubMed, SEC EDGAR, openFDA, and the
options market to find discrepancies. You are looking for "Trial Drift" and
"Signal Decay."

When auditing a ticker/drug, run this workflow:

1. Trial Drift Audit (search_clinical_trials)
   - Flag terminations, withdrawals, or COMPLETED status without a results readout.
   - If a Phase 2/3 trial has a completionDate in the past but the market is still
     waiting for "upcoming data," flag the delay as a negative signal.
   - The connector emits an `auditFlag` field; surface it in your output.

2. Literature Signal Check (search_pubmed)
   - Scan abstracts for skepticism keywords: "controversial," "mixed results,"
     "safety concerns," "marginal improvement," "failed to demonstrate."
   - Compare to standard of care if abstracts mention comparators.

3. Filing Density & FDA History (get_sec_filings, get_fda_activity)
   - Count 8-K (current event) frequency. A flurry of 8-Ks before a catalyst
     usually signals structural changes or pre-announcing trouble.
   - Has the drug or sponsor had NDAs marked CRL (rejected), WD (withdrawn), or
     received supplements with regulatory friction?

4. Market Pricing (get_market_data)
   - Check ATM IV. If IV is extremely high (>150%) but the bull case seems
     "certain," the market is pricing a binary failure risk that needs identifying.

Output format:
   * Audit Verdict: [CLEAN / FLAG / BEAR SIGNAL]
     (CLEAN means: tried to break the thesis, couldn't.)
   * Primary Discrepancy: One sentence on the biggest data point that contradicts
     the company's PR.
   * Key Risks: 2-3 specific risks found in CT.gov or PubMed.
   * Data Density: Summary of how much info we actually have vs. how much is
     missing.
```

Then ask: `audit ticker SRPT, drug elevidys` (or whatever).

A `CLEAN` verdict is the highest praise this tool gives — it means the auditor tried to find a hole in the thesis and couldn't. That's a stronger long signal than a generic bull stamp.

## Tools

Ten tools — nine raw connectors plus the aggregator:

| Tool                        | Source                        | What it does                                                  |
| --------------------------- | ----------------------------- | ------------------------------------------------------------- |
| `audit_catalyst`            | (aggregator)                  | **Headline tool.** Runs the full Tactical Auditor workflow against (ticker, drug). Deterministic verdict. |
| `search_clinical_trials`    | ClinicalTrials.gov v2 API     | Pipeline + status by intervention; flags terminations, withdrawals, completed-without-readout |
| `search_pubmed`             | NCBI E-utilities              | Recent literature on a drug / mechanism / disease             |
| `get_sec_filings`           | SEC EDGAR                     | Last 10 filings (10-K, 10-Q, 8-K, S-1) by ticker              |
| `get_xbrl_facts`            | SEC XBRL companyfacts         | Cash, quarterly burn, runway months, Going Concern flag       |
| `get_insider_transactions`  | SEC EDGAR Form 4 XML          | Role-classified insider transactions (clinical/financial/admin), coordinated exit detection (72h window), Net Insider Sentiment ($), 10b5-1 detection |
| `get_short_interest`        | Yahoo Finance                 | Short % of float, days to cover, MoM delta — feeds SHORT_INTEREST_SPIKE and SHORT_SQUEEZE_POTENTIAL signals |
| `get_protocol_snapshot`     | ClinicalTrials.gov v2 API     | Trial protocol + amendment proximity (goalpost detection)     |
| `get_market_data`           | Yahoo Finance                 | Quote + full options chain (IV, strikes, expirations)         |
| `get_fda_activity`          | openFDA `drugsfda.json`       | NDA/BLA submissions with decoded status (AP, CRL, WD, etc.); auto-fallback drug→sponsor |

All sources are free, no API keys required.

## Install

```bash
git clone https://github.com/yesc97/biopharma-catalyst-mcp.git
cd biopharma-catalyst-mcp
npm install
npm run build
```

## Configure as an MCP server

Add to your MCP client config (e.g. `~/.config/claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "biopharma-catalyst": {
      "command": "node",
      "args": ["/absolute/path/to/biopharma-catalyst-mcp/build/index.js"],
      "env": {
        "SEC_USER_AGENT": "Your Name <your-email@example.com>"
      }
    }
  }
}
```

`SEC_USER_AGENT` is required by SEC EDGAR — use a real contact email or you'll be rate-limited.

## CLI mode

For headless runs without an MCP client:

```bash
node build/cli.js <TICKER> "<DRUG_NAME>" "<SPONSOR_NAME>"
node build/cli.js PFE "Comirnaty" "Pfizer"
node build/cli.js MRK "Keytruda" "Merck"
node build/cli.js LLY "Mounjaro" "Eli Lilly"
```

The CLI prints a structured human-readable snapshot — same data the MCP tools expose.

## Why search by drug name, not ticker

Biopharma research signal lives at the **pipeline drug level**, not the corporate level. Searching CT.gov for "Pfizer" returns hundreds of unrelated trials across every therapeutic area. Searching for `Comirnaty` returns the specific vaccine trials that drive regulatory outcomes. Always feed the tools the drug name (brand or generic), and use the ticker only for market data + SEC filings.

## Live analysis examples

Institutional-grade biopharma research requires analyzing the world's largest pipelines. A few examples from live runs:

### `audit_catalyst("LLY", "Mounjaro", "Eli Lilly")`

```
Verdict: CLEAN (HIGH)
Primary finding: Tried to break thesis. Strong pipeline density with 10+
                 ongoing Phase 3 trials.
Signals:
  [S-BULL] RECENT_FDA_APPROVAL — 20260315
  [A-BULL] INSIDER_BUYING — net $2.4M over 90d
```

### `audit_catalyst("PFE", "Comirnaty", "Pfizer")`

```
Verdict: CLEAN (MED)
Primary finding: Massive data density; no S-tier bear signals detected in
                 last 12 months.
Signals:
  [A-BEAR] 8K_CLUSTER — 4 filings in last 30d (normal for earnings)
  [S-BULL] RECENT_FDA_APPROVAL
```

### `audit_catalyst("MRK", "Keytruda", "Merck")`

```
Verdict: CLEAN (MED)
Primary finding: Approved 20260424. (1 secondary concern noted in signals)
Signals:
  [A-BEAR] AMENDED_AFTER_COMPLETION_NO_RESULTS — NCT04700072
  [S-BULL] RECENT_FDA_APPROVAL
```

10b5-1 plans don't exempt insider selling from the bear column — management chose to schedule those sales. Real money out the door is real money out the door.

## Roadmap

- [ ] **CT.gov protocol diff** — currently we detect *late-stage amendments* via the proximity heuristic (last update vs primary completion date). The CT.gov v2 API does not expose what changed in an amendment. To detect specific endpoint changes (the canonical goalpost move), we'd need to scrape the public version-history web UI or wait for an API update.
- [ ] **FDA AdComm forward calendar** — currently we surface FDA submission history. A forward calendar of advisory committee meetings would let users plan around binary regulatory events.
- [ ] **Polygon / Tradier connector** — Yahoo's options data is incomplete on illiquid small-cap biotech. A paid market-data option for power users.
- [ ] **Sponsor-class weighting** — currently the aggregator filters trials to those sponsored by the queried company. Industry-academic partnerships and NIH-sponsored trials are excluded. Could weight rather than filter.
- [ ] **10-K MD&A scan** — extract the "Risk Factors" section and look for management-disclosed risks beyond the Going Concern check.

## Technical reference & maintenance

### Verifying locally

After any change, rebuild and run the MCP stdio smoke test:

```bash
npm run build
node /path/to/verify-mcp.mjs        # 9-tool stdio handshake + 1 invocation each
```

For the aggregator specifically:

```bash
node build/cli.js <TICKER> "<DRUG>" "<SPONSOR>"
```

Both should complete in under 30 seconds against live APIs. If they don't, check whether SEC has rate-limited you (see Per-source caveats below).

### Adding a new connector

1. Create `src/connectors/<name>.ts`. Export a single async function that returns a structured shape (no LLM-dependent fields, just data).
2. If it hits `sec.gov` or `data.sec.gov`, wrap each axios call in `throttleSec(() => axios.get(...))`.
3. Wire it in `src/index.ts`: import, add to the `tools/list` schema, add the dispatch case in the request handler.
4. Optionally wire into `audit_catalyst` — add to the `Promise.allSettled` block and write the signal logic against the spec.
5. Add a smoke test invocation to your local `verify-mcp.mjs`.

### Per-source caveats

- **SEC.gov:** 10 req/sec hard cap. Throttled to ~5 req/sec via `sec-throttle.ts`. Going over triggers a 10-minute IP block. The `SEC_USER_AGENT` env var must be a real contact email — fake placeholders are rate-limited harder.
- **CT.gov v2:** No protocol-diff endpoint. The goalpost detector uses a proximity heuristic (firstPost vs primaryCompletion vs lastUpdate). True diff requires scraping the public version-history UI; queued for v1.2.
- **Yahoo Finance:** Schema validation is suppressed because Yahoo drifts on illiquid biotech option chains. Calls return what they can; expect occasional empty option chains.
- **openFDA:** `drugsfda.json` covers NDA/BLA submission history but not always forward PDUFA dates. Use CT.gov `completionDate` as the leading catalyst indicator.
- **Form 4 XML:** EDGAR's `primaryDocument` field points to the HTML wrapper, not the structured XML. The connector lists each filing's folder via `index.json` and finds the `.xml` entry. Capped at 25 most recent filings per audit to bound cost.

### Security

- **`SEC_USER_AGENT` must stay in local environment variables and never be committed to version control.** It contains a real contact email and gets logged on the SEC side; treating it as a secret keeps it out of public git history and avoids inadvertent doxxing.
- `.env` and `.env.local` are gitignored by default in this repo; keep your contact details there.
- If you fork this project, set your own `SEC_USER_AGENT` — do not reuse another user's.
- Agent context files (`GEMINI.md`, `CLAUDE.md`, `.gemini/`, `.claude/`) are also gitignored; never commit those, they may contain operating notes / strategy details meant for local use only.

### Versioning

- **Patch (`x.x.+1`):** bug fixes, doc tweaks, no schema changes.
- **Minor (`x.+1.0`):** new tools, new connectors, additive signal logic, schema additions to existing tools.
- **Major (`+1.0.0`):** breaking schema changes (renamed fields, removed tools), new required env vars, MCP protocol upgrades.

### Shipping a release

1. Bump `version` in `package.json` to match the change scope.
2. Update README "headline tool" or "Forensic case studies" sections if behavior changed.
3. Run `npm run build && node verify-mcp.mjs` — must be 9/9 passing.
4. Commit using conventional-commit style (`feat:`, `fix:`, `chore:`).
5. Tag the commit: `git tag v<X.Y.Z>`.
6. Push to your remote when ready; optional `npm publish` if you maintain a public npm release.

## Contact

**Attila Kovacs (yesc97)**
- Email: [igenccc@gmail.com](mailto:igenccc@gmail.com)
- GitHub: [yesc97](https://github.com/yesc97)

## Notes

- **Not investment advice.** This is research automation. The synthesis step — and the trade — is on you.

## License

ISC
