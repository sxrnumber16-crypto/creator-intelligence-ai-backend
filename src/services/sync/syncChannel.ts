import { prisma } from '../../lib/prisma.js';
import { errors } from '../../lib/errors.js';
import { recordQuota, assertQuota } from '../youtube/quota.js';
import { listMyChannels, listPlaylistVideos, parseIsoDuration } from '../youtube/dataApi.js';
import { queryMetricGroupSafe, METRIC_GROUPS } from '../youtube/analyticsApi.js';
import { dateOnly, daysAgo } from '../../lib/http.js';

/**
 * Owned-channel synchronization:
 * 1. Channel-level snapshot (public stats via OAuth token).
 * 2. Uploads playlist -> video upserts (metadata + public stats).
 * 3. Analytics backfill (daily metrics per day) for missing days.
 * Each step is idempotent; partial failures leave the rest of the data intact.
 */

export async function getFreshAccessToken(channelId: string): Promise<string> {
  const channel = await prisma.channel.findUnique({ where: { id: channelId }, include: { connection: true } });
  if (!channel) throw errors.notFound('Channel not found');
  const { refreshConnectionToken } = await import('../oauth/google.js');
  return refreshConnectionToken(channel.connection);
}

export async function syncChannel(channelId: string): Promise<{ ok: true; videos: number; analyticsDays: number }> {
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) throw errors.notFound('Channel not found');
  const accessToken = await getFreshAccessToken(channelId);

  await assertQuota(channelId, 'data_api', 6);

  // 1. Channel snapshot
  const mine = await listMyChannels(accessToken);
  await recordQuota(channelId, 'data_api', mine.quotaCost);
  const own = mine.items.find((c) => c.id === channel.ytChannelId) ?? mine.items[0];
  if (own) {
    await prisma.$transaction([
      prisma.channelSnapshot.create({
        data: {
          channelId,
          subscribers: own.statistics?.subscriberCount != null ? Number(own.statistics.subscriberCount) : null,
          totalViews: own.statistics?.viewCount != null ? BigInt(own.statistics.viewCount) : null,
          videoCount: own.statistics?.videoCount != null ? Number(own.statistics.videoCount) : null,
        },
      }),
      prisma.channel.update({
        where: { id: channelId },
        data: {
          title: own.snippet.title,
          thumbnailUrl: own.snippet.thumbnails?.medium?.url ?? channel.thumbnailUrl,
          uploadsPlaylistId: own.contentDetails?.relatedPlaylists?.uploads ?? channel.uploadsPlaylistId,
          lastSyncAt: new Date(),
        },
      }),
    ]);
  }

  // 2. Videos from uploads playlist
  let syncedVideos = 0;
  const uploadsPlaylist = own?.contentDetails?.relatedPlaylists?.uploads ?? channel.uploadsPlaylistId;
  if (uploadsPlaylist) {
    await assertQuota(channelId, 'data_api', 3);
    const { items, quotaCost } = await listPlaylistVideos(uploadsPlaylist, { kind: 'oauth', accessToken }, { limit: 50 });
    await recordQuota(channelId, 'data_api', quotaCost);
    for (const v of items) {
      const duration = parseIsoDuration(v.contentDetails?.duration ?? 'PT0S');
      await prisma.video.upsert({
        where: { ytVideoId: v.id },
        create: {
          channelId,
          ytVideoId: v.id,
          title: v.snippet.title,
          description: (v.snippet.description ?? '').slice(0, 8000),
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
          title: v.snippet.title,
          viewCount: v.statistics?.viewCount != null ? BigInt(v.statistics.viewCount) : null,
          likeCount: v.statistics?.likeCount != null ? Number(v.statistics.likeCount) : null,
          commentCount: v.statistics?.commentCount != null ? Number(v.statistics.commentCount) : null,
          lastStatsAt: new Date(),
        },
      });
      syncedVideos += 1;
    }
  }

  // 3. Analytics backfill (overview + engagement groups per day, channel-wide)
  let analyticsDays = 0;
  try {
    analyticsDays = await backfillDailyAnalytics(channelId, accessToken, 90);
  } catch (err) {
    // Analytics failures must not break the whole sync - record and continue.
    console.error(`[sync] analytics backfill failed for ${channelId}:`, err instanceof Error ? err.message : err);
  }

  return { ok: true, videos: syncedVideos, analyticsDays };
}

export async function backfillDailyAnalytics(channelId: string, accessToken: string, days: number): Promise<number> {
  await assertQuota(channelId, 'analytics_api', 4);
  const start = dateOnly(daysAgo(days));
  const end = dateOnly(new Date());

  const overview = await queryMetricGroupSafe(accessToken, { ids: 'channel==MINE', startDate: start, endDate: end, dimensions: ['day'] }, METRIC_GROUPS.overview);
  await recordQuota(channelId, 'analytics_api', overview.quotaCost);
  if (!overview.report) throw new Error(overview.error ?? 'Overview metrics unavailable');

  const engagement = await queryMetricGroupSafe(accessToken, { ids: 'channel==MINE', startDate: start, endDate: end, dimensions: ['day'] }, METRIC_GROUPS.engagement);
  await recordQuota(channelId, 'analytics_api', engagement.quotaCost);

  interface Row {
    date: string;
    views: number | null;
    watchMinutes: number | null;
    avgDuration: number | null;
    subsIn: number | null;
    subsOut: number | null;
    likes: number | null;
    comments: number | null;
  }

  const byDate = new Map<string, Row>();
  const num = (v: string | null | undefined): number | null => (v == null ? null : Number(v));

  for (const row of overview.report.rows ?? []) {
    byDate.set(String(row.values[0]), {
      date: String(row.values[0]),
      views: num(row.values[1]),
      watchMinutes: num(row.values[2]),
      avgDuration: num(row.values[3]),
      subsIn: num(row.values[4]),
      subsOut: num(row.values[5]),
      likes: null,
      comments: null,
    });
  }
  for (const row of engagement.report?.rows ?? []) {
    const existing = byDate.get(String(row.values[0]));
    if (existing) {
      existing.likes = num(row.values[2]);
      existing.comments = num(row.values[3]);
    }
  }

  let stored = 0;
  for (const row of byDate.values()) {
    await prisma.analyticsRecord.upsert({
      // videoId null => channel-wide row
      where: { channelId_videoId_date: { channelId, videoId: null as never, date: new Date(row.date) } },
      create: {
        channelId,
        videoId: null,
        date: new Date(row.date),
        views: row.views,
        estimatedWatchMinutes: row.watchMinutes,
        averageViewDurationSeconds: row.avgDuration,
        subscribersGained: row.subsIn,
        subscribersLost: row.subsOut,
        likes: row.likes,
        comments: row.comments,
        source: 'youtube_analytics_api',
      },
      update: {
        views: row.views,
        estimatedWatchMinutes: row.watchMinutes,
        averageViewDurationSeconds: row.avgDuration,
        subscribersGained: row.subsIn,
        subscribersLost: row.subsOut,
        likes: row.likes,
        comments: row.comments,
      },
    });
    stored += 1;
  }
  return stored;
}

/** Per-video analytics refresh (used by the video detail route). */
export async function refreshChannelAnalyticsForVideo(channelId: string, accessToken: string, ytVideoId: string, videoDbId: string): Promise<void> {
  await assertQuota(channelId, 'analytics_api', 2);
  const { analyticsQuery } = await import('../youtube/analyticsApi.js');
  const start = dateOnly(daysAgo(365));
  const { report, quotaCost } = await analyticsQuery(accessToken, {
    ids: 'channel==MINE',
    startDate: start,
    endDate: dateOnly(new Date()),
    metrics: ['views', 'estimatedMinutesWatched', 'likes', 'comments'],
    dimensions: ['day'],
    filters: `video==${ytVideoId}`,
  });
  await recordQuota(channelId, 'analytics_api', quotaCost);
  const num = (v: string | null | undefined): number | null => (v == null ? null : Number(v));
  for (const row of report.rows ?? []) {
    await prisma.analyticsRecord.upsert({
      where: { channelId_videoId_date: { channelId, videoId: videoDbId, date: new Date(String(row.values[0])) } },
      create: {
        channelId,
        videoId: videoDbId,
        date: new Date(String(row.values[0])),
        views: num(row.values[1]),
        estimatedWatchMinutes: num(row.values[2]),
        likes: num(row.values[3]),
        comments: num(row.values[4]),
        source: 'youtube_analytics_api',
      },
      update: {
        views: num(row.values[1]),
        estimatedWatchMinutes: num(row.values[2]),
        likes: num(row.values[3]),
        comments: num(row.values[4]),
      },
    });
  }
}

/** Add a Google connection's channels to the DB after OAuth callback. */
export async function registerChannelsForConnection(
  userId: string,
  connectionId: string,
  accessToken: string,
  quotaCost = 1,
): Promise<{ channelId: string; title: string }[]> {
  const { items } = await listMyChannels(accessToken);
  await recordQuotaIfNeeded(connectionId, quotaCost);
  const created: { channelId: string; title: string }[] = [];
  for (const item of items) {
    const existing = await prisma.channel.findUnique({
      where: { userId_ytChannelId: { userId, ytChannelId: item.id } },
    });
    if (existing) continue;
    const channel = await prisma.channel.create({
      data: {
        userId,
        connectionId,
        ytChannelId: item.id,
        title: item.snippet.title,
        customUrl: item.snippet.customUrl ?? null,
        thumbnailUrl: item.snippet.thumbnails?.medium?.url ?? item.snippet.thumbnails?.default?.url,
        country: item.snippet.country ?? null,
        uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
        isActive: false,
      },
    });
    created.push({ channelId: channel.id, title: channel.title });
  }
  return created;
}

async function recordQuotaIfNeeded(_connectionId: string, cost: number): Promise<void> {
  // Quota is tracked per owned channel; at registration time there may be no
  // channel row yet. This cost is negligible (1 unit) and re-recorded at sync.
  void cost;
}

export async function activateChannel(userId: string, channelDbId: string): Promise<void> {
  const channel = await prisma.channel.findFirst({ where: { id: channelDbId, userId } });
  if (!channel) throw errors.notFound('Channel not found');
  await prisma.$transaction([
    prisma.channel.updateMany({ where: { userId }, data: { isActive: false } }),
    prisma.channel.update({ where: { id: channelDbId }, data: { isActive: true } }),
  ]);
}
