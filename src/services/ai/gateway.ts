import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { decryptSecret } from '../../lib/crypto.js';
import { errors, AppError } from '../../lib/errors.js';
import type { AiTask } from '@cia/shared';
import {
  DEFAULT_MODELS,
  PROVIDER_LABELS,
  SUPPORTED_PROVIDERS,
  type ProviderAdapter,
  type ProviderKind,
} from './types.js';
import { anthropicAdapter } from './providers/anthropic.js';
import { openaiAdapter } from './providers/openai.js';
import { geminiAdapter } from './providers/gemini.js';

const ADAPTERS: Record<ProviderKind, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  gemini: geminiAdapter,
};

export const TASKS: AiTask[] = [
  'content_generation',
  'seo_analysis',
  'competitor_analysis',
  'analytics_interpretation',
  'script_writing',
  'assistant',
];

interface ResolvedProvider {
  kind: ProviderKind;
  apiKey: string;
  model: string;
  providerId: string | null; // null = env-provided key
  isFallback: boolean;
}

/** Resolve which provider/model handles a task for this user (config > env default). */
async function resolveProvider(userId: string, task: AiTask): Promise<ResolvedProvider> {
  const providers = await prisma.aiProvider.findMany({ where: { userId } });

  const routeTo = (taskRouting: unknown): string | null => {
    if (taskRouting && typeof taskRouting === 'object' && task in (taskRouting as Record<string, unknown>)) {
      return String((taskRouting as Record<string, string>)[task]);
    }
    return null;
  };

  // 1. Task-specific routing
  for (const p of providers) {
    if (p.status === 'error' || !p.apiKeyEnc) continue;
    const routedId = routeTo(p.taskRouting);
    if (routedId && p.id === routedId) {
      return { kind: p.kind as ProviderKind, apiKey: decryptSecret(p.apiKeyEnc), model: p.model, providerId: p.id, isFallback: false };
    }
  }

  // 2. Default provider
  const def = providers.find((p) => p.isDefault && p.apiKeyEnc && p.status !== 'error');
  if (def?.apiKeyEnc) {
    return { kind: def.kind as ProviderKind, apiKey: decryptSecret(def.apiKeyEnc), model: def.model, providerId: def.id, isFallback: false };
  }

  // 3. First working configured provider
  const anyConfigured = providers.find((p) => p.apiKeyEnc && p.status !== 'error');
  if (anyConfigured?.apiKeyEnc) {
    return { kind: anyConfigured.kind as ProviderKind, apiKey: decryptSecret(anyConfigured.apiKeyEnc), model: anyConfigured.model, providerId: anyConfigured.id, isFallback: false };
  }

  // 4. Server env key (documented in AI_PROVIDER_SETUP.md)
  const envProvider = SUPPORTED_PROVIDERS.find((kind) => envApiKey(kind));
  if (envProvider) {
    return { kind: envProvider, apiKey: envApiKey(envProvider)!, model: DEFAULT_MODELS[envProvider], providerId: null, isFallback: true };
  }

  throw errors.notConfigured(
    'No AI provider',
    'Add an API key in Settings > AI Providers (Anthropic, OpenAI or Gemini), or set ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY in the backend .env.',
  );
}

function envApiKey(kind: ProviderKind): string | null {
  const map: Record<ProviderKind, string> = {
    anthropic: env.ANTHROPIC_API_KEY,
    openai: env.OPENAI_API_KEY,
    gemini: env.GEMINI_API_KEY,
  };
  const key = map[kind];
  return key && key.length > 0 ? key : null;
}

export interface GatewayRun {
  text: string;
  provider: ProviderKind;
  model: string;
  isFallback: boolean;
  source: 'ai';
}

/**
 * Run a completion with reliability guarantees: timeout via adapter fetch,
 * status updates on error, usage logging, and optional fallback to any other
 * configured provider. Throws a clear NOT_CONFIGURED error when nothing is set up.
 */
export async function runCompletion(
  userId: string,
  task: AiTask,
  request: Parameters<ProviderAdapter['complete']>[2],
): Promise<GatewayRun> {
  const primary = await resolveProvider(userId, task);

  try {
    const result = await execute(primary, request);
    await logUsage(userId, primary, task, result, true);
    return { text: result.text, provider: primary.kind, model: result.model, isFallback: primary.isFallback, source: 'ai' };
  } catch (primaryError) {
    const failureMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
    if (primary.providerId) {
      await prisma.aiProvider.update({
        where: { id: primary.providerId },
        data: { status: 'error', lastError: failureMessage.slice(0, 500) },
      }).catch(() => undefined);
    }
    await logUsage(userId, primary, task, null, false, failureMessage);

    // Fallback: try env/default of a different provider kind.
    const alternate = SUPPORTED_PROVIDERS.find((kind) => kind !== primary.kind && envApiKey(kind));
    if (alternate) {
      const altProvider: ResolvedProvider = {
        kind: alternate,
        apiKey: envApiKey(alternate)!,
        model: DEFAULT_MODELS[alternate],
        providerId: null,
        isFallback: true,
      };
      try {
        const result = await execute(altProvider, request);
        await logUsage(userId, altProvider, task, result, true);
        return { text: result.text, provider: altProvider.kind, model: result.model, isFallback: true, source: 'ai' };
      } catch {
        /* fall through to error */
      }
    }
    throw new AppError(502, 'AI_PROVIDER_ERROR', `AI request failed: ${failureMessage.slice(0, 300)}`);
  }
}

async function execute(provider: ResolvedProvider, request: Parameters<ProviderAdapter['complete']>[2]) {
  const adapter = ADAPTERS[provider.kind];
  const result = await adapter.complete(provider.apiKey, provider.model, request);
  if (provider.providerId) {
    await prisma.aiProvider.update({ where: { id: provider.providerId }, data: { status: 'ok', lastError: null } }).catch(() => undefined);
  }
  return result;
}

async function logUsage(
  userId: string,
  provider: ResolvedProvider,
  task: AiTask,
  result: { model: string; promptTokens: number | null; completionTokens: number | null; latencyMs: number } | null,
  ok: boolean,
  error?: string,
) {
  await prisma.aiUsage.create({
    data: {
      userId,
      provider: provider.kind,
      model: result?.model ?? provider.model,
      task,
      promptTokens: result?.promptTokens ?? null,
      completionTokens: result?.completionTokens ?? null,
      ok,
      error: error?.slice(0, 500) ?? null,
      latencyMs: result?.latencyMs ?? null,
    },
  }).catch(() => undefined);
}

export async function testProvider(userId: string, providerId: string): Promise<string> {
  const provider = await prisma.aiProvider.findFirst({ where: { id: providerId, userId } });
  if (!provider) throw errors.notFound('Provider not found');
  if (!provider.apiKeyEnc) throw errors.badRequest('No API key stored for this provider');
  const adapter = ADAPTERS[provider.kind as ProviderKind];
  try {
    const result = await adapter.test(decryptSecret(provider.apiKeyEnc), provider.model);
    await prisma.aiProvider.update({ where: { id: provider.id }, data: { status: 'ok', lastError: null } });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.aiProvider.update({ where: { id: provider.id }, data: { status: 'error', lastError: message.slice(0, 500) } });
    throw new AppError(502, 'AI_PROVIDER_ERROR', `Provider test failed: ${message.slice(0, 300)}`);
  }
}

export { DEFAULT_MODELS, PROVIDER_LABELS, SUPPORTED_PROVIDERS };
export type { ProviderKind };
