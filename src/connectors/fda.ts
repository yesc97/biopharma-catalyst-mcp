import axios from 'axios';

const OPENFDA_BASE = 'https://api.fda.gov';

export interface FdaApproval {
  applicationNumber?: string;
  sponsorName?: string;
  brandName?: string;
  genericName?: string;
  submissionType?: string;
  submissionStatus?: string;
  submissionStatusLabel?: string;
  submissionStatusDate?: string;
  reviewPriority?: string;
}

const STATUS_CODE_LABELS: Record<string, string> = {
  AP: 'approved',
  TA: 'tentative_approval',
  WD: 'withdrawn',
  CRL: 'complete_response_letter (rejection)',
  N: 'not_yet_decided',
  DSCN: 'discontinued',
};

function decodeStatus(code?: string): string | undefined {
  if (!code) return undefined;
  return STATUS_CODE_LABELS[code] ?? code;
}

function flattenSubmissions(record: any): FdaApproval[] {
  const products = record.products ?? [];
  const brand = products[0]?.brand_name;
  const generic = products[0]?.active_ingredients?.[0]?.name;
  const submissions = record.submissions ?? [];
  return submissions.map((s: any) => ({
    applicationNumber: record.application_number,
    sponsorName: record.sponsor_name,
    brandName: brand,
    genericName: generic,
    submissionType: s.submission_type,
    submissionStatus: s.submission_status,
    submissionStatusLabel: decodeStatus(s.submission_status),
    submissionStatusDate: s.submission_status_date,
    reviewPriority: s.review_priority,
  }));
}

export async function searchFdaBySponsor(sponsor: string): Promise<FdaApproval[]> {
  try {
    const response = await axios.get(`${OPENFDA_BASE}/drug/drugsfda.json`, {
      params: {
        search: `sponsor_name:"${sponsor}"`,
        limit: 25,
      },
    });
    const records = response.data.results ?? [];
    return records.flatMap(flattenSubmissions);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) return [];
    if (axios.isAxiosError(error)) throw new Error(`openFDA error: ${error.message}`);
    throw error;
  }
}

export async function searchFdaByDrug(drugName: string): Promise<FdaApproval[]> {
  try {
    const response = await axios.get(`${OPENFDA_BASE}/drug/drugsfda.json`, {
      params: {
        search: `(openfda.brand_name:"${drugName}" OR openfda.generic_name:"${drugName}" OR products.brand_name:"${drugName}" OR products.active_ingredients.name:"${drugName}")`,
        limit: 25,
      },
    });
    const records = response.data.results ?? [];
    return records.flatMap(flattenSubmissions);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) return [];
    if (axios.isAxiosError(error)) throw new Error(`openFDA error: ${error.message}`);
    throw error;
  }
}

export async function getRecentFdaActivity(query: string, kind: 'sponsor' | 'drug' = 'drug'): Promise<{
  upcoming: FdaApproval[];
  recent: FdaApproval[];
  approved: FdaApproval[];
}> {
  const all = kind === 'sponsor' ? await searchFdaBySponsor(query) : await searchFdaByDrug(query);

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const sorted = [...all].sort((a, b) =>
    (b.submissionStatusDate ?? '').localeCompare(a.submissionStatusDate ?? '')
  );

  const upcoming = sorted.filter(
    (s) => s.submissionStatus !== 'AP' && (s.submissionStatusDate ?? '') >= today
  );
  const approved = sorted.filter((s) => s.submissionStatus === 'AP').slice(0, 10);
  const recent = sorted.slice(0, 10);

  return { upcoming, recent, approved };
}
