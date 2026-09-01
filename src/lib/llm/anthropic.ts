// Anthropic provider — supports Claude Sonnet, Opus, Haiku, Fable, and future models.
//
// Anthropic uses a different API shape from OpenAI:
//   - Endpoint: /v1/messages (not /chat/completions)
//   - Auth: x-api-key header + anthropic-version header (not Bearer)
//   - System prompt: top-level `system` param (not a message in the array)
//   - max_tokens is required (not optional)
//   - Response shape: { content: [{ type: 'text', text }], usage: { input_tokens, output_tokens } }
//
// IMPORTANT: Some Anthropic models (e.g. claude-fable) do NOT accept `temperature`.
// We omit it entirely — Anthropic will use its default.
//
// EXTENDED THINKING: Newer Claude models (claude-3.5-sonnet+, claude-fable, etc.)
// support extended thinking. If the model returns only thinking blocks (no text),
// we retry with thinking explicitly enabled.

import { LLMProvider, ProviderConfig, GenerateRequest, GenerateResponse, normaliseFinishReason } from './types';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';

export class AnthropicProvider implements LLMProvider {
  readonly type = 'anthropic' as const;
  private apiKey: string;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  private async callAPI(
    url: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<any> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let errMsg = text;
      try {
        const parsed = JSON.parse(text);
        errMsg = parsed?.error?.message || parsed?.message || text;
      } catch { /* not JSON */ }
      throw new Error(`Anthropic API error (${res.status}): ${errMsg}`);
    }

    return await res.json() as any;
  }

  private extractReply(data: any): string {
    const contentBlocks = Array.isArray(data?.content) ? data.content : [];
    const textParts: string[] = [];
    const thinkingParts: string[] = [];

    for (const block of contentBlocks) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        thinkingParts.push(block.thinking);
      }
    }

    // Prefer text blocks; fall back to thinking blocks.
    if (textParts.length > 0) return textParts.join('\n\n');
    if (thinkingParts.length > 0) return thinkingParts.join('\n\n');
    return '';
  }

  /**
   * Check whether the response contains thinking blocks but no text blocks.
   * This indicates the model supports extended thinking but it wasn't
   * explicitly enabled, so we should retry with thinking enabled.
   */
  private needsThinkingRetry(data: any): boolean {
    const contentBlocks = Array.isArray(data?.content) ? data.content : [];
    const hasThinking = contentBlocks.some((b: any) => b.type === 'thinking');
    const hasText = contentBlocks.some((b: any) => b.type === 'text' && b.text);
    return hasThinking && !hasText;
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const { model, messages } = req;
    const maxTokens = req.maxTokens || 16000;

    // Extract system messages into a single top-level system param (Anthropic
    // requires this — putting system in the messages array is rejected).
    let systemContent = '';
    const convMessages: { role: string; content: string }[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        systemContent += (systemContent ? '\n\n' : '') + m.content;
      } else {
        convMessages.push({ role: m.role, content: m.content });
      }
    }

    const url = this.baseUrl + '/v1/messages';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);

    // Build body — do NOT include temperature.
    // Some models (claude-fable, etc.) reject it with 400.
    const thinkingBudget = Math.min(Math.floor(maxTokens * 0.75), 10000);
    const body: Record<string, unknown> = {
      model,
      system: systemContent || undefined,
      messages: convMessages,
      max_tokens: maxTokens,
    };

    try {
      // ── Attempt 1: without explicit thinking ──
      let data = await this.callAPI(url, body, controller.signal);

      // If the model returned thinking blocks but no text, it likely needs
      // extended thinking explicitly enabled. Retry with thinking parameter.
      if (this.needsThinkingRetry(data)) {
        const bodyWithThinking = {
          ...body,
          max_tokens: maxTokens + thinkingBudget, // thinking budget is separate from output
          thinking: { type: 'enabled', budget_tokens: thinkingBudget } as Record<string, unknown>,
        };
        data = await this.callAPI(url, bodyWithThinking, controller.signal);
      }

      // Extract reply from content blocks (handles thinking + text mix).
      const reply = this.extractReply(data);
      if (!reply) {
        const contentBlocks = Array.isArray(data?.content) ? data.content : [];
        const blockTypes = contentBlocks.map((b: any) => `${b.type}${b.type === 'thinking' ? '(len=' + (b.thinking || '').length + ')' : ''}`).join(', ');
        console.error(`[Anthropic] No usable content. Block types: [${blockTypes}], stop_reason: ${data?.stop_reason}, full response:`, JSON.stringify(data).slice(0, 800));
        throw new Error(`Anthropic: empty or malformed response. Content blocks: [${blockTypes}], stop_reason: ${data?.stop_reason || 'unknown'}`);
      }

      const inputTokens = data?.usage?.input_tokens || 0;
      const outputTokens = data?.usage?.output_tokens || 0;
      return {
        reply,
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
        // Anthropic calls it stop_reason, and 'max_tokens' is its 'length'.
        finishReason: normaliseFinishReason(data?.stop_reason),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
