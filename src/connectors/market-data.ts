import yahooFinance from 'yahoo-finance2';

const yf = new (yahooFinance as any)({ suppressNotices: ['yahooSurvey'] });

const VALIDATION_OPTS = { validateResult: false } as const;

export async function getOptionsData(ticker: string) {
  try {
    return await yf.options(ticker, {}, VALIDATION_OPTS);
  } catch (error) {
    throw new Error(`Yahoo Finance error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function getPriceData(ticker: string) {
  try {
    return await yf.quote(ticker, {}, VALIDATION_OPTS);
  } catch (error) {
    throw new Error(`Yahoo Finance error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
