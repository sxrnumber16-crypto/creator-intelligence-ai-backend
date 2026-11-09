import type { DataSourceInfo, KeywordCandidate, KeywordCluster, SearchIntent } from '@cia/shared';
import { searchVideos, listChannelsByIds, type YtSearchItem, type YtVideoItem } from '../youtube/dataApi.js';
import { median, clamp, fetchWithRetry } from '../../lib/http.js';
import { extractJson } from '../ai/types.js';

/**
 * Keyword intelligence engine.
 *
 * DATA HONESTY RULES (see YOUTUBE_INTEGRATION.md):
 * - YouTube exposes NO official keyword search volume and NO official difficulty.
 *   We never show "search volume" numbers.
 * - "Opportunity" is a RELATIVE 0-100 estimate computed from measurable public
 *   signals (competition stats of top-ranking videos). The formula is shown to users.
 * - Sources used: (1) YouTube Data API search competition analysis [official],
 *   (2) AI-assisted keyword expansion [clearly labeled], (3) YouTube public
 *   autocomplete suggestions [supplementary, unofficial but public; the engine
 *   works fully without it].
 */

const AUTOCOMPLETE_URL = 'https://suggestqueries.google.com/complete/search';

export interface CompetitionAnalysis {
  keyword: string;
  totalResultsEstimate: number | null;
  sampleSize: number;
  topVideos: YtVideoItem[];
  medianTopViews: number | null;
  p25TopViews: number | null;
  exactMatchTitleRatio: number | null; // fraction of top-10 titles containing the keyword
  medianChannelSubs: number | null;
  medianAgeDays: number | null;
  recentUploadMedianViews: number | null; // views of videos < 30 days old in top results
  shortsShareInTop: number | null;
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

export async function autocompleteSuggestions(seed: string): Promise<string[]> {
  try {
    const url = `${AUTOCOMPLETE_URL}?client=firefox&ds=yt&q=${encodeURIComponent(seed)}`;
    const response = await fetchWithRetry(url, { timeoutMs: 8000, retries: 0 });
    if (!response.ok) return [];
    const data = (await response.json()) as [string, string[]];
    return Array.isArray(data?.[1]) ? data[1].slice(0, 20) : [];
  } catch {
    return []; // supplementary source only - failure is silent by design
  }
}

export function morphologicalVariants(seed: string): string[] {
  const base = seed.trim().toLowerCase();
  const variants = new Set<string>();
  variants.add(`${base} tutorial`);
  variants.add(`${base} tips`);
  variants.add(`how to ${base}`);
  variants.add(`${base} for beginners`);
  variants.add(`best ${base}`);
  variants.add(`${base} 2026`);
  variants.add(`${base} mistakes`);
  return [...variants].slice(0, 7);
}

export async function aiExpandKeywords(userId: string, seed: string): Promise<string[]> {
  try {
    const { runCompletion } = await import('../ai/gateway.js');
    const result = await runCompletion(userId, 'seo_analysis', {
      system:
        'You are a YouTube keyword researcher. Given a seed keyword, return 15 related keywords a creator could target: mix of long-tail, questions, comparisons, beginner variants. Return STRICT JSON: {"keywords":["..."]}. No commentary.',
      messages: [{ role: 'user', content: `Seed keyword: "${seed}". Niche context: YouTube.` }],
      json: true,
      maxTokens: 500,
    });
    const parsed = extractJson(result.text) as { keywords?: string[] };
    return Array.isArray(parsed.keywords) ? parsed.keywords.filter((k) => typeof k === 'string').slice(0, 15) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Competition analysis (official Data API)
// ---------------------------------------------------------------------------

export async function analyzeCompetition(keyword: string, apiKey: string): Promise<CompetitionAnalysis> {
  const { items: searchItems, totalResults } = await searchVideos(keyword, { kind: 'apiKey' }, { maxResults: 12 });
  return analyzeCompetitionFromResults(keyword, apiKey, searchItems, totalResults);
}

export async function analyzeCompetitionFromResults(
  keyword: string,
  apiKey: string,
  searchItems: YtSearchItem[],
  totalResults: number,
): Promise<CompetitionAnalysis> {
  const videoIds = searchItems.map((i) => i.id.videoId).filter((v): v is string => Boolean(v)).slice(0, 10);
  const { listVideosByIds } = await import('../youtube/dataApi.js');
  const videoItems: YtVideoItem[] = videoIds.length > 0 ? (await listVideosByIds(videoIds, { kind: 'apiKey' })).items : [];

  const views = videoItems.map((v) => (v.statistics?.viewCount != null ? Number(v.statistics.viewCount) : null)).filter((v): v is number => v !== null);
  const ages = videoItems.map((v) => (Date.now() - new Date(v.snippet.publishedAt).getTime()) / 86400_000);
  const exactMatches = videoItems.filter((v) => v.snippet.title.toLowerCase().includes(keyword.toLowerCase())).length;
  const recent = videoItems.filter((v) => (Date.now() - new Date(v.snippet.publishedAt).getTime()) < 30 * 86400_000);
  const recentViews = recent.map((v) => Number(v.statistics?.viewCount ?? 0));
  const shorts = videoItems.filter((v) => {
    const m = /^PT(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(v.contentDetails?.duration ?? '');
    const secs = m ? (Number(m[1] ?? 0) * 60) + Math.round(Number(m[2] ?? 0)) : 0;
    return secs > 0 && secs <= 62;
  }).length;

  // Channel subs for top results (1 batched call)
  let medianSubs: number | null = null;
  const channelIds = [...new Set(videoItems.map((v) => v.snippet.channelId))].slice(0, 50);
  if (channelIds.length > 0) {
    try {
      const { items: channels } = await listChannelsByIds(channelIds, { kind: 'apiKey' });
      const subs = channels
        .map((c) => (c.statistics?.subscriberCount != null ? Number(c.statistics.subscriberCount) : null))
        .filter((s): s is number => s !== null && s > 0);
      medianSubs = median(subs);
    } catch {
      /* optional signal */
    }
  }

  return {
    keyword,
    totalResultsEstimate: totalResults,
    sampleSize: videoItems.length,
    topVideos: videoItems,
    medianTopViews: median(views),
    p25TopViews: percentile(views, 0.25),
    exactMatchTitleRatio: videoItems.length > 0 ? exactMatches / videoItems.length : null,
    medianChannelSubs: medianSubs,
    medianAgeDays: median(ages),
    recentUploadMedianViews: median(recentViews),
    shortsShareInTop: videoItems.length > 0 ? shorts / videoItems.length : null,
  };
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clamp(Math.floor(sorted.length * p), 0, sorted.length - 1);
  return sorted[idx];
}

// ---------------------------------------------------------------------------
// Opportunity score - the transparent formula
// ---------------------------------------------------------------------------

/**
 * competitionScore 0-100 (higher = harder):
 *   view pressure   (0-45): log-scaled median top-10 views
 *   exact match     (0-20): fraction of top titles exactly targeting the keyword
 *   channel power   (0-20): log-scaled median subscriber count of ranking channels
 *   recency defense (0-15): fresh uploads holding top spots signals an active fight
 * opportunity = 100 - competitionScore, then ± freshness adjustment (±10).
 */
export function computeOpportunity(a: CompetitionAnalysis): {
  competitionScore: number;
  opportunity: number;
  factors: KeywordCandidate['opportunityFactors'];
  interpretation: string[];
} {
  const interpretation: string[] = [];
  let competition = 0;

  if (a.medianTopViews != null) {
    const viewPressure = clamp((Math.log10(Math.max(a.medianTopViews, 1)) / 6) * 45, 0, 45); // 1M median => 45
    competition += viewPressure;
    interpretation.push(`Median views of top-10 ranking videos: ${format(a.medianTopViews)} (view pressure ${viewPressure.toFixed(0)}/45).`);
  } else {
    interpretation.push('No view data available for top results - competition estimate is incomplete.');
  }

  if (a.exactMatchTitleRatio != null) {
    const exact = a.exactMatchTitleRatio * 20;
    competition += exact;
    interpretation.push(`${Math.round(a.exactMatchTitleRatio * 100)}% of top-10 titles directly target this keyword (+${exact.toFixed(0)}/20 exact-match pressure).`);
  }

  if (a.medianChannelSubs != null) {
    const power = clamp((Math.log10(Math.max(a.medianChannelSubs, 1)) / 7) * 20, 0, 20); // 10M subs => 20
    competition += power;
    interpretation.push(`Median ranking-channel size: ${format(a.medianChannelSubs)} subscribers (channel power ${power.toFixed(0)}/20).`);
  }

  if (a.medianAgeDays != null && a.medianAgeDays < 60) {
    const recency = 15 * (1 - a.medianAgeDays / 60);
    competition += recency;
    interpretation.push(`Top results are recent (median ${Math.round(a.medianAgeDays)} days old) - actively contested (+${recency.toFixed(0)}/15).`);
  }

  const competitionScore = Math.round(clamp(competition, 0, 100));
  let opportunity = 100 - competitionScore;

  if (a.recentUploadMedianViews != null && a.medianTopViews != null && a.medianTopViews > 0) {
    const freshRatio = a.recentUploadMedianViews / a.medianTopViews;
    if (freshRatio > 0.5) {
      opportunity += 10;
      interpretation.push('Recent uploads reach a healthy share of top-result views - newcomers can break in (+10).');
    } else if (freshRatio < 0.1) {
      opportunity -= 10;
      interpretation.push('Top results are long-held by evergreen videos - newcomer reach looks limited (-10).');
    }
  }

  opportunity = Math.round(clamp(opportunity, 0, 100));

  return {
    competitionScore,
    opportunity,
    factors: {
      competitionScore,
      topMedianViews: a.medianTopViews,
      exactMatchTitleRatio: a.exactMatchTitleRatio != null ? Math.round(a.exactMatchTitleRatio * 100) / 100 : null,
      freshness: a.medianAgeDays != null ? Math.round(clamp(100 - a.medianAgeDays, 0, 100)) : null,
      sampleSize: a.sampleSize,
    },
    interpretation,
  };
}

function format(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

// ---------------------------------------------------------------------------
// Intent classification (heuristic + optional AI refinement)
// ---------------------------------------------------------------------------

const INTENT_PATTERNS: { intent: SearchIntent; patterns: RegExp[] }[] = [
  { intent: 'informational', patterns: [/\b(how|why|what|when|guide|explain|fix|solve)\b/i, /\?$/] },
  { intent: 'commercial', patterns: [/\b(best|top|review|vs|versus|compare|cheap|price|worth it|alternative)\b/i] },
  { intent: 'educational', patterns: [/\b(tutorial|course|learn|beginner|crash course|step by step|explained)\b/i] },
  { intent: 'entertainment', patterns: [/\b(funny|prank|reaction|meme|fail|compilation|edit|asmr)\b/i] },
];

export function classifyIntent(keyword: string): { intent: SearchIntent; confidence: number } {
  for (const { intent, patterns } of INTENT_PATTERNS) {
    if (patterns.some((p) => p.test(keyword))) {
      return { intent, confidence: 0.7 };
    }
  }
  const tokens = keyword.trim().split(/\s+/).length;
  if (tokens === 1) return { intent: 'navigational', confidence: 0.4 };
  return { intent: 'informational', confidence: 0.4 };
}

// ---------------------------------------------------------------------------
// Clustering (token-overlap fallback; AI refines upstream when available)
// ---------------------------------------------------------------------------

export function clusterByTokens(keywords: string[]): KeywordCluster[] {
  const clusters = new Map<string, string[]>();
  for (const kw of keywords) {
    const tokens = kw.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const head = tokens[0] ?? kw;
    const arr = clusters.get(head) ?? [];
    arr.push(kw);
    clusters.set(head, arr);
  }
  return [...clusters.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 6)
    .map(([name, kws]) => ({ name, keywords: [] as KeywordCandidate[] })).map((c, i) => {
      void i;
      return c;
    });
}

export function sourcesInfo(autocompleteUsed: boolean, aiUsed: boolean): DataSourceInfo[] {
  const sources: DataSourceInfo[] = [
    {
      source: 'YouTube Data API v3 - search.list + videos.list + channels.list (official)',
      freshness: 'live query, cached 24h',
      confidence: 'high',
      notes: 'Competition signals: views/engagement of current top-ranking videos, exact-match titles, channel sizes.',
    },
  ];
  if (autocompleteUsed) {
    sources.push({
      source: 'YouTube public autocomplete (suggestqueries, unofficial-but-public endpoint)',
      freshness: 'live',
      confidence: 'medium',
      notes: 'Supplementary discovery signal only. The engine works without it.',
    });
  }
  if (aiUsed) {
    sources.push({
      source: 'AI-assisted keyword expansion (configured provider)',
      freshness: 'generated at query time',
      confidence: 'estimate',
      notes: 'Ideas for related phrasings; every AI keyword is verified against live competition data before scoring.',
    });
  }
  return sources;
}

export const VOLUME_DISCLOSURE =
  'YouTube does not provide official keyword search volumes to any tool. This platform deliberately does NOT display "search volume" numbers. Opportunity is a relative 0-100 estimate built from measurable public competition signals; the exact formula is documented in YOUTUBE_INTEGRATION.md.';
