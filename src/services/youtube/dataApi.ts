import { env } from '../../config/env.js';
import { errors } from '../../lib/errors.js';
import { chunk, fetchWithRetry } from '../../lib/http.js';

/**
 * YouTube Data API v3 client.
 * - Owner-channel calls use the user's OAuth access token.
 * - Public-data calls (competitors, video stats, search) use the server API key.
 * Quota accounting: every call reports its cost so the tracker can persist it.
 */

const API_BASE = 'https://www.googleapis.com/youtube/v3';

/** Quota cost per Google docs (data API). */
export const DATA_API_COSTS: Record<string, number> = {
  list: 1,
  search: 100,
  insert: 50,
  update: 50,
};

export async function youtubeGet<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  auth: { kind: 'oauth'; accessToken: string } | { kind: 'apiKey' },
): Promise<{ data: T; quotaCost: number }> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  if (auth.kind === 'apiKey') search.set('key', env.YOUTUBE_API_KEY);

  const headers: Record<string, string> = {};
  if (auth.kind === 'oauth') headers.Authorization = `Bearer ${auth.accessToken}`;

  const response = await fetchWithRetry(`${API_BASE}/${path}?${search.toString()}`, { headers });
  if (response.status === 403) {
    const body = await response.text();
    if (body.includes('quotaExceeded')) throw errors.quotaExceeded('YouTube Data API');
    if (body.includes('forbidden')) throw errors.forbidden('YouTube API request was rejected (403). Check API enablement and scopes.');
    throw errors.upstream('YouTube Data API', body.slice(0, 300));
  }
  if (response.status === 401) throw errors.unauthorized('Google access token rejected - reconnect the channel');
  if (!response.ok) {
    const body = await response.text();
    throw errors.upstream('YouTube Data API', `${path} failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return { data: (await response.json()) as T, quotaCost: DATA_API_COSTS[path] ?? 1 };
}

// ---------------------------------------------------------------------------
// Typed responses (subset we consume)
// ---------------------------------------------------------------------------

export interface YtThumbnail {
  url: string;
  width: number;
  height: number;
}

export interface YtChannelItem {
  id: string;
  snippet: {
    title: string;
    description: string;
    customUrl?: string;
    publishedAt: string;
    country?: string;
    thumbnails: { default?: YtThumbnail; medium?: YtThumbnail; high?: YtThumbnail };
  };
  statistics: { viewCount?: string; subscriberCount?: string; hiddenSubscriberCount?: boolean; videoCount?: string };
  contentDetails: { relatedPlaylists: { uploads: string } };
  brandingSettings?: { channel?: { country?: string } };
}

export interface YtVideoItem {
  id: string;
  snippet: {
    title: string;
    description: string;
    publishedAt: string;
    channelId: string;
    channelTitle: string;
    tags?: string[];
    thumbnails: { default?: YtThumbnail; medium?: YtThumbnail; high?: YtThumbnail; maxres?: YtThumbnail };
    categoryId?: string;
  };
  contentDetails: { duration: string };
  statistics: { viewCount?: string; likeCount?: string; favoriteCount?: string; commentCount?: string };
}

export interface YtSearchItem {
  id: { videoId?: string; channelId?: string; kind: string };
  snippet: { title: string; description: string; publishedAt: string; channelTitle: string; thumbnails: { medium?: YtThumbnail; high?: YtThumbnail } };
}

export interface YtSearchResponse {
  items: YtSearchItem[];
  pageInfo: { totalResults: number; resultsPerPage: number };
  nextPageToken?: string;
}

export interface YtListResponse<T> {
  kind: string;
  items: T[];
  pageInfo?: { totalResults: number; resultsPerPage: number };
  nextPageToken?: string;
}

// ---------------------------------------------------------------------------
// Endpoints used by the product
// ---------------------------------------------------------------------------

export async function listMyChannels(accessToken: string) {
  const { data, quotaCost } = await youtubeGet<YtListResponse<YtChannelItem>>(
    'channels',
    { part: 'snippet,statistics,contentDetails', mine: true, maxResults: 50 },
    { kind: 'oauth', accessToken },
  );
  return { items: data.items, quotaCost };
}

export async function listChannelsByIds(ids: string[], auth: { kind: 'oauth'; accessToken: string } | { kind: 'apiKey' }) {
  const results: YtChannelItem[] = [];
  let cost = 0;
  for (const batch of chunk(ids, 50)) {
    const { data, quotaCost } = await youtubeGet<YtListResponse<YtChannelItem>>(
      'channels',
      { part: 'snippet,statistics,contentDetails', id: batch.join(','), maxResults: 50 },
      auth,
    );
    results.push(...data.items);
    cost += quotaCost;
  }
  return { items: results, quotaCost: cost };
}

export async function listChannelsByHandles(handles: string[], auth: { kind: 'oauth'; accessToken: string } | { kind: 'apiKey' }) {
  const results: YtChannelItem[] = [];
  let cost = 0;
  for (const handle of handles) {
    const { data, quotaCost } = await youtubeGet<YtListResponse<YtChannelItem>>(
      'channels',
      { part: 'snippet,statistics,contentDetails', forHandle: handle.replace(/^@/, '') },
      auth,
    );
    results.push(...data.items);
    cost += quotaCost;
  }
  return { items: results, quotaCost: cost };
}

export async function searchChannels(query: string, auth: { kind: 'oauth'; accessToken: string } | { kind: 'apiKey' }) {
  const { data, quotaCost } = await youtubeGet<YtSearchResponse>(
    'search',
    { part: 'snippet', type: 'channel', q: query, maxResults: 10 },
    auth,
  );
  return { items: data.items, quotaCost };
}

export async function searchVideos(
  query: string,
  auth: { kind: 'oauth'; accessToken: string } | { kind: 'apiKey' },
  opts: { maxResults?: number; order?: 'relevance' | 'date' | 'viewCount'; publishedAfterDays?: number } = {},
) {
  const params: Record<string, string | number | undefined> = {
    part: 'snippet',
    type: 'video',
    q: query,
    maxResults: opts.maxResults ?? 10,
    order: opts.order ?? 'relevance',
  };
  if (opts.publishedAfterDays) {
    params.publishedAfter = new Date(Date.now() - opts.publishedAfterDays * 86400_000).toISOString();
  }
  const { data, quotaCost } = await youtubeGet<YtSearchResponse>('search', params, auth);
  return { items: data.items, totalResults: data.pageInfo?.totalResults ?? 0, quotaCost };
}

export async function listVideosByIds(ids: string[], auth: { kind: 'oauth'; accessToken: string } | { kind: 'apiKey' }) {
  const results: YtVideoItem[] = [];
  let cost = 0;
  for (const batch of chunk(ids, 50)) {
    const { data, quotaCost } = await youtubeGet<YtListResponse<YtVideoItem>>(
      'videos',
      { part: 'snippet,statistics,contentDetails', id: batch.join(','), maxResults: 50 },
      auth,
    );
    results.push(...data.items);
    cost += quotaCost;
  }
  return { items: results, quotaCost: cost };
}

export async function listPlaylistVideos(
  playlistId: string,
  auth: { kind: 'oauth'; accessToken: string } | { kind: 'apiKey' },
  opts: { limit?: number; pageToken?: string } = {},
) {
  const { data, quotaCost } = await youtubeGet<YtListResponse<{ id: string; snippet: { title: string; resourceId: { videoId: string }; publishedAt: string; thumbnails: { medium?: YtThumbnail; high?: YtThumbnail } } }>>(
    'playlistItems',
    { part: 'snippet', playlistId, maxResults: Math.min(opts.limit ?? 50, 50), pageToken: opts.pageToken },
    auth,
  );
  const ids = data.items.map((i) => i.snippet.resourceId.videoId).filter(Boolean);
  let videos: YtVideoItem[] = [];
  let statsCost = 0;
  if (ids.length > 0) {
    const stats = await listVideosByIds(ids, auth);
    videos = stats.items;
    statsCost = stats.quotaCost;
  }
  return { items: videos, nextPageToken: data.nextPageToken, quotaCost: quotaCost + statsCost };
}

export async function searchVideoIdsForChannel(
  ytChannelId: string,
  auth: { kind: 'oauth'; accessToken: string } | { kind: 'apiKey' },
  opts: { maxResults?: number; publishedAfterDays?: number; order?: string } = {},
) {
  const { data, quotaCost } = await youtubeGet<YtSearchResponse>(
    'search',
    {
      part: 'snippet',
      type: 'video',
      channelId: ytChannelId,
      maxResults: opts.maxResults ?? 25,
      order: opts.order ?? 'date',
      publishedAfter: opts.publishedAfterDays
        ? new Date(Date.now() - opts.publishedAfterDays * 86400_000).toISOString()
        : undefined,
    },
    auth,
  );
  return { ids: data.items.map((i) => i.id.videoId).filter((v): v is string => Boolean(v)), quotaCost };
}

export function parseIsoDuration(iso: string): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso);
  if (!m) return 0;
  return (Number(m[1] ?? 0) * 3600) + (Number(m[2] ?? 0) * 60) + Math.round(Number(m[3] ?? 0));
}
