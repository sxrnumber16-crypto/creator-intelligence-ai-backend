import type { ChannelComparisonRow, ContentGapItem, TrackedCompetitor } from '@cia/shared';
import { prisma } from '../../lib/prisma.js';
import { errors } from '../../lib/errors.js';
import { listChannelsByIds, listPlaylistVideos, searchChannels, parseIsoDuration } from '../youtube/dataApi.js';

/**
 * Competitor intelligence - PUBLIC data only, via the official YouTube Data API.
 * Rules enforced here:
 * - Only public statistics (subs, views, video counts, public video stats).
 * - Historical comparison starts when tracking begins (first snapshot). We never
 *   fabricate history before that point.
 * - Competitor rows are never joined into private AnalyticsRecords.
 */

export function parseChannelInput(input: string): { channelId?: string; handle?: string } {
  const trimmed = input.trim();
  if (/^UC[\w-]{22}$/.test(trimmed)) return { channelId: trimmed };
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] === 'channel' && segments[1]) return { channelId: segments[1] };
    if (segments[0]?.startsWith('@')) return { handle: segments[0] };
    const u = url.searchParams.get('u');
    if (u) return { handle: u.startsWith('@') ? u : `@${u}` };
  } catch {
    /* plain text */
  }
  if (trimmed.startsWith('@')) return { handle: trimmed };
  return { handle: `@${trimmed}` };
}

export const extractChannelInput = parseChannelInput;

export async function findChannels(query: string, apiKey: string) {
  const { items } = await searchChannels(query, { kind: 'apiKey' });
  const ids = items.map((i) => i.id.channelId).filter((v): v is string => Boolean(v));
  if (ids.length === 0) return [];
  const { items: channels } = await listChannelsByIds(ids, { kind: 'apiKey' });
  return channels.map((c) => ({
    ytChannelId: c.id,
    title: c.snippet.title,
    thumbnailUrl: c.snippet.thumbnails?.medium?.url ?? c.snippet.thumbnails?.default?.url,
    subscribers: c.statistics?.subscriberCount != null ? Number(c.statistics.subscriberCount) : null,
    videoCount: c.statistics?.videoCount != null ? Number(c.statistics.videoCount) : null,
    description: c.snippet.description.slice(0, 200),
  }));
}

export async function addCompetitor(userId: string, input: string, groupId: string | null, apiKey: string): Promise<TrackedCompetitor> {
  const parsed = parseChannelInput(input);
  let channelId = parsed.channelId;
  let channelItem = null;

  if (channelId) {
    const { items } = await listChannelsByIds([channelId], { kind: 'apiKey' });
    channelItem = items[0] ?? null;
  } else if (parsed.handle) {
    const dataApi = await import('../youtube/dataApi.js');
    const { items } = await dataApi.listChannelsByHandles([parsed.handle], { kind: 'apiKey' });
    channelItem = items[0] ?? null;
    channelId = channelItem?.id;
  }
  if (!channelId || !channelItem) throw errors.notFound(`Channel not found for input: ${input}`);

  const existing = await prisma.competitor.findUnique({
    where: { userId_ytChannelId: { userId, ytChannelId: channelId } },
  });
  if (existing) throw errors.badRequest('This channel is already tracked');

  const competitor = await prisma.competitor.create({
    data: {
      userId,
      ytChannelId: channelId,
      title: channelItem.snippet.title,
      thumbnailUrl: channelItem.snippet.thumbnails?.medium?.url ?? channelItem.snippet.thumbnails?.default?.url,
      groupId,
    },
  });

  // First snapshot + initial video pull (history starts NOW, documented behavior)
  await snapshotCompetitor(competitor.id, apiKey);
  return competitorToTracked(
    competitor,
    await prisma.competitorSnapshot.findMany({ where: { competitorId: competitor.id } }),
  );
}

export async function snapshotCompetitor(competitorId: string, apiKey: string): Promise<void> {
  const competitor = await prisma.competitor.findUnique({ where: { id: competitorId } });
  if (!competitor) return;
  const { items } = await listChannelsByIds([competitor.ytChannelId], { kind: 'apiKey' });
  if (items.length === 0) return;
  const c = items[0];

  await prisma.$transaction([
    prisma.competitorSnapshot.create({
      data: {
        competitorId,
        subscribers: c.statistics?.subscriberCount != null ? Number(c.statistics.subscriberCount) : null,
        totalViews: c.statistics?.viewCount != null ? BigInt(c.statistics.viewCount) : null,
        videoCount: c.statistics?.videoCount != null ? Number(c.statistics.videoCount) : null,
      },
    }),
    prisma.competitor.update({ where: { id: competitorId }, data: { lastSyncAt: new Date() } }),
  ]);

  // Refresh recent videos (uploads playlist, no expensive search.list)
  const uploads = c.contentDetails?.relatedPlaylists?.uploads;
  if (uploads) {
    const { items: videos } = await listPlaylistVideos(uploads, { kind: 'apiKey' }, { limit: 25 });
    for (const v of videos) {
      const duration = parseIsoDuration(v.contentDetails?.duration ?? 'PT0S');
      await prisma.competitorVideo.upsert({
        where: { ytVideoId: v.id },
        create: {
          competitorId,
          ytVideoId: v.id,
          title: v.snippet.title,
          description: (v.snippet.description ?? '').slice(0, 4000),
          thumbnailUrl: v.snippet.thumbnails?.medium?.url ?? v.snippet.thumbnails?.high?.url,
          tags: v.snippet.tags ?? [],
          publishedAt: new Date(v.snippet.publishedAt),
          durationSeconds: duration,
          isShort: duration > 0 && duration <= 62,
          viewCount: v.statistics?.viewCount != null ? BigInt(v.statistics.viewCount) : null,
          likeCount: v.statistics?.likeCount != null ? Number(v.statistics.likeCount) : null,
          commentCount: v.statistics?.commentCount != null ? Number(v.statistics.commentCount) : null,
          lastStatsAt: new Date(),
        },
        update: {
          viewCount: v.statistics?.viewCount != null ? BigInt(v.statistics.viewCount) : null,
          likeCount: v.statistics?.likeCount != null ? Number(v.statistics.likeCount) : null,
          commentCount: v.statistics?.commentCount != null ? Number(v.statistics.commentCount) : null,
          lastStatsAt: new Date(),
        },
      });
    }
  }
}

export function competitorToTracked(
  competitor: { id: string; ytChannelId: string; title: string; thumbnailUrl: string | null; groupId: string | null; createdAt: Date },
  snapshots: { subscribers: number | null; totalViews: bigint | null; videoCount: number | null; capturedAt: Date }[],
): TrackedCompetitor {
  const latest = [...snapshots].sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())[0];
  const first = [...snapshots].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())[0];
  return {
    id: competitor.id,
    ytChannelId: competitor.ytChannelId,
    title: competitor.title,
    thumbnailUrl: competitor.thumbnailUrl ?? undefined,
    groupId: competitor.groupId,
    stats: {
      subscribers: latest?.subscribers ?? null,
      totalViews: latest?.totalViews != null ? Number(latest.totalViews) : null,
      videoCount: latest?.videoCount ?? null,
    },
    derived: {
      uploadsPerWeek: null,
      medianRecentViews: null,
      medianDurationSeconds: null,
      shortsSharePct: null,
      firstTrackedAt: (first?.capturedAt ?? competitor.createdAt).toISOString(),
    },
  };
}

/** Title-token based topic extraction for gap analysis. */
export function extractTopics(titles: string[]): Map<string, number> {
  const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'your', 'from', 'how', 'what', 'why', 'you', 'are', 'was', 'not', 'but', 'all', 'new', 'best', 'top', 'get', 'my', 'to', 'of', 'in', 'on', 'a', 'an', 'is', 'it', 'at', 'be', 'we', 'i']);
  const topics = new Map<string, number>();
  for (const title of titles) {
    const tokens = title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP.has(t));
    const seen = new Set<string>();
    for (const token of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      topics.set(token, (topics.get(token) ?? 0) + 1);
    }
  }
  return topics;
}

export async function computeContentGaps(
  userId: string,
  ownerTitles: string[],
  competitorIds: string[],
): Promise<ContentGapItem[]> {
  const ownerTopics = extractTopics(ownerTitles);
  const competitors = await prisma.competitor.findMany({
    where: { userId, id: { in: competitorIds } },
    include: { videos: { orderBy: { publishedAt: 'desc' }, take: 40 } },
  });

  const topicStats = new Map<string, { views: number; coverage: number; examples: ContentGapItem['exampleVideos'] }>();
  for (const competitor of competitors) {
    const compTopics = extractTopics(competitor.videos.map((v) => v.title));
    for (const video of competitor.videos) {
      const views = video.viewCount != null ? Number(video.viewCount) : 0;
      for (const token of extractTopics([video.title]).keys()) {
        const stat = topicStats.get(token) ?? { views: 0, coverage: 0, examples: [] };
        stat.views += views;
        if (!stat.examples.some((e) => e.videoId === video.ytVideoId) && stat.examples.length < 3) {
          stat.examples.push({ title: video.title, videoId: video.ytVideoId, channelTitle: competitor.title, views });
        }
        topicStats.set(token, stat);
      }
      void compTopics;
    }
    for (const token of compTopics.keys()) {
      const stat = topicStats.get(token);
      if (stat) topicStats.set(token, { ...stat, coverage: stat.coverage + 1 });
    }
  }

  const gaps: ContentGapItem[] = [];
  for (const [topic, stat] of topicStats) {
    if (stat.views < 20_000) continue; // noise filter
    const ownerCovers = ownerTopics.has(topic) && (ownerTopics.get(topic) ?? 0) >= 1;
    if (ownerCovers) continue;
    gaps.push({
      topic,
      competitorCoverage: stat.coverage,
      ownerCovers,
      signal: stat.views,
      exampleVideos: stat.examples,
    });
  }
  return gaps.sort((a, b) => b.signal - a.signal).slice(0, 15);
}

export async function buildComparison(userId: string, ownerChannelId: string, competitorIds: string[], apiKey: string): Promise<ChannelComparisonRow[]> {
  const rows: ChannelComparisonRow[] = [];
  const owner = await prisma.channel.findFirst({ where: { userId, ytChannelId: ownerChannelId } });
  const ownerSnap = owner
    ? await prisma.channelSnapshot.findFirst({ where: { channelId: owner.id }, orderBy: { capturedAt: 'desc' } })
    : null;
  rows.push({
    channelId: ownerChannelId,
    title: owner?.title ?? 'Your channel',
    isOwner: true,
    subscribers: ownerSnap?.subscribers ?? null,
    totalViews: ownerSnap?.totalViews != null ? Number(ownerSnap.totalViews) : null,
    uploadsPerWeek: await uploadsPerWeekForOwner(owner?.id ?? null),
    medianRecentViews: owner ? await medianRecentViewsForOwner(owner.id) : null,
    shortsSharePct: owner ? await shortsShareForOwner(owner.id) : null,
    periodViewsGained: null,
  });

  const competitors = await prisma.competitor.findMany({
    where: { userId, id: { in: competitorIds } },
    include: {
      snapshots: { orderBy: { capturedAt: 'asc' } },
      videos: { orderBy: { publishedAt: 'desc' }, take: 25 },
    },
  });

  for (const c of competitors) {
    const latest = c.snapshots[c.snapshots.length - 1];
    const first30 = c.snapshots.find((s) => s.capturedAt.getTime() >= Date.now() - 30 * 86400_000) ?? c.snapshots[0];
    const views = c.videos.map((v) => (v.viewCount != null ? Number(v.viewCount) : 0));
    const durations = c.videos.map((v) => v.durationSeconds).filter((d) => d > 0);
    const shorts = c.videos.filter((v) => v.isShort).length;
    const uploadsPerWeek =
      c.videos.length >= 2
        ? (c.videos.length / ((Date.now() - c.videos[c.videos.length - 1].publishedAt.getTime()) / (7 * 86400_000)))
        : null;
    rows.push({
      channelId: c.ytChannelId,
      title: c.title,
      isOwner: false,
      subscribers: latest?.subscribers ?? null,
      totalViews: latest?.totalViews != null ? Number(latest.totalViews) : null,
      uploadsPerWeek: uploadsPerWeek != null && Number.isFinite(uploadsPerWeek) ? Math.round(uploadsPerWeek * 10) / 10 : null,
      medianRecentViews: median(views),
      shortsSharePct: c.videos.length > 0 ? Math.round((shorts / c.videos.length) * 100) : null,
      periodViewsGained:
        first30 && latest && first30.totalViews != null && latest.totalViews != null
          ? Number(latest.totalViews) - Number(first30.totalViews)
          : null,
    });
  }
  void apiKey;
  return rows;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function uploadsPerWeekForOwner(channelDbId: string | null): Promise<number | null> {
  if (!channelDbId) return null;
  const videos = await prisma.video.findMany({
    where: { channelId: channelDbId },
    orderBy: { publishedAt: 'desc' },
    take: 30,
    select: { publishedAt: true },
  });
  if (videos.length < 2) return null;
  const spanWeeks = (Date.now() - videos[videos.length - 1].publishedAt.getTime()) / (7 * 86400_000);
  return spanWeeks > 0 ? Math.round((videos.length / spanWeeks) * 10) / 10 : null;
}

async function medianRecentViewsForOwner(channelDbId: string): Promise<number | null> {
  const videos = await prisma.video.findMany({
    where: { channelId: channelDbId },
    orderBy: { publishedAt: 'desc' },
    take: 20,
    select: { viewCount: true },
  });
  return median(videos.map((v) => (v.viewCount != null ? Number(v.viewCount) : 0)).filter((n) => n > 0));
}

async function shortsShareForOwner(channelDbId: string): Promise<number | null> {
  const videos = await prisma.video.findMany({
    where: { channelId: channelDbId },
    orderBy: { publishedAt: 'desc' },
    take: 25,
    select: { isShort: true },
  });
  if (videos.length === 0) return null;
  return Math.round((videos.filter((v) => v.isShort).length / videos.length) * 100);
}
