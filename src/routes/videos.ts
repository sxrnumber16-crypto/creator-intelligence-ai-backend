import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import { requireAuth } from '../lib/auth.js';
import { toRanking } from '../services/seo/audit.js';
import { getFreshAccessToken } from '../services/sync/syncChannel.js';
import { queryRetention, queryTrafficSources } from '../services/youtube/analyticsApi.js';
import { refreshChannelAnalyticsForVideo } from '../services/sync/syncChannel.js';
import type { AnalyticsPoint, VideoAnalyticsDetail, VideoFormat, VideoRanking } from '@cia/shared';

export async function videoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/channels/:id/videos', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const q = z
      .object({
        format: z.enum(['all', 'shorts', 'long']).default('all'),
        sort: z.enum(['recent', 'views', 'viewsPerDay', 'engagement']).default('recent'),
        page: z.coerce.number().min(1).default(1),
        pageSize: z.coerce.number().min(5).max(50).default(20),
        q: z.string().optional(),
      })
      .parse(request.query ?? {});

    const channel = await prisma.channel.findFirst({ where: { id, userId: request.userId! } });
    if (!channel) throw errors.notFound('Channel not found');

    const where = {
      channelId: id,
      ...(q.format === 'shorts' ? { isShort: true } : q.format === 'long' ? { isShort: false } : {}),
      ...(q.q ? { title: { contains: q.q, mode: 'insensitive' as const } } : {}),
    };
    const [total, videos] = await Promise.all([
      prisma.video.count({ where }),
      prisma.video.findMany({
        where,
        orderBy: q.sort === 'recent' ? { publishedAt: 'desc' } : { viewCount: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);

    let rankings: VideoRanking[] = videos.map(toRanking);
    if (q.sort === 'viewsPerDay') rankings = rankings.sort((a, b) => b.viewsPerDay - a.viewsPerDay);
    if (q.sort === 'engagement') rankings = rankings.sort((a, b) => (b.engagementRate ?? 0) - (a.engagementRate ?? 0));

    return { items: rankings, page: q.page, pageSize: q.pageSize, total, hasMore: q.page * q.pageSize < total };
  });

  app.get('/api/channels/:id/videos/:videoId', { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string(), videoId: z.string() }).parse(request.params);
    const channel = await prisma.channel.findFirst({ where: { id: params.id, userId: request.userId! } });
    if (!channel) throw errors.notFound('Channel not found');

    const video = await prisma.video.findFirst({
      where: { channelId: channel.id, OR: [{ ytVideoId: params.videoId }, { id: params.videoId }] },
    });
    if (!video) throw errors.notFound('Video not found');

    const notes: string[] = [];
    const accessToken = await getFreshAccessToken(channel.id);
    await refreshChannelAnalyticsForVideo(channel.id, accessToken, video.ytVideoId, video.id).catch((err: unknown) => {
      notes.push(`Per-video analytics could not be refreshed: ${err instanceof Error ? err.message : 'unknown'}`);
    });

    const [retention, traffic, daily] = await Promise.all([
      queryRetention(accessToken, video.ytVideoId),
      queryTrafficSources(accessToken, video.publishedAt.toISOString().slice(0, 10), new Date().toISOString().slice(0, 10), video.ytVideoId),
      prisma.analyticsRecord.findMany({ where: { videoId: video.id }, orderBy: { date: 'asc' } }),
    ]);
    if (retention.error) notes.push(`Retention unavailable: ${retention.error}`);
    if (traffic.error) notes.push(`Traffic sources unavailable: ${traffic.error}`);

    const detail: VideoAnalyticsDetail = {
      video: {
        id: video.ytVideoId,
        ytVideoId: video.ytVideoId,
        channelId: video.channelId,
        title: video.title,
        description: video.description,
        thumbnailUrl: video.thumbnailUrl ?? undefined,
        publishedAt: video.publishedAt.toISOString(),
        durationSeconds: video.durationSeconds,
        isShort: video.isShort,
        tags: video.tags,
        stats: {
          views: video.viewCount != null ? Number(video.viewCount) : null,
          likes: video.likeCount,
          comments: video.commentCount,
        },
      },
      retention: retention.retention.map((r) => ({ elapsedSeconds: r.elapsedSeconds, audienceWatchRatio: r.audienceWatchRatio ?? 0 })),
      trafficSources: traffic.sources,
      dailyViews: daily.map<AnalyticsPoint>((r) => ({
        date: r.date.toISOString().slice(0, 10),
        views: r.views,
        watchMinutes: r.estimatedWatchMinutes,
        likes: r.likes,
        comments: r.comments,
      })),
      notes,
    };
    return detail;
  });

  // Cross-format / period comparison
  app.post('/api/channels/:id/compare', { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        videoIds: z.array(z.string()).min(2).max(6),
        metrics: z.array(z.enum(['views', 'watchMinutes', 'likes', 'comments', 'subsGained'])).default(['views', 'watchMinutes']),
      })
      .parse(request.body ?? {});

    const channel = await prisma.channel.findFirst({ where: { id: params.id, userId: request.userId! } });
    if (!channel) throw errors.notFound('Channel not found');

    const videos = await prisma.video.findMany({
      where: { channelId: channel.id, ytVideoId: { in: body.videoIds } },
    });
    const rows = [];
    for (const video of videos) {
      const records = await prisma.analyticsRecord.findMany({ where: { videoId: video.id } });
      const sum = (key: 'views' | 'estimatedWatchMinutes' | 'likes' | 'comments' | 'subscribersGained'): number | null => {
        const values = records.map((r) => (r as Record<string, unknown>)[key] as number | null).filter((v): v is number => v != null);
        return values.length > 0 ? values.reduce((a, b) => a + b, 0) : null;
      };
      rows.push({
        label: video.title,
        metrics: {
          views: sum('views'),
          watchMinutes: sum('estimatedWatchMinutes'),
          likes: sum('likes'),
          comments: sum('comments'),
          subsGained: sum('subscribersGained'),
          lifetimeViews: video.viewCount != null ? Number(video.viewCount) : null,
        },
      });
    }
    return { rows };
  });

  void videoRoutes;
}

export type { VideoFormat };
