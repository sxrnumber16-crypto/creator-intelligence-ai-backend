import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import { requireAuth, requireActiveChannel } from '../lib/auth.js';
import { encryptSecret } from '../lib/crypto.js';
import { runCompletion, testProvider, TASKS, SUPPORTED_PROVIDERS } from '../services/ai/gateway.js';
import { extractJson } from '../services/ai/types.js';
import { ASSISTANT_SYSTEM, channelContextBlock, PLAN_SYSTEM, SCRIPT_SYSTEM } from '../services/ai/prompts.js';
import type { AiProviderConfig, AiProviderKind, AiScript } from '@cia/shared';

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- providers
  app.get('/api/ai/providers', { preHandler: requireAuth }, async (request) => {
    const providers = await prisma.aiProvider.findMany({ where: { userId: request.userId! } });
    const items: AiProviderConfig[] = providers.map((p) => ({
      id: p.id,
      kind: p.kind as AiProviderKind,
      label: p.label,
      hasKey: Boolean(p.apiKeyEnc),
      isDefault: p.isDefault,
      model: p.model,
      status: p.status as AiProviderConfig['status'],
      lastError: p.lastError,
      taskRouting: (p.taskRouting as Record<string, string>) ?? {},
      usageLimits: { dailyRequests: p.dailyRequestLimit },
    }));
    return { items, supportedKinds: SUPPORTED_PROVIDERS, tasks: TASKS };
  });

  app.post('/api/ai/providers', { preHandler: requireAuth }, async (request) => {
    const body = z
      .object({
        kind: z.enum(['anthropic', 'openai', 'gemini']),
        label: z.string().min(1).max(60).optional(),
        apiKey: z.string().min(10).max(300),
        model: z.string().min(1).max(80),
        setDefault: z.boolean().default(false),
      })
      .parse(request.body ?? {});

    const provider = await prisma.aiProvider.upsert({
      where: { userId_kind: { userId: request.userId!, kind: body.kind } },
      create: {
        userId: request.userId!,
        kind: body.kind,
        label: body.label ?? body.kind,
        apiKeyEnc: encryptSecret(body.apiKey),
        model: body.model,
        isDefault: body.setDefault,
      },
      update: {
        apiKeyEnc: encryptSecret(body.apiKey),
        model: body.model,
        label: body.label ?? undefined,
        isDefault: body.setDefault ? true : undefined,
        status: 'unverified',
      },
    });
    if (body.setDefault) {
      await prisma.aiProvider.updateMany({ where: { userId: request.userId! }, data: { isDefault: false } });
      await prisma.aiProvider.update({ where: { id: provider.id }, data: { isDefault: true } });
    }
    return { id: provider.id, ok: true };
  });

  app.patch('/api/ai/providers/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        model: z.string().max(80).optional(),
        setDefault: z.boolean().optional(),
        taskRouting: z.record(z.string()).optional(),
        dailyRequestLimit: z.number().int().min(1).max(10_000).nullable().optional(),
        label: z.string().max(60).optional(),
      })
      .parse(request.body ?? {});

    const provider = await prisma.aiProvider.findFirst({ where: { id, userId: request.userId! } });
    if (!provider) throw errors.notFound('Provider not found');

    if (body.setDefault) {
      await prisma.aiProvider.updateMany({ where: { userId: request.userId! }, data: { isDefault: false } });
    }
    await prisma.aiProvider.update({
      where: { id },
      data: {
        model: body.model ?? undefined,
        label: body.label ?? undefined,
        isDefault: body.setDefault ?? undefined,
        taskRouting: body.taskRouting ? (body.taskRouting as object) : undefined,
        dailyRequestLimit: body.dailyRequestLimit === undefined ? undefined : body.dailyRequestLimit,
      },
    });
    return { ok: true };
  });

  app.delete('/api/ai/providers/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await prisma.aiProvider.deleteMany({ where: { id, userId: request.userId! } });
    return { ok: true };
  });

  app.post('/api/ai/providers/:id/test', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return { reply: await testProvider(request.userId!, id) };
  });

  app.get('/api/ai/usage', { preHandler: requireAuth }, async (request) => {
    const usage = await prisma.aiUsage.findMany({
      where: { userId: request.userId! },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { items: usage };
  });

  // ---------------------------------------------------------------- studio
  app.post('/api/ai/script', { preHandler: [requireAuth, requireActiveChannel] }, async (request) => {
    const body = z
      .object({
        brief: z.string().min(5).max(2000),
        format: z.enum(['shorts', 'longform']).default('longform'),
        durationMinutes: z.coerce.number().min(1).max(60).optional(),
        tone: z.string().max(100).optional(),
        channelContext: z.string().max(3000).optional(),
      })
      .parse(request.body ?? {});

    const result = await runCompletion(request.userId!, 'script_writing', {
      system: SCRIPT_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Brief: ${body.brief}\nFormat: ${body.format}${body.durationMinutes ? `\nTarget length: ${body.durationMinutes} minutes` : ''}${body.tone ? `\nTone: ${body.tone}` : ''}${body.channelContext ? `\n\nCHANNEL CONTEXT:\n${body.channelContext}` : ''}`,
        },
      ],
      json: true,
      maxTokens: 3000,
    });
    const script = extractJson(result.text) as AiScript;
    await prisma.generatedContent.create({
      data: { userId: request.userId!, kind: 'script', prompt: body.brief.slice(0, 2000), payload: script as object, provider: result.provider, model: result.model },
    });
    return { script, model: result.model };
  });

  app.post('/api/ai/plan', { preHandler: [requireAuth, requireActiveChannel] }, async (request) => {
    const body = z
      .object({ weeks: z.coerce.number().min(1).max(4).default(2), channelContext: z.string().max(3000).optional(), focus: z.string().max(300).optional() })
      .parse(request.body ?? {});
    const result = await runCompletion(request.userId!, 'content_generation', {
      system: PLAN_SYSTEM,
      messages: [{ role: 'user', content: `Create a ${body.weeks}-week content plan.${body.focus ? ` Focus: ${body.focus}.` : ''}${body.channelContext ? `\n\nCHANNEL CONTEXT:\n${body.channelContext}` : ''}` }],
      json: true,
      maxTokens: 2400,
    });
    const plan = extractJson(result.text);
    await prisma.generatedContent.create({
      data: { userId: request.userId!, kind: 'plan', prompt: `${body.weeks} weeks ${body.focus ?? ''}`, payload: plan as object, provider: result.provider, model: result.model },
    });
    return { plan, model: result.model };
  });

  // ---------------------------------------------------------------- assistant
  app.post('/api/ai/chat', { preHandler: requireAuth }, async (request) => {
    const body = z
      .object({
        conversationId: z.string().optional(),
        message: z.string().min(1).max(4000),
      })
      .parse(request.body ?? {});
    const userId = request.userId!;

    // Resolve channel context (active channel + latest data snapshot)
    let contextBlock = '';
    let channelDbId: string | null = null;
    const channel = await prisma.channel.findFirst({ where: { userId, isActive: true } });
    if (channel) {
      channelDbId = channel.id;
      const [snap, videos, competitors] = await Promise.all([
        prisma.channelSnapshot.findFirst({ where: { channelId: channel.id }, orderBy: { capturedAt: 'desc' } }),
        prisma.video.findMany({ where: { channelId: channel.id }, orderBy: { publishedAt: 'desc' }, take: 30 }),
        prisma.competitor.findMany({
          where: { userId },
          include: { videos: { orderBy: { publishedAt: 'desc' }, take: 12 } },
        }),
      ]);
      const ranked = videos.filter((v) => v.viewCount != null).sort((a, b) => Number(b.viewCount) - Number(a.viewCount));
      const ctx = channelContextBlock({
        channelTitle: channel.title,
        range: 'last 30-90 days (varies by data)',
        totals: {
          subscribers: snap?.subscribers ?? 'n/a',
          totalViews: snap?.totalViews != null ? Number(snap.totalViews) : 'n/a',
          videoCount: snap?.videoCount ?? 'n/a',
        },
        topVideos: ranked.slice(0, 5).map((v) => ({ title: v.title, views: Number(v.viewCount), isShort: v.isShort, publishedAt: v.publishedAt.toISOString() })),
        lowVideos: ranked.slice(-3).map((v) => ({ title: v.title, views: Number(v.viewCount), isShort: v.isShort, publishedAt: v.publishedAt.toISOString() })),
        competitors: competitors.slice(0, 4).map((c) => ({
          title: c.title,
          medianRecentViews: medianOf(c.videos.map((v) => (v.viewCount != null ? Number(v.viewCount) : 0))),
          uploadsPerWeek: null,
          topTopics: topTopicsOf(c.videos.map((v) => v.title)),
        })),
        audienceNote: 'Competitor data is public only. Private analytics rows (watch time, retention, CTR) were not loaded into this context; say so if the question needs them.',
      });
      contextBlock = `CHANNEL CONTEXT:\n${ctx}`;
    }

    const conversation = body.conversationId
      ? await prisma.aiConversation.findFirst({ where: { id: body.conversationId, userId } })
      : await prisma.aiConversation.create({ data: { userId, channelId: channelDbId, title: body.message.slice(0, 60) } });
    if (!conversation) throw errors.notFound('Conversation not found');

    const history = await prisma.aiMessage.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: 'asc' }, take: 20 });
    await prisma.aiMessage.create({ data: { conversationId: conversation.id, role: 'user', content: body.message, dataReferences: [] } });

    const result = await runCompletion(userId, 'assistant', {
      system: `${ASSISTANT_SYSTEM}\n\n${contextBlock}`,
      messages: [
        ...history.map((m) => ({ role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: m.content })),
        { role: 'user' as const, content: body.message },
      ],
      maxTokens: 1500,
    });

    const references: string[] = [];
    if (channel) references.push(`channel:${channel.title}`);
    const message = await prisma.aiMessage.create({
      data: { conversationId: conversation.id, role: 'assistant', content: result.text, dataReferences: references },
    });

    return {
      conversationId: conversation.id,
      message: { role: 'assistant', content: result.text, createdAt: message.createdAt.toISOString() },
      dataReferences: references,
      provider: result.provider,
      model: result.model,
    };
  });

  app.get('/api/ai/conversations', { preHandler: requireAuth }, async (request) => {
    const conversations = await prisma.aiConversation.findMany({
      where: { userId: request.userId! },
      orderBy: { updatedAt: 'desc' },
      take: 30,
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    return {
      items: conversations.map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt.toISOString(),
        messages: c.messages.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt.toISOString() })),
      })),
    };
  });

  app.delete('/api/ai/conversations/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await prisma.aiConversation.deleteMany({ where: { id, userId: request.userId! } });
    return { ok: true };
  });
}

function medianOf(values: number[]): number | null {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function topTopicsOf(titles: string[]): string[] {
  const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'your', 'how', 'what', 'why', 'you', 'from', 'are', 'was']);
  const counts = new Map<string, number>();
  for (const title of titles) {
    for (const token of title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
      if (token.length >= 4 && !STOP.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);
}
