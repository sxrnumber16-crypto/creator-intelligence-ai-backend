import { AiProviderError, type CompletionRequest, type CompletionResult, type ProviderAdapter } from '../types.js';

interface GeminiResponse {
  candidates: { content: { parts: { text?: string }[] } }[];
  usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
  modelVersion?: string;
  error?: { message: string };
}

export const geminiAdapter: ProviderAdapter = {
  kind: 'gemini',

  async complete(apiKey, model, request: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const body: Record<string, unknown> = {
      system_instruction: { parts: [{ text: request.system }] },
      contents: request.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 2000,
        temperature: request.temperature ?? 0.4,
        ...(request.json ? { responseMimeType: 'application/json' } : {}),
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new AiProviderError('gemini', response.status, `HTTP ${response.status}: ${errBody.slice(0, 300)}`);
    }

    const data = (await response.json()) as GeminiResponse;
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();

    return {
      text,
      model: data.modelVersion ?? model,
      promptTokens: data.usageMetadata?.promptTokenCount ?? null,
      completionTokens: data.usageMetadata?.candidatesTokenCount ?? null,
      latencyMs: Date.now() - started,
    };
  },

  async test(apiKey, model) {
    const result = await geminiAdapter.complete(apiKey, model, {
      system: 'Reply with exactly: pong',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 10,
    });
    return result.text.slice(0, 50) || 'ok';
  },
};
