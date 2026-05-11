import yahooFinance from 'yahoo-finance2';

const VALIDATION_OPTS = { validateResult: false } as const;

export interface ShortInterestData {
  ticker: string;
  shortPct: number | null;
  daysToCover: number | null;
  sharesShort: number | null;
  sharesShortPriorMonth: number | null;
  deltaPercent: number | null;
  reportingDate: Date | null;
}

export async function getShortInterest(ticker: string): Promise<ShortInterestData> {
  const yf = new (yahooFinance as any)({ suppressNotices: ['yahooSurvey'] });

  try {
    const summary = await yf.quoteSummary(
      ticker,
      { modules: ['defaultKeyStatistics'] },
      VALIDATION_OPTS,
    );
    const stats = summary?.defaultKeyStatistics;
    if (!stats) return emptyResult(ticker);

    const sharesShort = typeof stats.sharesShort === 'number' ? stats.sharesShort : null;
    // Yahoo occasionally returns a Date object for this field due to schema drift
    const sharesShortPriorMonth =
      typeof stats.sharesShortPriorMonth === 'number' ? stats.sharesShortPriorMonth : null;

    let deltaPercent: number | null = null;
    if (sharesShort !== null && sharesShortPriorMonth !== null && sharesShortPriorMonth > 0) {
      deltaPercent = ((sharesShort - sharesShortPriorMonth) / sharesShortPriorMonth) * 100;
    }

    return {
      ticker: ticker.toUpperCase(),
      shortPct: stats.shortPercentOfFloat != null ? stats.shortPercentOfFloat * 100 : null,
      daysToCover: stats.shortRatio ?? null,
      sharesShort,
      sharesShortPriorMonth,
      deltaPercent,
      reportingDate: stats.dateShortInterest ?? null,
    };
  } catch {
    return emptyResult(ticker);
  }
}

function emptyResult(ticker: string): ShortInterestData {
  return {
    ticker: ticker.toUpperCase(),
    shortPct: null,
    daysToCover: null,
    sharesShort: null,
    sharesShortPriorMonth: null,
    deltaPercent: null,
    reportingDate: null,
  };
}
