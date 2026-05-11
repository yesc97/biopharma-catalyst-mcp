import axios from 'axios';

const BASE_URL = 'https://clinicaltrials.gov/api/v2';

export interface Trial {
  hasResults?: boolean;
  protocolSection?: {
    identificationModule?: {
      nctId?: string;
      officialTitle?: string;
    };
    statusModule?: {
      overallStatus?: string;
      startDateStruct?: { date?: string };
      completionDateStruct?: { date?: string };
    };
    descriptionModule?: {
      briefSummary?: string;
    };
    armsInterventionsModule?: {
      interventions?: Array<{ name?: string }>;
    };
  };
}

export async function searchTrialsByIntervention(intervention: string) {
  try {
    const response = await axios.get(`${BASE_URL}/studies`, {
      params: {
        'query.intr': intervention,
        'pageSize': 10,
      }
    });

    const studies = response.data.studies ?? [];
    return studies.map((s: any) => {
      const proto = s.protocolSection;
      const status = proto?.statusModule?.overallStatus;
      const completionDate = proto?.statusModule?.completionDateStruct?.date;
      const hasResults = Boolean(s.hasResults);

      let auditFlag: string | undefined;
      if (status === 'COMPLETED' && !hasResults) {
        auditFlag = 'completed_without_results';
      } else if (status === 'COMPLETED' && completionDate) {
        const completed = new Date(completionDate);
        const monthsSince = (Date.now() - completed.getTime()) / (1000 * 60 * 60 * 24 * 30);
        if (monthsSince > 6 && !hasResults) auditFlag = 'overdue_no_readout';
      }
      if (status === 'TERMINATED') auditFlag = 'terminated';
      if (status === 'WITHDRAWN') auditFlag = 'withdrawn';

      return {
        nctId: proto?.identificationModule?.nctId,
        title: proto?.identificationModule?.officialTitle,
        status,
        startDate: proto?.statusModule?.startDateStruct?.date,
        completionDate,
        summary: proto?.descriptionModule?.briefSummary,
        interventions: proto?.armsInterventionsModule?.interventions?.map((i: any) => i.name),
        leadSponsor: proto?.sponsorCollaboratorsModule?.leadSponsor?.name,
        sponsorClass: proto?.sponsorCollaboratorsModule?.leadSponsor?.class,
        phase: proto?.designModule?.phases,
        hasResults,
        auditFlag
      };
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(`ClinicalTrials.gov API error: ${error.message}`);
    }
    throw error;
  }
}
