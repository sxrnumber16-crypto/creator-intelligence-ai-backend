import { AiProviderError, type CompletionRequest, type CompletionResult, type ProviderAdapter } from '../types.js';

interface AnthropicResponse {
  content: { type: string; text?: string }[];
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  error?: { type: string; message: string };
}

export const anthropicAdapter: ProviderAdapter = {
  kind: 'anthropic',

  async complete(apiKey, model, request: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: request.maxTokens ?? 2000,
        temperature: request.temperature ?? 0.4,
        system: request.system,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new AiProviderError('anthropic', response.status, `HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    const data = (await response.json()) as AnthropicResponse;
    const text = (data.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim();

    return {
      text,
      model: data.model ?? model,
      promptTokens: data.usage?.input_tokens ?? null,
      completionTokens: data.usage?.output_tokens ?? null,
      latencyMs: Date.now() - started,
    };
  },

  async test(apiKey, model) {
    const result = await anthropicAdapter.complete(apiKey, model, {
      system: 'Reply with exactly: pong',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 10,
    });
    return result.text.slice(0, 50) || 'ok';
  },
};
