import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';

const BASE_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const parser = new XMLParser();

export async function searchPubMed(term: string) {
  try {
    // 1. Search for IDs
    const searchResponse = await axios.get(`${BASE_URL}/esearch.fcgi`, {
      params: {
        db: 'pubmed',
        term: term,
        retmax: 5,
        retmode: 'json'
      }
    });

    const ids = searchResponse.data.esearchresult.idlist;
    if (!ids || ids.length === 0) return [];

    // 2. Fetch details for these IDs
    const fetchResponse = await axios.get(`${BASE_URL}/efetch.fcgi`, {
      params: {
        db: 'pubmed',
        id: ids.join(','),
        retmode: 'xml'
      }
    });

    const parsedData = parser.parse(fetchResponse.data);
    const articles = parsedData.PubmedArticleSet.PubmedArticle;
    
    // Normalize to array if single result
    const articleList = Array.isArray(articles) ? articles : [articles];

    return articleList.map((article: any) => {
      const medline = article.MedlineCitation?.Article;
      const abstractRaw = medline?.Abstract?.AbstractText;
      const abstract = Array.isArray(abstractRaw)
        ? abstractRaw.map((s: any) => (typeof s === 'string' ? s : s?.['#text'] ?? '')).join(' ')
        : typeof abstractRaw === 'object' && abstractRaw !== null
        ? abstractRaw['#text'] ?? JSON.stringify(abstractRaw)
        : abstractRaw;
      return {
        pmid: article.MedlineCitation?.PMID,
        title: typeof medline?.ArticleTitle === 'object' ? medline.ArticleTitle?.['#text'] : medline?.ArticleTitle,
        abstract,
        date: medline?.Journal?.JournalIssue?.PubDate?.Year || 'Unknown'
      };
    });

  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(`PubMed API error: ${error.message}`);
    }
    throw error;
  }
}
