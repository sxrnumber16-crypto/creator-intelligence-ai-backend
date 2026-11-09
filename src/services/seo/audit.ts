import type { SeoAuditReport, VideoRanking } from '@cia/shared';
import { computeSeoScore, type SeoScoreInput } from './scorer.js';
import { listVideosByIds, listChannelsByIds, listPlaylistVideos, parseIsoDuration, type YtVideoItem } from '../youtube/dataApi.js';
import { errors } from '../../lib/errors.js';

/**
 * Full video SEO audit: metadata scoring + public engagement benchmarks.
 * Things we cannot legitimately access (thumbnail content analysis without a
 * vision model, hidden competitor tags, private analytics for non-owned videos)
 * are listed in notAnalyzed rather than guessed.
 */

export function extractVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    if (url.hostname.includes('youtu.be')) return url.pathname.slice(1, 12) || null;
    const v = url.searchParams.get('v');
    if (v) return v;
    const shortMatch = /(shorts|embed|live)\/([\w-]{11})/.exec(url.pathname);
    if (shortMatch) return shortMatch[2];
  } catch {
    /* not a URL */
  }
  return null;
}

export function ytVideoToSummary(item: YtVideoItem) {
  const durationSeconds = parseIsoDuration(item.contentDetails?.duration ?? 'PT0S');
  return {
    id: item.id,
    ytVideoId: item.id,
    channelId: item.snippet.channelId,
    title: item.snippet.title,
    description: item.snippet.description ?? '',
    thumbnailUrl: item.snippet.thumbnails?.maxres?.url ?? item.snippet.thumbnails?.high?.url ?? item.snippet.thumbnails?.medium?.url,
    publishedAt: item.snippet.publishedAt,
    durationSeconds,
    isShort: durationSeconds > 0 && durationSeconds <= 62,
    tags: item.snippet.tags ?? [],
    stats: {
      views: item.statistics?.viewCount != null ? Number(item.statistics.viewCount) : null,
      likes: item.statistics?.likeCount != null ? Number(item.statistics.likeCount) : null,
      comments: item.statistics?.commentCount != null ? Number(item.statistics.commentCount) : null,
    },
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function levelRank(level: string): number {
  return level === 'critical' ? 2 : level === 'warning' ? 1 : 0;
}

async function recentChannelVideoIds(channelId: string): Promise<string[]> {
  const { items } = await listChannelsByIds([channelId], { kind: 'apiKey' });
  if (items.length === 0) return [];
  const uploads = items[0].contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return [];
  const { items: videos } = await listPlaylistVideos(uploads, { kind: 'apiKey' }, { limit: 15 });
  return videos.map((v) => v.id);
}

export async function buildAudit(options: {
  videoInput: string;
  keyword?: string;
}): Promise<SeoAuditReport> {
  const videoId = extractVideoId(options.videoInput);
  if (!videoId) throw errors.badRequest('Could not parse a YouTube video ID from the input');

  const { items } = await listVideosByIds([videoId], { kind: 'apiKey' });
  if (items.length === 0) throw errors.notFound(`Video ${videoId} not found or not public`);
  const item = items[0];
  const summary = ytVideoToSummary(item);

  // Benchmark: median views of this channel's recent videos (public data)
  const notAnalyzed: string[] = [];
  const benchmarkNote =
    'Benchmarks use PUBLIC statistics of this channel\u2019s recent videos via the YouTube Data API. They are not private analytics.';
  let channelMedianViews: number | null = null;
  try {
    const recentIds = await recentChannelVideoIds(item.snippet.channelId);
    if (recentIds.length > 0) {
      const recent = await listVideosByIds(recentIds, { kind: 'apiKey' });
      const views = recent.items
        .map((v) => (v.statistics?.viewCount != null ? Number(v.statistics.viewCount) : null))
        .filter((v): v is number => v !== null);
      channelMedianViews = median(views);
    }
  } catch {
    notAnalyzed.push('Channel benchmark could not be computed (Data API limit reached or channel has no other public videos).');
  }

  const seoInput: SeoScoreInput = {
    title: summary.title,
    description: summary.description,
    tags: summary.tags,
    keyword: options.keyword,
    isShort: summary.isShort,
  };
  const score = computeSeoScore(seoInput);

  const views = summary.stats.views;
  const likeRate = views && summary.stats.likes != null ? (summary.stats.likes / views) * 100 : null;
  const commentRate = views && summary.stats.comments != null ? (summary.stats.comments / views) * 100 : null;

  const recommendations = [...score.components]
    .flatMap((c) => c.findings)
    .filter((f) => f.level === 'critical' || f.level === 'warning')
    .sort((a, b) => levelRank(b.level) - levelRank(a.level))
    .slice(0, 8);

  if (!options.keyword) {
    notAnalyzed.push('No target keyword provided - keyword placement components used neutral scoring.');
  }
  notAnalyzed.push('Thumbnail image content was not analyzed (no vision model configured). CTR data requires YouTube Studio access for owned videos.');
  if (item.snippet.tags == null || item.snippet.tags.length === 0) {
    notAnalyzed.push('Tags were not returned by the API. For videos you do not own, tags may be hidden - we never guess hidden metadata.');
  }

  return {
    video: summary,
    channelTitle: item.snippet.channelTitle,
    score,
    engagement: {
      views,
      likes: summary.stats.likes,
      comments: summary.stats.comments,
      likeRate: likeRate != null ? Math.round(likeRate * 100) / 100 : null,
      commentRate: commentRate != null ? Math.round(commentRate * 100) / 100 : null,
      benchmarkNote: `${benchmarkNote}${channelMedianViews != null ? ` This video vs channel median recent views: ${formatCompact(views ?? 0)} vs ${formatCompact(channelMedianViews)}.` : ''}`,
    },
    notAnalyzed,
    recommendations,
    generatedAt: new Date().toISOString(),
  };
}

export function toRanking(v: {
  ytVideoId: string;
  title: string;
  description: string;
  thumbnailUrl: string | null;
  publishedAt: Date;
  durationSeconds: number;
  isShort: boolean;
  tags: string[];
  viewCount: bigint | null;
  likeCount: number | null;
  commentCount: number | null;
  channelId: string;
}): VideoRanking {
  const views = v.viewCount != null ? Number(v.viewCount) : null;
  const ageDays = Math.max(1, (Date.now() - v.publishedAt.getTime()) / 86400_000);
  return {
    id: v.ytVideoId,
    ytVideoId: v.ytVideoId,
    channelId: v.channelId,
    title: v.title,
    description: v.description,
    thumbnailUrl: v.thumbnailUrl ?? undefined,
    publishedAt: v.publishedAt.toISOString(),
    durationSeconds: v.durationSeconds,
    isShort: v.isShort,
    tags: v.tags,
    stats: { views, likes: v.likeCount, comments: v.commentCount },
    viewsPerDay: views != null ? Math.round(views / ageDays) : 0,
    engagementRate:
      views && v.likeCount != null ? Math.round(((v.likeCount + (v.commentCount ?? 0)) / views) * 10000) / 100 : null,
  };
}
