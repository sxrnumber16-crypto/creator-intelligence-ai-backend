import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import { requireAuth, requireActiveChannel } from '../lib/auth.js';
import { addCompetitor, buildComparison, computeContentGaps, findChannels, snapshotCompetitor, competitorToTracked } from '../services/competitors/tracker.js';
import { env } from '../config/env.js';
import { toRanking } from '../services/seo/audit.js';
import { extractTopics } from '../services/competitors/tracker.js';
import { median } from '../lib/http.js';
import type { ChannelComparisonRow, CompetitorDetail } from '@cia/shared';

export async function competitorRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/competitors', { preHandler: requireAuth }, async (request) => {
    const competitors = await prisma.competitor.findMany({
      where: { userId: request.userId! },
      include: {
        snapshots: { orderBy: { capturedAt: 'desc' }, take: 60 },
        videos: { orderBy: { publishedAt: 'desc' }, take: 30 },
      },
      orderBy: { createdAt: 'asc' },
    });

    return {
      items: competitors.map((c) => {
        const tracked = competitorToTracked(c, c.snapshots);
        const latest = c.snapshots[0];
        const views = c.videos.map((v) => (v.viewCount != null ? Number(v.viewCount) : 0)).filter((v) => v > 0);
        const durations = c.videos.filter((v) => v.durationSeconds > 0).map((v) => v.durationSeconds);
        const spanDays =
          c.videos.length >= 2 ? (Date.now() - c.videos[c.videos.length - 1].publishedAt.getTime()) / 86400_000 : null;
        return {
          ...tracked,
          stats: {
            subscribers: latest?.subscribers ?? null,
            totalViews: latest?.totalViews != null ? Number(latest.totalViews) : null,
            videoCount: latest?.videoCount ?? null,
          },
          derived: {
            uploadsPerWeek: spanDays && spanDays > 0 ? Math.round((c.videos.length / spanDays) * 7 * 10) / 10 : null,
            medianRecentViews: median(views),
            medianDurationSeconds: median(durations),
            shortsSharePct: c.videos.length > 0 ? Math.round((c.videos.filter((v) => v.isShort).length / c.videos.length) * 100) : null,
            firstTrackedAt: tracked.derived.firstTrackedAt,
          },
          lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
        };
      }),
    };
  });

  app.post('/api/competitors/search', { preHandler: requireAuth }, async (request) => {
    const { query } = z.object({ query: z.string().min(2).max(80) }).parse(request.body ?? {});
    return { results: await findChannels(query, env.YOUTUBE_API_KEY) };
  });

  app.post('/api/competitors', { preHandler: requireAuth }, async (request) => {
    const body = z.object({ input: z.string().min(3).max(300), groupId: z.string().optional() }).parse(request.body ?? {});
    const competitor = await addCompetitor(request.userId!, body.input, body.groupId ?? null, env.YOUTUBE_API_KEY);
    return competitor;
  });

  app.post('/api/competitors/:id/sync', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const competitor = await prisma.competitor.findFirst({ where: { id, userId: request.userId! } });
    if (!competitor) throw errors.notFound('Competitor not found');
    await snapshotCompetitor(id, env.YOUTUBE_API_KEY);
    return { ok: true };
  });

  app.delete('/api/competitors/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await prisma.competitor.deleteMany({ where: { id, userId: request.userId! } });
    return { ok: true };
  });

  app.get('/api/competitors/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const competitor = await prisma.competitor.findFirst({
      where: { id, userId: request.userId! },
      include: {
        snapshots: { orderBy: { capturedAt: 'asc' } },
        videos: { orderBy: { publishedAt: 'desc' }, take: 40 },
      },
    });
    if (!competitor) throw errors.notFound('Competitor not found');

    const ranked = competitor.videos
      .map((v) => toRanking({ ...v, channelId: v.competitorId }))
      .sort((a, b) => b.viewsPerDay - a.viewsPerDay);
    const topics = extractTopics(competitor.videos.map((v) => v.title));
    const topTopics = [...topics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);

    const titlePatterns: string[] = [];
    const numberTitles = competitor.videos.filter((v) => /\d/.test(v.title)).length;
    if (competitor.videos.length > 0 && numberTitles / competitor.videos.length > 0.5) {
      titlePatterns.push(`${Math.round((numberTitles / competitor.videos.length) * 100)}% of recent titles contain numbers/lists`);
    }
    const questionTitles = competitor.videos.filter((v) => v.title.includes('?')).length;
    if (competitor.videos.length > 0 && questionTitles / competitor.videos.length > 0.3) {
      titlePatterns.push(`${Math.round((questionTitles / competitor.videos.length) * 100)}% of recent titles are questions`);
    }
    const bracketTitles = competitor.videos.filter((v) => /[[\]()|]/.test(v.title)).length;
    if (competitor.videos.length > 0 && bracketTitles / competitor.videos.length > 0.4) {
      titlePatterns.push('Frequent use of brackets/segment labels in titles');
    }

    const durations = competitor.videos.filter((v) => v.durationSeconds > 0).map((v) => v.durationSeconds);
    const formatPatterns: string[] = [];
    const shortsShare = competitor.videos.length > 0 ? competitor.videos.filter((v) => v.isShort).length / competitor.videos.length : 0;
    if (shortsShare > 0.6) formatPatterns.push('Primarily a Shorts channel');
    else if (shortsShare < 0.15) formatPatterns.push('Primarily long-form');
    else formatPatterns.push(`Mixed format: ${Math.round(shortsShare * 100)}% Shorts`);
    const medDur = median(durations);
    if (medDur != null) formatPatterns.push(`Median video length: ${Math.round(medDur / 60)} minutes`);

    const detail: CompetitorDetail = {
      ...competitorToTracked(competitor, competitor.snapshots),
      recentVideos: competitor.videos.slice(0, 12).map((v) => toRanking({ ...v, channelId: v.competitorId })),
      snapshotHistory: competitor.snapshots.map((s) => ({
        capturedAt: s.capturedAt.toISOString(),
        subscribers: s.subscribers,
        totalViews: s.totalViews != null ? Number(s.totalViews) : null,
        videoCount: s.videoCount,
      })),
      topVideos: ranked.slice(0, 8),
      titlePatterns,
      formatPatterns,
    };
    return detail;
  });

  app.post('/api/competitors/compare', { preHandler: requireAuth }, async (request) => {
    const body = z.object({ competitorIds: z.array(z.string()).max(6).default([]) }).parse(request.body ?? {});
    const channel = await prisma.channel.findFirst({ where: { userId: request.userId!, isActive: true } });
    if (!channel) throw errors.notFound('No active channel - connect your own channel first to compare');
    const rows: ChannelComparisonRow[] = await buildComparison(request.userId!, channel.ytChannelId, body.competitorIds, env.YOUTUBE_API_KEY);
    return { rows, note: 'Comparison uses public statistics. Your own subscriber/total-views numbers come from your connected channel snapshot.' };
  });

  app.post('/api/competitors/gap', { preHandler: [requireAuth, requireActiveChannel] }, async (request) => {
    const body = z.object({ competitorIds: z.array(z.string()).min(1).max(6) }).parse(request.body ?? {});
    const channel = await prisma.channel.findFirst({ where: { userId: request.userId!, isActive: true } });
    if (!channel) throw errors.notFound('No active channel');
    const ownerVideos = await prisma.video.findMany({
      where: { channelId: channel.id },
      orderBy: { publishedAt: 'desc' },
      take: 60,
      select: { title: true },
    });
    const gaps = await computeContentGaps(request.userId!, ownerVideos.map((v) => v.title), body.competitorIds);
    return {
      gaps,
      note: 'Gaps are derived from public titles/views of tracked competitors over their recent uploads. Topic overlap is measured on title tokens - it is a starting point, not a definitive topic model.',
    };
  });

  app.post('/api/competitors/groups', { preHandler: requireAuth }, async (request) => {
    const { name } = z.object({ name: z.string().min(1).max(60) }).parse(request.body ?? {});
    // Groups are simple labels stored on competitors (no separate table needed)
    return { ok: true, name };
  });

  void errors;
}
