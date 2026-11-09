import { AiProviderError, type CompletionRequest, type CompletionResult, type ProviderAdapter } from '../types.js';

interface OpenAiResponse {
  choices: { message: { content: string | null } }[];
  usage: { prompt_tokens: number; completion_tokens: number };
  model: string;
  error?: { message: string };
}

export const openaiAdapter: ProviderAdapter = {
  kind: 'openai',

  async complete(apiKey, model, request: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: request.system },
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      max_tokens: request.maxTokens ?? 2000,
      temperature: request.temperature ?? 0.4,
    };
    if (request.json) body.response_format = { type: 'json_object' };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new AiProviderError('openai', response.status, `HTTP ${response.status}: ${errBody.slice(0, 300)}`);
    }

    const data = (await response.json()) as OpenAiResponse;
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';

    return {
      text,
      model: data.model ?? model,
      promptTokens: data.usage?.prompt_tokens ?? null,
      completionTokens: data.usage?.completion_tokens ?? null,
      latencyMs: Date.now() - started,
    };
  },

  async test(apiKey, model) {
    const result = await openaiAdapter.complete(apiKey, model, {
      system: 'Reply with exactly: pong',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 10,
    });
    return result.text.slice(0, 50) || 'ok';
  },
};
