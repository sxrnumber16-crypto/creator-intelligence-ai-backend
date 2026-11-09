import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import { requireAuth, requireActiveChannel } from '../lib/auth.js';
import { computeBestTime } from '../services/analytics/bestTime.js';
import { getFreshAccessToken } from '../services/sync/syncChannel.js';
import { quotaStatusFor } from '../services/youtube/quota.js';
import { requiredCredentialsConfigured, env } from '../config/env.js';
import type { AppNotification, NotificationSettings, WorkspaceItem, WorkspaceKind } from '@cia/shared';

export async function miscRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------ best time
  app.get('/api/channels/:id/best-time', { preHandler: [requireAuth, requireActiveChannel] }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const q = z
      .object({ format: z.enum(['all', 'shorts', 'long']).default('all'), range: z.coerce.number().refine((v) => [28, 90, 365].includes(v)).default(90), timezone: z.string().max(60).optional() })
      .parse(request.query ?? {});
    const channel = await prisma.channel.findFirst({ where: { id: params.id, userId: request.userId! } });
    if (!channel) throw errors.notFound('Channel not found');
    const prefs = await prisma.userPreferences.findUnique({ where: { userId: request.userId! } });
    const timezone = q.timezone ?? prefs?.timezone ?? 'UTC';
    const accessToken = await getFreshAccessToken(channel.id);
    return computeBestTime({
      channelDbId: channel.id,
      channelId: channel.ytChannelId,
      accessToken,
      timezone,
      format: q.format,
      rangeDays: q.range,
    });
  });

  // ------------------------------------------------------------ workspace
  app.get('/api/workspace', { preHandler: requireAuth }, async (request) => {
    const q = z
      .object({ kind: z.string().optional(), q: z.string().optional(), limit: z.coerce.number().min(1).max(100).default(50) })
      .parse(request.query ?? {});
    const items = await prisma.workspaceItem.findMany({
      where: {
        userId: request.userId!,
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.q ? { title: { contains: q.q, mode: 'insensitive' as const } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
    return {
      items: items.map(
        (i): WorkspaceItem => ({
          id: i.id,
          kind: i.kind as WorkspaceKind,
          title: i.title,
          payload: i.payload,
          createdAt: i.createdAt.toISOString(),
        }),
      ),
    };
  });

  app.post('/api/workspace', { preHandler: requireAuth }, async (request) => {
    const body = z.object({ kind: z.string().min(2).max(40), title: z.string().min(1).max(200), payload: z.unknown() }).parse(request.body ?? {});
    const item = await prisma.workspaceItem.create({
      data: { userId: request.userId!, kind: body.kind, title: body.title, payload: (body.payload as object) ?? {} },
    });
    return { id: item.id, ok: true };
  });

  app.delete('/api/workspace/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await prisma.workspaceItem.deleteMany({ where: { id, userId: request.userId! } });
    return { ok: true };
  });

  // ------------------------------------------------------------ notifications
  app.get('/api/notifications', { preHandler: requireAuth }, async (request) => {
    const items = await prisma.notification.findMany({
      where: { userId: request.userId! },
      orderBy: { createdAt: 'desc' },
      take: 40,
    });
    const settings = await prisma.notificationSettings.upsert({
      where: { userId: request.userId! },
      create: { userId: request.userId! },
      update: {},
    });
    return {
      items: items.map(
        (n): AppNotification => ({
          id: n.id,
          type: n.type as AppNotification['type'],
          title: n.title,
          body: n.body,
          readAt: n.readAt?.toISOString() ?? null,
          createdAt: n.createdAt.toISOString(),
        }),
      ),
      unread: items.filter((n) => !n.readAt).length,
      settings: {
        performance: settings.performance,
        competitorUploads: settings.competitorUploads,
        growth: settings.growth,
        opportunities: settings.opportunities,
        syncFailures: settings.syncFailures,
      } satisfies NotificationSettings,
    };
  });

  app.post('/api/notifications/read', { preHandler: requireAuth }, async (request) => {
    const body = z.object({ ids: z.array(z.string()).optional() }).parse(request.body ?? {});
    await prisma.notification.updateMany({
      where: { userId: request.userId!, ...(body.ids ? { id: { in: body.ids } } : {}) },
      data: { readAt: new Date() },
    });
    return { ok: true };
  });

  app.patch('/api/notifications/settings', { preHandler: requireAuth }, async (request) => {
    const body = z
      .object({
        performance: z.boolean().optional(),
        competitorUploads: z.boolean().optional(),
        competitorSignals: z.boolean().optional(),
        growth: z.boolean().optional(),
        opportunities: z.boolean().optional(),
        syncFailures: z.boolean().optional(),
      })
      .parse(request.body ?? {});
    await prisma.notificationSettings.upsert({
      where: { userId: request.userId! },
      create: { userId: request.userId!, ...body },
      update: body,
    });
    return { ok: true };
  });

  // ------------------------------------------------------------ preferences & data controls
  app.get('/api/preferences', { preHandler: requireAuth }, async (request) => {
    const prefs = await prisma.userPreferences.upsert({
      where: { userId: request.userId! },
      create: { userId: request.userId! },
      update: {},
    });
    return prefs;
  });

  app.patch('/api/preferences', { preHandler: requireAuth }, async (request) => {
    const body = z
      .object({ timezone: z.string().max(60).optional(), theme: z.enum(['dark', 'light']).optional(), brandName: z.string().max(60).optional(), overlaysEnabled: z.boolean().optional() })
      .parse(request.body ?? {});
    const prefs = await prisma.userPreferences.upsert({
      where: { userId: request.userId! },
      create: { userId: request.userId!, ...body },
      update: body,
    });
    return prefs;
  });

  // GDPR-style export of everything the platform stores for this user
  app.get('/api/account/export', { preHandler: requireAuth }, async (request) => {
    const userId = request.userId!;
    const [user, channels, competitors, keywords, audits, conversations, workspace] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { email: true, displayName: true, createdAt: true } }),
      prisma.channel.findMany({ where: { userId } }),
      prisma.competitor.findMany({ where: { userId }, include: { videos: true, snapshots: true } }),
      prisma.savedKeyword.findMany({ where: { userId } }),
      prisma.seoAudit.findMany({ where: { userId } }),
      prisma.aiConversation.findMany({ where: { userId }, include: { messages: true } }),
      prisma.workspaceItem.findMany({ where: { userId } }),
    ]);
    return { exportedAt: new Date().toISOString(), user, channels, competitors, keywords, audits, conversations, workspace };
  });

  app.delete('/api/account/data', { preHandler: requireAuth }, async (request) => {
    const body = z.object({ scope: z.enum(['keywords', 'audits', 'workspace', 'conversations', 'competitors', 'everything']) }).parse(request.body ?? {});
    const userId = request.userId!;
    switch (body.scope) {
      case 'keywords':
        await prisma.savedKeyword.deleteMany({ where: { userId } });
        await prisma.keywordList.deleteMany({ where: { userId } });
        await prisma.keywordQuery.deleteMany({ where: { userId } });
        break;
      case 'audits':
        await prisma.seoAudit.deleteMany({ where: { userId } });
        break;
      case 'workspace':
        await prisma.workspaceItem.deleteMany({ where: { userId } });
        break;
      case 'conversations':
        await prisma.aiConversation.deleteMany({ where: { userId } });
        break;
      case 'competitors':
        await prisma.competitor.deleteMany({ where: { userId } });
        break;
      case 'everything':
        await prisma.user.delete({ where: { id: userId } });
        break;
    }
    return { ok: true, scope: body.scope };
  });

  // ------------------------------------------------------------ public overlays (rate-limited, cached)
  // Powers the extension's on-page intelligence cards. Public Data API data only,
  // cached 30 minutes to protect quota. No private data is exposed here.
  app.get('/api/youtube/videos', async (request) => {
    const { ids } = z.object({ ids: z.string().min(5).max(1200) }).parse(request.query);
    const idList = [...new Set(ids.split(',').map((i) => i.trim()).filter((i) => /^[\w-]{11}$/.test(i)))].slice(0, 25);
    if (idList.length === 0) return { items: [] };
    const { listVideosByIds, parseIsoDuration } = await import('../services/youtube/dataApi.js');
    const { cachedWithFallback } = await import('../lib/cache.js');
    const items = await cachedWithFallback(`pub:videos:${idList.join(',')}`, 1800, async () => {
      const { items } = await listVideosByIds(idList, { kind: 'apiKey' });
      return items.map((v) => ({
        id: v.id,
        title: v.snippet.title,
        channelId: v.snippet.channelId,
        channelTitle: v.snippet.channelTitle,
        publishedAt: v.snippet.publishedAt,
        thumbnailUrl: v.snippet.thumbnails?.medium?.url,
        durationSeconds: parseIsoDuration(v.contentDetails?.duration ?? 'PT0S'),
        views: v.statistics?.viewCount != null ? Number(v.statistics.viewCount) : null,
        likes: v.statistics?.likeCount != null ? Number(v.statistics.likeCount) : null,
        comments: v.statistics?.commentCount != null ? Number(v.statistics.commentCount) : null,
      }));
    });
    return { items };
  });

  app.get('/api/youtube/channel', async (request) => {
    const q = z.object({ id: z.string().optional(), handle: z.string().optional() }).parse(request.query);
    if (!q.id && !q.handle) throw errors.badRequest('Provide id or handle');
    const { listChannelsByIds, listChannelsByHandles } = await import('../services/youtube/dataApi.js');
    const { cachedWithFallback } = await import('../lib/cache.js');
    const key = `pub:channel:${q.id ?? q.handle}`;
    const items = await cachedWithFallback(key, 1800, async () => {
      const { items } = q.id ? await listChannelsByIds([q.id], { kind: 'apiKey' }) : await listChannelsByHandles([q.handle!], { kind: 'apiKey' });
      return items.map((c) => ({
        id: c.id,
        title: c.snippet.title,
        thumbnailUrl: c.snippet.thumbnails?.medium?.url,
        subscribers: c.statistics?.subscriberCount != null ? Number(c.statistics.subscriberCount) : null,
        totalViews: c.statistics?.viewCount != null ? Number(c.statistics.viewCount) : null,
        videoCount: c.statistics?.videoCount != null ? Number(c.statistics.videoCount) : null,
      }));
    });
    return { items };
  });

  // ------------------------------------------------------------ system
  app.get('/api/health', async () => {
    let database = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      database = true;
    } catch {
      database = false;
    }
    let redis = false;
    try {
      const { getRedis } = await import('../lib/cache.js');
      redis = (await getRedis().ping()) === 'PONG';
    } catch {
      redis = false;
    }
    const creds = requiredCredentialsConfigured();
    return {
      ok: true,
      version: '1.0.0',
      uptimeSeconds: Math.round(process.uptime()),
      services: {
        database,
        redis,
        youtube: creds.youtubeApiKey || creds.googleOAuth,
        ai: creds.anthropic || creds.openai || creds.gemini,
      },
    };
  });

  app.get('/api/system/status', { preHandler: requireAuth }, async (request) => {
    const channel = await prisma.channel.findFirst({ where: { userId: request.userId!, isActive: true } });
    return {
      env: env.NODE_ENV,
      credentials: requiredCredentialsConfigured(),
      quota: channel ? await quotaStatusFor(channel.id) : null,
    };
  });
}
