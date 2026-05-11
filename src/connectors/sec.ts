import axios from 'axios';
import { throttleSec } from './sec-throttle.js';

// SEC EDGAR API requires a User-Agent header with contact info
const USER_AGENT = process.env.SEC_USER_AGENT || 'biopharma-catalyst-mcp/1.0 (YOUR_EMAIL@example.com)';

export async function getCIK(ticker: string): Promise<string | null> {
  try {
    const response = await throttleSec(() => axios.get('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': USER_AGENT }
    }));
    
    const data = response.data;
    for (const key in data) {
      if (data[key].ticker === ticker.toUpperCase()) {
        // Pad CIK to 10 digits
        return data[key].cik_str.toString().padStart(10, '0');
      }
    }
    return null;
  } catch (error) {
    console.error('Error fetching CIK:', error);
    return null;
  }
}

export async function getRecentFilings(cik: string) {
  try {
    const response = await throttleSec(() => axios.get(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { 'User-Agent': USER_AGENT }
    }));
    
    const filings = response.data.filings.recent;
    const recentFilings = [];
    
    // Get last 10 filings
    for (let i = 0; i < Math.min(10, filings.accessionNumber.length); i++) {
      recentFilings.push({
        accessionNumber: filings.accessionNumber[i],
        filingDate: filings.filingDate[i],
        form: filings.form[i],
        primaryDocument: filings.primaryDocument[i],
        description: filings.primaryDocDescription[i]
      });
    }
    
    return recentFilings;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(`SEC API error: ${error.message}`);
    }
    throw error;
  }
}
