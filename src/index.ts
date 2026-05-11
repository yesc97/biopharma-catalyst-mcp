import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { searchTrialsByIntervention } from "./connectors/clinical-trials.js";
import { searchPubMed } from "./connectors/pubmed.js";
import { getCIK, getRecentFilings } from "./connectors/sec.js";
import { getOptionsData, getPriceData } from "./connectors/market-data.js";
import { getRecentFdaActivity } from "./connectors/fda.js";
import { getXbrlFacts } from "./connectors/xbrl.js";
import { getInsiderTransactions } from "./connectors/insider.js";
import { getProtocolSnapshot } from "./connectors/trial-history.js";
import { auditCatalyst } from "./aggregator/audit-catalyst.js";
import { getShortInterest } from "./connectors/short-interest.js";

const server = new Server(
  {
    name: "biopharma-catalyst-mcp",
    version: "1.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * List available tools.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_clinical_trials",
        description: "Search ClinicalTrials.gov for studies by intervention (drug or company name)",
        inputSchema: {
          type: "object",
          properties: {
            intervention: {
              type: "string",
              description: "The name of the drug or company to search for",
            },
          },
          required: ["intervention"],
        },
      },
      {
        name: "search_pubmed",
        description: "Search PubMed for scientific papers by term (drug name, condition, etc.)",
        inputSchema: {
          type: "object",
          properties: {
            term: {
              type: "string",
              description: "The search term",
            },
          },
          required: ["term"],
        },
      },
      {
        name: "get_sec_filings",
        description: "Get recent SEC filings (10-K, 10-Q, 8-K, S-1) for a stock ticker.",
        inputSchema: {
          type: "object",
          properties: {
            ticker: {
              type: "string",
              description: "The stock ticker symbol",
            },
          },
          required: ["ticker"],
        },
      },
      {
        name: "get_market_data",
        description: "Get current price and options data for a stock ticker",
        inputSchema: {
          type: "object",
          properties: {
            ticker: {
              type: "string",
              description: "The stock ticker symbol",
            },
          },
          required: ["ticker"],
        },
      },
      {
        name: "get_fda_activity",
        description: "Get FDA submission and approval activity for a drug or sponsor (NDA/BLA filings, approvals, supplements). Use kind='drug' for drug name (brand or generic) or kind='sponsor' for company sponsor name. Submission status codes are decoded (AP=approved, CRL=rejection, WD=withdrawn). Supports auto-fallback from drug to sponsor if results are empty.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Drug name or sponsor name to search",
            },
            kind: {
              type: "string",
              enum: ["drug", "sponsor"],
              description: "Whether the query is a drug name or sponsor company name",
            },
            sponsorFallback: {
              type: "string",
              description: "Optional: Company sponsor name to fall back to if drug search returns nothing",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_xbrl_facts",
        description: "Get structured financial facts from SEC XBRL for a ticker — cash, quarterly burn, runway months, and Going Concern disclosure flag. Used by the Tactical Auditor to detect dilution risk (runway shorter than time to next catalyst).",
        inputSchema: {
          type: "object",
          properties: {
            ticker: { type: "string", description: "The stock ticker symbol" },
          },
          required: ["ticker"],
        },
      },
      {
        name: "get_insider_transactions",
        description: "Get insider Form 4 transactions for a ticker over the last N days. Returns individual transactions, total sales/purchases in dollars, and a Net Insider Sentiment score (purchases - sales). Detects 10b5-1 scheduled sales but does not exempt them.",
        inputSchema: {
          type: "object",
          properties: {
            ticker: { type: "string", description: "The stock ticker symbol" },
            windowDays: { type: "number", description: "Lookback window in days (default 90)" },
          },
          required: ["ticker"],
        },
      },
      {
        name: "get_protocol_snapshot",
        description: "Get current protocol details + amendment proximity for a clinical trial by NCT ID. Flags late-stage protocol amendments (the 'goalpost move') by computing how far into the trial timeline the last update happened. Cannot detect WHAT changed (CT.gov v2 API does not expose protocol diffs) — only WHEN.",
        inputSchema: {
          type: "object",
          properties: {
            nctId: { type: "string", description: "ClinicalTrials.gov NCT identifier (e.g. NCT04994483)" },
          },
          required: ["nctId"],
        },
      },
      {
        name: "audit_catalyst",
        description: "FORENSIC AGGREGATOR. Runs all 8 connectors in parallel against (ticker, drug) and returns a deterministic verdict: CLEAN | FLAG | BEAR_SIGNAL | BLACK_FLAG. Encodes the full Tactical Auditor logic — terminations, FDA rejections, late-stage protocol amendments, dilution risk (runway vs catalyst), Going Concern disclosure, insider unloading, 8-K clusters, literature skepticism. CLEAN means: tried to break the thesis, couldn't. The strongest long signal this tool gives.",
        inputSchema: {
          type: "object",
          properties: {
            ticker: { type: "string", description: "The stock ticker symbol" },
            drug: { type: "string", description: "Drug name (brand or generic) — biopharma signal lives at the drug level, not the company level" },
            sponsor: { type: "string", description: "Optional sponsor company name (used for FDA fallback when drug query returns empty)" },
          },
          required: ["ticker", "drug"],
        },
      },
      {
        name: "get_short_interest",
        description: "Get short interest data for a ticker — short % of float, days to cover, and month-over-month delta. Used to detect SHORT_INTEREST_SPIKE (delta >20%, bear) and SHORT_SQUEEZE_POTENTIAL (days to cover >5, bull).",
        inputSchema: {
          type: "object",
          properties: {
            ticker: { type: "string", description: "The stock ticker symbol" },
          },
          required: ["ticker"],
        },
      },
    ],
  };
});

/**
 * Handle tool calls.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "search_clinical_trials") {
      const { intervention } = z.object({ intervention: z.string() }).parse(args);
      const studies = await searchTrialsByIntervention(intervention);
      return { content: [{ type: "text", text: JSON.stringify(studies, null, 2) }] };
    }

    if (name === "search_pubmed") {
      const { term } = z.object({ term: z.string() }).parse(args);
      const papers = await searchPubMed(term);
      return { content: [{ type: "text", text: JSON.stringify(papers, null, 2) }] };
    }

    if (name === "get_sec_filings") {
      const { ticker } = z.object({ ticker: z.string() }).parse(args);
      const cik = await getCIK(ticker);
      if (!cik) return { content: [{ type: "text", text: `CIK not found for ticker: ${ticker}` }] };
      const filings = await getRecentFilings(cik);
      return { content: [{ type: "text", text: JSON.stringify(filings, null, 2) }] };
    }

    if (name === "get_market_data") {
      const { ticker } = z.object({ ticker: z.string() }).parse(args);
      const [price, options] = await Promise.all([
        getPriceData(ticker),
        getOptionsData(ticker)
      ]);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ price, options }, null, 2)
        }]
      };
    }

    if (name === "get_xbrl_facts") {
      const { ticker } = z.object({ ticker: z.string() }).parse(args);
      const cik = await getCIK(ticker);
      if (!cik) return { content: [{ type: "text", text: `CIK not found for ticker: ${ticker}` }] };
      const facts = await getXbrlFacts(cik);
      return { content: [{ type: "text", text: JSON.stringify(facts, null, 2) }] };
    }

    if (name === "get_insider_transactions") {
      const { ticker, windowDays } = z
        .object({ ticker: z.string(), windowDays: z.number().optional() })
        .parse(args);
      const cik = await getCIK(ticker);
      if (!cik) return { content: [{ type: "text", text: `CIK not found for ticker: ${ticker}` }] };
      const activity = await getInsiderTransactions(cik, windowDays ?? 90);
      return { content: [{ type: "text", text: JSON.stringify(activity, null, 2) }] };
    }

    if (name === "get_protocol_snapshot") {
      const { nctId } = z.object({ nctId: z.string() }).parse(args);
      const snap = await getProtocolSnapshot(nctId);
      return { content: [{ type: "text", text: JSON.stringify(snap, null, 2) }] };
    }

    if (name === "audit_catalyst") {
      const { ticker, drug, sponsor } = z
        .object({
          ticker: z.string(),
          drug: z.string(),
          sponsor: z.string().optional(),
        })
        .parse(args);
      const verdict = await auditCatalyst(ticker, drug, sponsor);
      return { content: [{ type: "text", text: JSON.stringify(verdict, null, 2) }] };
    }

    if (name === "get_fda_activity") {
      const { query, kind, sponsorFallback } = z
        .object({ 
          query: z.string(), 
          kind: z.enum(["drug", "sponsor"]).optional(),
          sponsorFallback: z.string().optional()
        })
        .parse(args);
      
      let activity = await getRecentFdaActivity(query, kind ?? "drug");
      
      // Auto-fallback if empty and it's a drug search and we have a sponsor fallback
      if (activity.recent.length === 0 && (kind === "drug" || !kind) && sponsorFallback) {
        activity = await getRecentFdaActivity(sponsorFallback, "sponsor");
      }

      return {
        content: [{ type: "text", text: JSON.stringify(activity, null, 2) }],
      };
    }

    if (name === "get_short_interest") {
      const { ticker } = z.object({ ticker: z.string() }).parse(args);
      const data = await getShortInterest(ticker);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    throw new Error(`Tool not found: ${name}`);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Invalid arguments: ${error.issues
          .map((e: z.ZodIssue) => `${e.path.join(".")}: ${e.message}`)
          .join(", ")}`
      );
    }
    throw error;
  }
});

/**
 * Start the server using stdio transport.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Biopharma Catalyst MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
