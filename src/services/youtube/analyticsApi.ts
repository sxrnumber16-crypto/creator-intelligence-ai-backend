import { errors } from '../../lib/errors.js';
import { fetchWithRetry } from '../../lib/http.js';

/**
 * YouTube Analytics API v2 client (authorized channels only).
 * Metric availability depends on the channel and metric - the API returns errors
 * for unsupported metrics; we request metrics in small groups and keep what works.
 * Every row stored in AnalyticsRecord keeps its source; nulls stay null.
 */

const API_BASE = 'https://youtubeanalytics.googleapis.com/v2/reports';

export interface AnalyticsRow {
  date: string; // YYYY-MM-DD (first dimension is always day here)
  values: (string | null)[];
}

export interface AnalyticsReport {
  columnHeaders: { name: string; columnType: string; dataType: string }[];
  rows: AnalyticsRow[] | undefined;
}

export const METRIC_GROUPS = {
  overview: ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained', 'subscribersLost'],
  engagement: ['views', 'likes', 'comments', 'shares'],
  reach: ['views', 'impressionCtr', 'cardClickRate'],
} as const;

export interface AnalyticsQueryParams {
  ids: string; // e.g. channel==UCxxx
  startDate: string;
  endDate: string;
  metrics: string[];
  dimensions?: string[];
  filters?: string;
  sort?: string;
  maxResults?: number;
}

export async function analyticsQuery(
  accessToken: string,
  params: AnalyticsQueryParams,
): Promise<{ report: AnalyticsReport; quotaCost: number }> {
  const search = new URLSearchParams({
    ids: params.ids,
    startDate: params.startDate,
    endDate: params.endDate,
    metrics: params.metrics.join(','),
  });
  if (params.dimensions?.length) search.set('dimensions', params.dimensions.join(','));
  if (params.filters) search.set('filters', params.filters);
  if (params.sort) search.set('sort', params.sort);
  if (params.maxResults) search.set('maxResults', String(Math.min(params.maxResults, 200)));

  const response = await fetchWithRetry(`${API_BASE}?${search.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 401) throw errors.unauthorized('Google access token rejected - reconnect the channel');
  if (response.status === 403) {
    const body = await response.text();
    if (body.includes('quotaExceeded')) throw errors.quotaExceeded('YouTube Analytics API');
    throw errors.forbidden(`Analytics API access denied. Verify the yt-analytics.readonly scope: ${body.slice(0, 200)}`);
  }
  if (!response.ok) {
    const body = await response.text();
    throw errors.upstream('YouTube Analytics API', `${response.status}: ${body.slice(0, 300)}`);
  }

  // Quota: Analytics API units are request-based (roughly 1 unit per query for standard reports)
  return { report: (await response.json()) as AnalyticsReport, quotaCost: 1 };
}

/** Query a metric group, tolerating per-group failures (metric not available). */
export async function queryMetricGroupSafe(
  accessToken: string,
  params: Omit<AnalyticsQueryParams, 'metrics'>,
  metrics: readonly string[],
): Promise<{ metrics: string[]; report: AnalyticsReport | null; error?: string; quotaCost: number }> {
  try {
    const { report, quotaCost } = await analyticsQuery(accessToken, { ...params, metrics: [...metrics] });
    return { metrics: [...metrics], report, quotaCost };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { metrics: [...metrics], report: null, error: message, quotaCost: 0 };
  }
}

/** Audience retention for one video: elapsedVideoTimeRatio + relativeRetentionPerformance / audienceWatchRatio. */
export async function queryRetention(accessToken: string, ytVideoId: string, maxAgeDays = 365) {
  const startDate = new Date(Date.now() - maxAgeDays * 86400_000).toISOString().slice(0, 10);
  try {
    const { report } = await analyticsQuery(accessToken, {
      ids: 'channel==MINE',
      startDate,
      endDate: new Date().toISOString().slice(0, 10),
      metrics: ['audienceWatchRatio'],
      dimensions: ['elapsedVideoTimeRatio'],
      filters: `video==${ytVideoId}`,
      maxResults: 100,
    });
    const rows = (report.rows ?? []).map((row) => ({
      elapsedSeconds: Math.round(Number(row.values[0]) * 100) / 100,
      audienceWatchRatio: row.values[1] === null ? null : Number(row.values[1]),
    }));
    return { retention: rows, error: undefined as string | undefined };
  } catch (err) {
    return { retention: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function queryTrafficSources(accessToken: string, startDate: string, endDate: string, ytVideoId?: string) {
  const params: AnalyticsQueryParams = {
    ids: 'channel==MINE',
    startDate,
    endDate,
    metrics: ['views'],
    dimensions: ['insightTrafficSourceType'],
    sort: '-views',
    maxResults: 25,
  };
  if (ytVideoId) params.filters = `video==${ytVideoId}`;
  try {
    const { report } = await analyticsQuery(accessToken, params);
    const rows = (report.rows ?? []).map((row) => ({ source: String(row.values[0]), views: Number(row.values[1]) }));
    return { sources: rows, error: undefined as string | undefined };
  } catch (err) {
    return { sources: [], error: err instanceof Error ? err.message : String(err) };
  }
}
