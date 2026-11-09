import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import { requireAuth, requireActiveChannel } from '../lib/auth.js';
import { pctChange } from '../lib/http.js';
import { toRanking } from '../services/seo/audit.js';
import { syncChannel } from '../services/sync/syncChannel.js';
import { quotaStatusFor } from '../services/youtube/quota.js';
import { buildInsightContext, generateInsights } from '../services/analytics/summarizer.js';
import type { DataSourceInfo } from '@cia/shared';

const RANGE_SCHEMA = z.coerce.number().refine((v) => [7, 28, 90, 365].includes(v)).default(28);

export async function channelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/channels', { preHandler: requireAuth }, async (request) => {
    const channels = await prisma.channel.findMany({ where: { userId: request.userId! }, orderBy: { createdAt: 'asc' } });
    return {
      channels: channels.map((c) => ({
        id: c.id,
        connectionId: c.connectionId,
        channelId: c.ytChannelId,
        channelTitle: c.title,
        thumbnailUrl: c.thumbnailUrl ?? undefined,
        isActive: c.isActive,
        connectedAt: c.createdAt.toISOString(),
        scopes: [] as string[],
      })),
    };
  });

  app.post('/api/channels/:id/activate', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await prisma.$transaction([
      prisma.channel.updateMany({ where: { userId: request.userId! }, data: { isActive: false } }),
      prisma.channel.updateMany({ where: { id, userId: request.userId! }, data: { isActive: true } }),
    ]);
    return { ok: true };
  });

  app.post('/api/channels/:id/sync', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const channel = await prisma.channel.findFirst({ where: { id, userId: request.userId! } });
    if (!channel) throw errors.notFound('Channel not found');
    const result = await syncChannel(id);
    return result;
  });

  app.delete('/api/channels/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await prisma.channel.deleteMany({ where: { id, userId: request.userId! } });
    return { ok: true };
  });

  // ------------------------------------------------------------------ dashboard
  app.get('/api/channels/:id/dashboard', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const range = RANGE_SCHEMA.parse((request.query as Record<string, string>).range);
    const channel = await prisma.channel.findFirst({ where: { id, userId: request.userId! } });
    if (!channel) throw errors.notFound('Channel not found');

    const [latestSnap, previousSnap] = await Promise.all([
      prisma.channelSnapshot.findFirst({ where: { channelId: id }, orderBy: { capturedAt: 'desc' } }),
      prisma.channelSnapshot.findFirst({ where: { channelId: id }, orderBy: { capturedAt: 'asc' } }),
    ]);

    // Analytics rows: period vs previous period (channel-wide rows only)
    const periodStart = new Date(Date.now() - range * 86400_000);
    const prevStart = new Date(Date.now() - range * 2 * 86400_000);
    const [periodRows, prevRows] = await Promise.all([
      prisma.analyticsRecord.findMany({ where: { channelId: id, videoId: null, date: { gte: periodStart } }, orderBy: { date: 'asc' } }),
      prisma.analyticsRecord.findMany({ where: { channelId: id, videoId: null, date: { gte: prevStart, lt: periodStart } } }),
    ]);

    const sum = (rows: typeof periodRows, key: 'views' | 'estimatedWatchMinutes' | 'subscribersGained' | 'subscribersLost'): number | null => {
      const values = rows.map((r) => r[key]).filter((v): v is number => v != null);
      return values.length > 0 ? values.reduce((a, b) => a + b, 0) : null;
    };

    const periodViews = sum(periodRows, 'views');
    const prevViews = sum(prevRows, 'views');
    const timeseries = periodRows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      views: r.views,
      watchMinutes: r.estimatedWatchMinutes,
      subscribersGained: r.subscribersGained,
    }));

    // Videos in period
    const periodVideos = await prisma.video.findMany({
      where: { channelId: id, publishedAt: { gte: periodStart } },
      orderBy: { publishedAt: 'desc' },
    });
    const rankings = periodVideos.filter((v) => v.viewCount != null).map(toRanking).sort((a, b) => b.viewsPerDay - a.viewsPerDay);
    const ageDays = Math.max(range / 7, 1);
    const uploadsPerWeek = periodVideos.length > 0 ? Math.round((periodVideos.length / ageDays) * 10) / 10 : null;

    const insightCtx = await buildInsightContext(id, channel.title, range, viewsChange(), {
      periodViews,
      subscribersGained: sum(periodRows, 'subscribersGained'),
      subscribersLost: sum(periodRows, 'subscribersLost'),
      averageViewDurationSeconds: periodRows.find((r) => r.averageViewDurationSeconds != null)?.averageViewDurationSeconds ?? null,
    });
    const insights = await generateInsights(request.userId!, insightCtx);

    const sources: DataSourceInfo[] = [
      {
        source: 'YouTube Data API v3 (channel + video metadata, public stats)',
        freshness: channel.lastSyncAt ? `synced ${channel.lastSyncAt.toISOString().slice(0, 16)}Z` : 'not synced yet',
        confidence: 'high',
      },
      ...(periodRows.length > 0
        ? [{
            source: 'YouTube Analytics API v2 (private metrics, authorized)',
            freshness: `daily rows through ${timeseries[timeseries.length - 1]?.date ?? 'n/a'}`,
            confidence: 'high' as const,
          }]
        : [{
            source: 'YouTube Analytics API',
            freshness: 'no private analytics rows yet',
            confidence: 'low' as const,
            notes: 'Run "Sync channel" after connecting - private metrics require the yt-analytics.readonly scope.',
          }]),
    ];

    return {
      channel: {
        id: channel.id,
        ytChannelId: channel.ytChannelId,
        title: channel.title,
        thumbnailUrl: channel.thumbnailUrl ?? undefined,
        country: channel.country,
        customUrl: channel.customUrl,
        stats: {
          subscribers: latestSnap?.subscribers ?? null,
          totalViews: latestSnap?.totalViews != null ? Number(latestSnap.totalViews) : null,
          videoCount: latestSnap?.videoCount ?? null,
        },
        isOwner: true,
      },
      range,
      totals: {
        subscribers: latestSnap?.subscribers ?? null,
        totalViews: latestSnap?.totalViews != null ? Number(latestSnap.totalViews) : null,
        totalVideos: latestSnap?.videoCount ?? null,
        periodViews,
        periodWatchMinutes: sum(periodRows, 'estimatedWatchMinutes'),
        subscribersGained: sum(periodRows, 'subscribersGained'),
        subscribersLost: sum(periodRows, 'subscribersLost'),
        averageViewDurationSeconds: periodRows.find((r) => r.averageViewDurationSeconds != null)?.averageViewDurationSeconds ?? null,
      },
      deltas: {
        viewsChangePct: viewsChange(),
        subscribersChange:
          latestSnap?.subscribers != null && previousSnap?.subscribers != null && previousSnap.subscribers > 0
            ? latestSnap.subscribers - previousSnap.subscribers
            : null,
      },
      timeseries,
      topVideos: rankings.slice(0, 5),
      underperformingVideos: rankings.slice(-3).reverse(),
      recentUploads: periodVideos.slice(0, 8).map((v) => ({
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
        stats: { views: v.viewCount != null ? Number(v.viewCount) : null, likes: v.likeCount, comments: v.commentCount },
      })),
      insights,
      sources,
      quota: await quotaStatusFor(id),
    };

    function viewsChange(): number | null {
      if (periodViews == null || prevViews == null) return null;
      return pctChange(periodViews, prevViews);
    }
  });
}
