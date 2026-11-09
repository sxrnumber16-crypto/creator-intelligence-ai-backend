import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../lib/auth.js';
import { computeSeoScore } from '../services/seo/scorer.js';
import { buildAudit, extractVideoId, ytVideoToSummary } from '../services/seo/audit.js';
import { listVideosByIds } from '../services/youtube/dataApi.js';
import { runCompletion } from '../services/ai/gateway.js';
import { extractJson } from '../services/ai/types.js';
import { IDEAS_SYSTEM, METADATA_SYSTEM, SEO_SYSTEM } from '../services/ai/prompts.js';
import { errors } from '../lib/errors.js';
import type { AiIdea, SeoScoreResult } from '@cia/shared';

export async function seoRoutes(app: FastifyInstance): Promise<void> {
  // Instant rule-based scoring of pasted metadata (no API cost)
  app.post('/api/seo/score', { preHandler: requireAuth }, async (request) => {
    const body = z
      .object({
        title: z.string().max(200),
        description: z.string().max(10_000).default(''),
        tags: z.array(z.string().max(100)).max(60).default([]),
        keyword: z.string().max(80).optional(),
        isShort: z.boolean().optional(),
      })
      .parse(request.body ?? {});
    return computeSeoScore(body);
  });

  // Full audit of any public video by URL/ID
  app.post('/api/seo/audit', { preHandler: requireAuth }, async (request) => {
    const body = z
      .object({ videoUrl: z.string().min(5).max(300), keyword: z.string().max(80).optional(), save: z.boolean().default(true) })
      .parse(request.body ?? {});

    const report = await buildAudit({ videoInput: body.videoUrl, keyword: body.keyword });
    if (body.save) {
      await prisma.seoAudit.create({
        data: {
          userId: request.userId!,
          ytVideoId: report.video.ytVideoId,
          videoTitle: report.video.title,
          overall: report.score.overall,
          reportJson: report as unknown as object,
        },
      });
    }
    return report;
  });

  app.get('/api/seo/audits', { preHandler: requireAuth }, async (request) => {
    const audits = await prisma.seoAudit.findMany({
      where: { userId: request.userId! },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, ytVideoId: true, videoTitle: true, overall: true, createdAt: true },
    });
    return { items: audits };
  });

  app.get('/api/seo/audits/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const audit = await prisma.seoAudit.findFirst({ where: { id, userId: request.userId! } });
    if (!audit) throw errors.notFound('Audit not found');
    return audit.reportJson;
  });

  // Analyze one of MY connected-channel videos (pulls real metadata from Data API)
  app.post('/api/seo/audit-own', { preHandler: requireAuth }, async (request) => {
    const body = z.object({ videoId: z.string().min(5).max(64), keyword: z.string().max(80).optional() }).parse(request.body ?? {});
    const { items } = await listVideosByIds([body.videoId], { kind: 'apiKey' });
    if (items.length === 0) throw errors.notFound('Video not found');
    const summary = ytVideoToSummary(items[0]);
    const score: SeoScoreResult = computeSeoScore({
      title: summary.title,
      description: summary.description,
      tags: summary.tags,
      keyword: body.keyword,
      isShort: summary.isShort,
    });
    return { video: summary, score };
  });

  // AI title optimizer
  app.post('/api/seo/titles', { preHandler: requireAuth }, async (request) => {
    const body = z
      .object({
        topic: z.string().min(3).max(200),
        keyword: z.string().max(80).optional(),
        formats: z.array(z.enum(['seo', 'curiosity', 'clear', 'shorts'])).default(['seo', 'curiosity', 'clear']),
        context: z.string().max(1000).optional(),
      })
      .parse(request.body ?? {});

    const result = await runCompletion(request.userId!, 'seo_analysis', {
      system:
        'You are a YouTube title strategist. Generate 3 title variants for each requested style. Titles must be <= 70 characters, include the main keyword naturally where the style allows, and never make false promises. Return STRICT JSON: {"titles":[{"text":"...","style":"seo|curiosity|clear|shorts","why":"one line"}]}. No commentary outside JSON.',
      messages: [
        {
          role: 'user',
          content: `Topic: ${body.topic}\nMain keyword: ${body.keyword ?? body.topic}\nStyles: ${body.formats.join(', ')}${body.context ? `\nChannel context: ${body.context}` : ''}`,
        },
      ],
      json: true,
      maxTokens: 700,
    });
    const parsed = extractJson(result.text) as { titles?: unknown };
    const titles = Array.isArray(parsed.titles) ? parsed.titles : [];
    return {
      titles,
      model: result.model,
      note: 'Titles are suggestions. No tool can guarantee search ranking or CTR - test with YouTube\u2019s own A/B experiments.',
    };
  });

  // AI description optimizer
  app.post('/api/seo/description', { preHandler: requireAuth }, async (request) => {
    const body = z
      .object({ title: z.string().min(3).max(200), keyword: z.string().max(80).optional(), videoSummary: z.string().max(2000).optional() })
      .parse(request.body ?? {});

    const result = await runCompletion(request.userId!, 'content_generation', {
      system: METADATA_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Title: ${body.title}\nMain keyword: ${body.keyword ?? ''}\nVideo summary from creator: ${body.videoSummary ?? 'none provided'}`,
        },
      ],
      json: true,
      maxTokens: 1200,
    });
    return { raw: extractJson(result.text), model: result.model };
  });

  // AI tag suggestions
  app.post('/api/seo/tags', { preHandler: requireAuth }, async (request) => {
    const body = z.object({ title: z.string().min(3).max(200), keyword: z.string().max(80).optional() }).parse(request.body ?? {});
    const result = await runCompletion(request.userId!, 'seo_analysis', {
      system:
        'You are a YouTube metadata specialist. Suggest 15 tags for the video: main keyword first, then variants, sub-topics and misspellings users type. Lowercase, no # symbols, total under 500 characters. Return STRICT JSON: {"tags":["..."],"hashtags":["..."],"gaps":["metadata gaps you noticed"]}. No commentary.',
      messages: [{ role: 'user', content: `Title: ${body.title}\nMain keyword: ${body.keyword ?? body.title}` }],
      json: true,
      maxTokens: 500,
    });
    return { raw: extractJson(result.text), model: result.model };
  });

  // AI-powered idea generation used by the Content Studio
  app.post('/api/ideas', { preHandler: requireAuth }, async (request) => {
    const body = z
      .object({
        type: z.enum(['viral', 'shorts', 'longform', 'educational', 'entertainment', 'series', 'trending']).default('longform'),
        topic: z.string().max(200).optional(),
        count: z.coerce.number().min(1).max(10).default(5),
        channelContext: z.string().max(3000).optional(),
      })
      .parse(request.body ?? {});

    const result = await runCompletion(request.userId!, 'content_generation', {
      system: IDEAS_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Generate ${body.count} ${body.type} video ideas.${body.topic ? ` Topic focus: ${body.topic}.` : ''}${body.channelContext ? `\n\nCHANNEL CONTEXT:\n${body.channelContext}` : ''}`,
        },
      ],
      json: true,
      maxTokens: 1600,
    });
    const parsed = extractJson(result.text) as { ideas?: AiIdea[] };
    const ideas = Array.isArray(parsed.ideas) ? parsed.ideas.slice(0, body.count) : [];
    await prisma.generatedContent.create({
      data: { userId: request.userId!, kind: 'idea_set', prompt: `${body.type}: ${body.topic ?? ''}`, payload: ideas as object, provider: result.provider, model: result.model },
    });
    return { ideas, model: result.model, isFallback: result.isFallback };
  });

  // Quick helper for content script: parse a URL into a video id (no API call)
  app.post('/api/seo/parse-video-id', { preHandler: requireAuth }, async (request) => {
    const { input } = z.object({ input: z.string().min(3).max(300) }).parse(request.body ?? {});
    const id = extractVideoId(input);
    return { videoId: id };
  });
}
