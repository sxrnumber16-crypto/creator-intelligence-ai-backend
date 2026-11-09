export type ProviderKind = 'anthropic' | 'openai' | 'gemini';

export const SUPPORTED_PROVIDERS: ProviderKind[] = ['anthropic', 'openai', 'gemini'];

export const DEFAULT_MODELS: Record<ProviderKind, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-1.5-flash',
};

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  anthropic: 'Anthropic Claude',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
};

export interface CompletionRequest {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for JSON output where supported (still validated by the caller). */
  json?: boolean;
}

export interface CompletionResult {
  text: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
}

export interface ProviderAdapter {
  kind: ProviderKind;
  complete(apiKey: string, model: string, request: CompletionRequest): Promise<CompletionResult>;
  /** Cheap connectivity test. Should return a short string like "pong". */
  test(apiKey: string, model: string): Promise<string>;
}

export class AiProviderError extends Error {
  constructor(
    public kind: ProviderKind,
    public statusCode: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/** Extract the first JSON object/array from a model response (handles code fences). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to first {...} or [...] block.
    const objMatch = candidate.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0]);
      } catch {
        /* fallthrough */
      }
    }
    throw new Error('Model did not return valid JSON');
  }
}
