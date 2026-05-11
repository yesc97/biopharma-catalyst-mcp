import axios from 'axios';

const BASE_URL = 'https://clinicaltrials.gov/api/v2';

/**
 * NOTE: CT.gov v2 API does not expose full protocol version history.
 * Only `lastUpdatePostDate` is available. Without scraping the web UI,
 * we cannot know WHAT changed in an amendment — only THAT something changed,
 * and how close to primary completion the change happened.
 *
 * Per the proximity-weight rule (an amendment in month 1 is a correction;
 * an amendment in month 18 of a 24-month trial is a cover-up), we surface:
 *   - the trial timeline (firstPost → primaryCompletion)
 *   - the most recent amendment date
 *   - a proximity bucket (EARLY / MID / LATE / POST_COMPLETION)
 *   - current primary + secondary outcomes (so the LLM can compare to PR)
 */

export interface ProtocolSnapshot {
  nctId: string;
  status?: string;
  studyFirstPostDate?: string;
  primaryCompletionDate?: string;
  primaryCompletionType?: string;   // ACTUAL vs ESTIMATED
  lastUpdateDate?: string;
  hasResults: boolean;

  trialDurationDays?: number;
  amendmentProgressPct?: number;     // 0..1+ — where in the trial was the last amendment
  amendmentProximity?: 'EARLY' | 'MID' | 'LATE' | 'POST_COMPLETION' | 'UNKNOWN';
  amendmentFlag?: 'CORRECTION_ZONE' | 'NOTABLE' | 'GOALPOST_RISK' | 'POST_COMPLETION_AMENDMENT';

  primaryOutcomes: Array<{
    measure: string;
    description?: string;
    timeFrame?: string;
  }>;
  secondaryOutcomes: Array<{
    measure: string;
    description?: string;
    timeFrame?: string;
  }>;

  notes: string[];
}

export async function getProtocolSnapshot(nctId: string): Promise<ProtocolSnapshot> {
  const fields = [
    'protocolSection.statusModule.overallStatus',
    'protocolSection.statusModule.studyFirstPostDateStruct',
    'protocolSection.statusModule.primaryCompletionDateStruct',
    'protocolSection.statusModule.lastUpdatePostDateStruct',
    'protocolSection.outcomesModule',
    'hasResults',
  ].join(',');

  const notes: string[] = [];
  let data: any;
  try {
    const resp = await axios.get(`${BASE_URL}/studies/${nctId}`, {
      params: { fields },
    });
    data = resp.data;
  } catch (e) {
    if (axios.isAxiosError(e) && e.response?.status === 404) {
      return {
        nctId,
        hasResults: false,
        primaryOutcomes: [],
        secondaryOutcomes: [],
        notes: [`NCT ID not found: ${nctId}`],
      };
    }
    throw new Error(`CT.gov error: ${e instanceof Error ? e.message : String(e)}`);
  }

  const proto = data?.protocolSection ?? {};
  const status = proto.statusModule?.overallStatus;
  const firstPost = proto.statusModule?.studyFirstPostDateStruct?.date;
  const primComp = proto.statusModule?.primaryCompletionDateStruct?.date;
  const primCompType = proto.statusModule?.primaryCompletionDateStruct?.type;
  const lastUpdate = proto.statusModule?.lastUpdatePostDateStruct?.date;
  const hasResults = Boolean(data?.hasResults);

  let trialDurationDays: number | undefined;
  let amendmentProgressPct: number | undefined;
  let amendmentProximity: ProtocolSnapshot['amendmentProximity'] = 'UNKNOWN';
  let amendmentFlag: ProtocolSnapshot['amendmentFlag'] | undefined;

  if (firstPost && primComp && lastUpdate) {
    const start = new Date(firstPost).getTime();
    const end = new Date(primComp).getTime();
    const upd = new Date(lastUpdate).getTime();
    trialDurationDays = Math.round((end - start) / (1000 * 60 * 60 * 24));
    if (trialDurationDays > 0) {
      amendmentProgressPct = (upd - start) / (end - start);
      if (amendmentProgressPct > 1) {
        amendmentProximity = 'POST_COMPLETION';
        amendmentFlag = 'POST_COMPLETION_AMENDMENT';
      } else if (amendmentProgressPct > 0.75) {
        amendmentProximity = 'LATE';
        amendmentFlag = 'GOALPOST_RISK';
      } else if (amendmentProgressPct > 0.5) {
        amendmentProximity = 'MID';
        amendmentFlag = 'NOTABLE';
      } else {
        amendmentProximity = 'EARLY';
        amendmentFlag = 'CORRECTION_ZONE';
      }
    }
  } else {
    notes.push('insufficient date metadata — proximity not calculable');
  }

  notes.push(
    'CT.gov v2 API does not expose protocol diff history; cannot detect WHAT changed in an amendment, only WHEN. Compare current primary outcomes to past press releases manually for goalpost confirmation.',
  );

  const primaryOutcomes = (proto.outcomesModule?.primaryOutcomes ?? []).map((o: any) => ({
    measure: o.measure,
    description: o.description,
    timeFrame: o.timeFrame,
  }));
  const secondaryOutcomes = (proto.outcomesModule?.secondaryOutcomes ?? []).map((o: any) => ({
    measure: o.measure,
    description: o.description,
    timeFrame: o.timeFrame,
  }));

  return {
    nctId,
    status,
    studyFirstPostDate: firstPost,
    primaryCompletionDate: primComp,
    primaryCompletionType: primCompType,
    lastUpdateDate: lastUpdate,
    hasResults,
    trialDurationDays,
    amendmentProgressPct,
    amendmentProximity,
    amendmentFlag,
    primaryOutcomes,
    secondaryOutcomes,
    notes,
  };
}
