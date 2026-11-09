import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import { requireAuth, requireActiveChannel } from '../lib/auth.js';
import { cachedWithFallback } from '../lib/cache.js';
import { classifyIntent } from '../services/keywords/engine.js';
import {
  aiExpandKeywords,
  analyzeCompetition,
  autocompleteSuggestions,
  computeOpportunity,
  morphologicalVariants,
  sourcesInfo,
  VOLUME_DISCLOSURE,
  type CompetitionAnalysis,
} from '../services/keywords/engine.js';
import { env } from '../config/env.js';
import type { KeywordCandidate, KeywordCluster, KeywordExploreResponse } from '@cia/shared';

/** Verify one keyword's competition via official Data API (cache 24h). */
async function competitionForKeyword(apiKey: string, keyword: string): Promise<CompetitionAnalysis> {
  return cachedWithFallback(`kw:${keyword.toLowerCase()}`, 86_400, () => analyzeCompetition(keyword, apiKey));
}

export async function keywordRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/keywords/explore', { preHandler: [requireAuth, requireActiveChannel] }, async (request) => {
    const { seed } = z.object({ seed: z.string().min(2).max(80) }).parse(request.body ?? {});
    const userId = request.userId!;

    // Expand: autocomplete (best-effort) + morphological variants + AI (optional)
    const [autocomplete] = await Promise.all([autocompleteSuggestions(seed)]);
    const aiKeywords = await aiExpandKeywords(userId, seed);
    const variants = morphologicalVariants(seed);
    const candidates = [...new Set([seed, ...autocomplete, ...aiKeywords, ...variants])]
      .map((k) => k.trim())
      .filter((k) => k.length >= 3 && k.length <= 80)
      .slice(0, 18);

    // Score every candidate against live competition data
    const scored: KeywordCandidate[] = [];
    for (const keyword of candidates) {
      try {
        const analysis = await competitionForKeyword(env.YOUTUBE_API_KEY, keyword);
        const { opportunity, factors } = computeOpportunity(analysis);
        const intent = classifyIntent(keyword);
        scored.push({
          keyword,
          cluster: '',
          intent: intent.intent,
          intentConfidence: intent.confidence,
          opportunity,
          opportunityFactors: factors,
          sources: ['youtube_data_api'],
          checkedAt: new Date().toISOString(),
        });
      } catch {
        // Skip candidates whose verification failed - never show unverified scores
      }
    }

    // Cluster by first-significant-token overlap (deterministic, explainable)
    const clusters = new Map<string, KeywordCandidate[]>();
    for (const kw of scored) {
      const tokens = kw.keyword.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
      const head = tokens.slice(0, 2).join(' ') || kw.keyword;
      const arr = clusters.get(head) ?? [];
      arr.push({ ...kw, cluster: head });
      clusters.set(head, arr);
    }
    const clusterList: KeywordCluster[] = [...clusters.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 6)
      .map(([name, keywords]) => ({ name, keywords }));

    const response: KeywordExploreResponse = {
      seed,
      clusters: clusterList,
      methodology:
        'Every keyword is verified against the live top-10 search results via the YouTube Data API (views, exact-match titles, channel sizes, recency). Opportunity = 100 - competition pressure, where pressure is built from log-scaled median top-10 views (max 45), exact-match title share (max 20), median ranking-channel size (max 20) and recency of top results (max 15), adjusted +/-10 by how recent uploads perform relative to the top.',
      volumeDisclosure: VOLUME_DISCLOSURE,
      sources: sourcesInfo(autocomplete.length > 0, aiKeywords.length > 0),
    };

    await prisma.keywordQuery.create({
      data: { userId, seed, resultJson: response as object, sources: ['youtube_data_api', ...(autocomplete.length ? ['autocomplete'] : []), ...(aiKeywords.length ? ['ai'] : [])] },
    });

    return response;
  });

  app.post('/api/keywords/analyze', { preHandler: requireAuth }, async (request) => {
    const { keyword } = z.object({ keyword: z.string().min(2).max(80) }).parse(request.body ?? {});
    const analysis = await competitionForKeyword(env.YOUTUBE_API_KEY, keyword);
    const { opportunity, factors, interpretation } = computeOpportunity(analysis);
    const intent = classifyIntent(keyword);
    const { ytVideoToSummary } = await import('../services/seo/audit.js');

    return {
      keyword,
      intent: intent.intent,
      intentConfidence: intent.confidence,
      opportunity,
      factors,
      topCompetingVideos: analysis.topVideos.slice(0, 8).map(ytVideoToSummary),
      interpretation,
      volumeDisclosure: VOLUME_DISCLOSURE,
      sources: sourcesInfo(false, false),
    };
  });

  // Saved keywords
  app.get('/api/keywords/saved', { preHandler: requireAuth }, async (request) => {
    const items = await prisma.savedKeyword.findMany({ where: { userId: request.userId! }, orderBy: { createdAt: 'desc' } });
    return { items };
  });

  app.post('/api/keywords/saved', { preHandler: requireAuth }, async (request) => {
    const body = z
      .object({
        keyword: z.string().min(2).max(80),
        cluster: z.string().optional(),
        intent: z.string().optional(),
        opportunity: z.number().min(0).max(100).optional(),
        factorsJson: z.unknown().optional(),
        listId: z.string().optional(),
      })
      .parse(request.body ?? {});
    const saved = await prisma.savedKeyword.upsert({
      where: { userId_keyword: { userId: request.userId!, keyword: body.keyword } },
      create: {
        userId: request.userId!,
        keyword: body.keyword,
        cluster: body.cluster,
        intent: body.intent,
        opportunity: body.opportunity != null ? Math.round(body.opportunity) : null,
        factorsJson: (body.factorsJson as object) ?? undefined,
        listId: body.listId,
      },
      update: {
        opportunity: body.opportunity != null ? Math.round(body.opportunity) : undefined,
        listId: body.listId,
      },
    });
    return saved;
  });

  app.delete('/api/keywords/saved/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await prisma.savedKeyword.deleteMany({ where: { id, userId: request.userId! } });
    return { ok: true };
  });

  app.get('/api/keywords/lists', { preHandler: requireAuth }, async (request) => {
    const lists = await prisma.keywordList.findMany({
      where: { userId: request.userId! },
      include: { keywords: true },
      orderBy: { createdAt: 'desc' },
    });
    return { lists };
  });

  app.post('/api/keywords/lists', { preHandler: requireAuth }, async (request) => {
    const { name, note } = z.object({ name: z.string().min(1).max(60), note: z.string().max(500).optional() }).parse(request.body ?? {});
    return prisma.keywordList.create({ data: { userId: request.userId!, name, note } });
  });

  app.delete('/api/keywords/lists/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await prisma.keywordList.deleteMany({ where: { id, userId: request.userId! } });
    return { ok: true };
  });

  app.get('/api/keywords/history', { preHandler: requireAuth }, async (request) => {
    const queries = await prisma.keywordQuery.findMany({
      where: { userId: request.userId! },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, seed: true, createdAt: true, sources: true },
    });
    return { items: queries };
  });
}
