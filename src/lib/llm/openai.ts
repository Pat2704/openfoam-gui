// OpenAI provider — supports GPT-4.x, GPT-5, o1, o3, o4, and future models.
//
// KEY DIFFERENCE from the old code: GPT-5 and other "reasoning" models
// (o1, o3, o4, gpt-5, gpt-5-mini) have different API requirements:
//   - They use `max_completion_tokens` (NOT `max_tokens`)
//   - They do NOT accept a custom `temperature` (only default 1)
//   - They do NOT accept `top_p`, `frequency_penalty`, `presence_penalty`
// GPT-4.x models still accept the legacy `max_tokens` + `temperature`.
//
// This provider detects the model family and sends the correct parameters,
// so both GPT-4.1 and GPT-5 work without code changes.

import { LLMProvider, ProviderConfig, GenerateRequest, GenerateResponse, ChatMessage, normaliseFinishReason } from './types';

// Models that use the "reasoning" parameter set (max_completion_tokens, no temperature).
// Detected by name prefix: o1-*, o3-*, o4-*, gpt-5*.
function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4') || m.startsWith('gpt-5');
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class OpenAIProvider implements LLMProvider {
  readonly type = 'openai' as const;
  private apiKey: string;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const { model, messages } = req;
    const reasoning = isReasoningModel(model);
    const maxOutput = req.maxTokens || 20000;

    // Build the request body — parameters differ between reasoning and standard models.
    const body: Record<string, unknown> = {
      model,
      messages,
    };

    if (reasoning) {
      // GPT-5 / o1 / o3 / o4: use max_completion_tokens, NO temperature.
      body.max_completion_tokens = maxOutput;
      // temperature is intentionally omitted — reasoning models only support
      // the default (1) and reject any custom value with a 400 error.
    } else {
      // GPT-4.x and other standard models: legacy max_tokens + temperature.
      body.max_tokens = maxOutput;
      body.temperature = 0.3;
    }

    const url = this.baseUrl + '/chat/completions';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Surface the REAL error from OpenAI — don't hide it behind a generic message.
        const text = await res.text().catch(() => '');
        let errMsg = text;
        try {
          const parsed = JSON.parse(text);
          errMsg = parsed?.error?.message || parsed?.message || text;
        } catch { /* not JSON, use raw text */ }
        throw new Error(`OpenAI API error (${res.status}): ${errMsg}`);
      }

      const data = await res.json();
      const reply = data?.choices?.[0]?.message?.content;
      if (typeof reply !== 'string' || !reply) {
        throw new Error(`OpenAI: empty or malformed response. Response: ${JSON.stringify(data).slice(0, 300)}`);
      }

      return { reply, usage: data?.usage, finishReason: normaliseFinishReason(data?.choices?.[0]?.finish_reason) };
    } finally {
      clearTimeout(timeout);
    }
  }
}
