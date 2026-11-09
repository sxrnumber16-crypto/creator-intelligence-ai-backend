import type { InsightsSummary } from '@cia/shared';
import { prisma } from '../../lib/prisma.js';
import { extractJson } from '../ai/types.js';
import { runCompletion } from '../ai/gateway.js';

/**
 * Dashboard insight generator. Tries an AI summary grounded in real data; when
 * no AI provider is configured, falls back to a deterministic rules-based
 * summary computed from the same data (clearly labeled source: "rules").
 * Both paths only reference numbers that exist in the database.
 */

export interface InsightContext {
  channelTitle: string;
  rangeDays: number;
  totals: {
    periodViews: number | null;
    subscribersGained: number | null;
    subscribersLost: number | null;
    averageViewDurationSeconds: number | null;
  };
  viewsChangePct: number | null;
  topVideos: { title: string; views: number | null; isShort: boolean }[];
  lowVideos: { title: string; views: number | null; isShort: boolean }[];
  dailyViews: { date: string; views: number | null }[];
  uploadsPerWeek: number | null;
  shortsSharePct: number | null;
  competitorTitles: string[];
}

export async function generateInsights(userId: string, ctx: InsightContext): Promise<InsightsSummary> {
  try {
    return await aiInsights(userId, ctx);
  } catch {
    return ruleInsights(ctx);
  }
}

function fmt(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function ruleInsights(ctx: InsightContext): InsightsSummary {
  const whatWorks: string[] = [];
  const declining: string[] = [];
  const best: string[] = [];
  const next: string[] = [];
  const watch: string[] = [];

  if (ctx.topVideos.length > 0) {
    const t = ctx.topVideos[0];
    best.push(`"${t.title}" leads the period with ${fmt(t.views)} views (${t.isShort ? 'Short' : 'long-form'}).`);
    const formats = ctx.topVideos.filter((v) => v.isShort).length;
    const shortsLead = formats > ctx.topVideos.length / 2;
    whatWorks.push(
      shortsLead
        ? `${formats}/${ctx.topVideos.length} of your top videos this period are Shorts - the format is carrying performance.`
        : 'Long-form dominates your top performers this period.',
    );
  }
  if (ctx.viewsChangePct != null) {
    if (ctx.viewsChangePct < -15) {
      declining.push(`Views are down ${Math.abs(Math.round(ctx.viewsChangePct))}% vs the previous period.`);
    } else if (ctx.viewsChangePct > 15) {
      whatWorks.push(`Views are up ${Math.round(ctx.viewsChangePct)}% vs the previous period.`);
    } else {
      whatWorks.push(`Views are roughly stable (${ctx.viewsChangePct >= 0 ? '+' : ''}${Math.round(ctx.viewsChangePct)}% vs previous period).`);
    }
  }
  if (ctx.uploadsPerWeek != null) {
    next.push(ctx.uploadsPerWeek < 1
      ? 'Upload cadence is under 1/week - consistent publishing is the single most controllable growth lever.'
      : `You publish ~${ctx.uploadsPerWeek}/week. Consider a second weekly slot echoing your best-performing topic.`);
  }
  if (ctx.lowVideos.length > 0 && ctx.topVideos.length > 0) {
    next.push(`Remake what works: "${ctx.topVideos[0].title}" outperformed "${ctx.lowVideos[0].title}" - build a follow-up around the winner's topic.`);
  }
  if (ctx.competitorTitles.length > 0) {
    next.push('Check Competitor Intelligence for topics rivals cover that you do not.');
  }
  watch.push(ctx.totals.averageViewDurationSeconds != null
    ? `Average view duration is ${Math.round(ctx.totals.averageViewDurationSeconds)}s - review retention curves on your latest uploads.`
    : 'Watch time metrics need YouTube Analytics authorization to appear here.');
  if (ctx.totals.subscribersLost != null && ctx.totals.subscribersLost > 0) {
    watch.push(`${ctx.totals.subscribersLost} subscribers were lost in this period - inspect which videos correlate with the drop.`);
  }

  return {
    source: 'rules',
    whatWorks: whatWorks.slice(0, 3),
    declining: declining.slice(0, 3),
    bestVideos: best.slice(0, 3),
    nextContent: next.slice(0, 3),
    watchMetrics: watch.slice(0, 3),
    generatedAt: new Date().toISOString(),
  };
}

async function aiInsights(userId: string, ctx: InsightContext): Promise<InsightsSummary> {
  const context = [
    `CHANNEL: ${ctx.channelTitle}`,
    `PERIOD: last ${ctx.rangeDays} days`,
    `TOTALS: views ${fmt(ctx.totals.periodViews)}, subs gained ${fmt(ctx.totals.subscribersGained)}, subs lost ${fmt(ctx.totals.subscribersLost)}, avg view duration ${ctx.totals.averageViewDurationSeconds != null ? `${Math.round(ctx.totals.averageViewDurationSeconds)}s` : 'n/a'}`,
    `VIEWS VS PREVIOUS PERIOD: ${ctx.viewsChangePct != null ? `${ctx.viewsChangePct >= 0 ? '+' : ''}${Math.round(ctx.viewsChangePct)}%` : 'n/a'}`,
    `UPLOAD CADENCE: ${ctx.uploadsPerWeek != null ? `${ctx.uploadsPerWeek}/week` : 'n/a'} | SHORTS SHARE: ${ctx.shortsSharePct != null ? `${ctx.shortsSharePct}%` : 'n/a'}`,
    'TOP VIDEOS:',
    ...ctx.topVideos.map((v) => `  - "${v.title}" ${fmt(v.views)} views (${v.isShort ? 'short' : 'long'})`),
    'WEAK VIDEOS:',
    ...ctx.lowVideos.map((v) => `  - "${v.title}" ${fmt(v.views)} views (${v.isShort ? 'short' : 'long'})`),
    'COMPETITOR RECENT TOPICS (public titles):',
    ...ctx.competitorTitles.slice(0, 12).map((t) => `  - ${t}`),
  ].join('\n');

  const result = await runCompletion(userId, 'analytics_interpretation', {
    system:
      'You are a YouTube growth analyst. Using ONLY the data provided, produce a grounded performance review. Return STRICT JSON: {"whatWorks":[string],"declining":[string],"bestVideos":[string],"nextContent":[string],"watchMetrics":[string]}. Each array: 1-3 short concrete bullets referencing actual numbers/titles from the data. Never invent data. No commentary outside JSON.',
    messages: [{ role: 'user', content: context }],
    json: true,
    maxTokens: 900,
  });

  const parsed = extractJson(result.text) as Partial<Record<keyof InsightsSummary, unknown>>;
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, 3) : []);

  return {
    source: 'ai',
    whatWorks: strArr(parsed.whatWorks),
    declining: strArr(parsed.declining),
    bestVideos: strArr(parsed.bestVideos),
    nextContent: strArr(parsed.nextContent),
    watchMetrics: strArr(parsed.watchMetrics),
    generatedAt: new Date().toISOString(),
    model: result.model,
  };
}

/** Collect insight context from DB for a channel + range. */
export async function buildInsightContext(
  channelDbId: string,
  channelTitle: string,
  rangeDays: number,
  viewsChangePct: number | null,
  totals: InsightContext['totals'],
): Promise<InsightContext> {
  const videos = await prisma.video.findMany({
    where: { channelId: channelDbId, publishedAt: { gte: new Date(Date.now() - rangeDays * 86400_000) } },
    orderBy: { viewCount: 'desc' },
    take: 12,
  });
  const ranked = videos
    .filter((v) => v.viewCount != null)
    .sort((a, b) => Number(b.viewCount) - Number(a.viewCount));
  const competitorTitles = (
    await prisma.competitorVideo.findMany({
      where: { competitor: { userId: await prisma.channel.findUniqueOrThrow({ where: { id: channelDbId } }).then((c) => c.userId) } },
      orderBy: { publishedAt: 'desc' },
      take: 15,
      select: { title: true },
    })
  ).map((v) => v.title);

  const shorts = videos.filter((v) => v.isShort).length;
  const spanWeeks = Math.max(rangeDays / 7, 1);

  return {
    channelTitle,
    rangeDays,
    totals,
    viewsChangePct,
    topVideos: ranked.slice(0, 5).map((v) => ({ title: v.title, views: v.viewCount != null ? Number(v.viewCount) : null, isShort: v.isShort })),
    lowVideos: ranked.slice(-3).reverse().map((v) => ({ title: v.title, views: v.viewCount != null ? Number(v.viewCount) : null, isShort: v.isShort })),
    dailyViews: [],
    uploadsPerWeek: Math.round((videos.length / spanWeeks) * 10) / 10,
    shortsSharePct: videos.length > 0 ? Math.round((shorts / videos.length) * 100) : null,
    competitorTitles,
  };
}
