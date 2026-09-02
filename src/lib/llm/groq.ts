// Groq provider — supports Llama, DeepSeek, Qwen, Mixtral, Gemma, and other
// models available on Groq's OpenAI-compatible endpoint.
//
// Groq uses the same /chat/completions format as OpenAI, but with a different
// base URL (api.groq.com) and Bearer auth.
//
// IMPORTANT: Groq free tier has very low TPM limits (e.g. 6000 TPM).
// The default max_tokens of 20000 would cause 413 errors because
// Groq counts max_tokens against the TPM budget. We cap it to 4096
// and also trim the system prompt to stay within limits.

import { LLMProvider, ProviderConfig, GenerateRequest, GenerateResponse, normaliseFinishReason } from './types';

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';

// Conservative max output tokens for Groq — keeps total request
// (input + max_tokens) well under typical TPM limits.
const GROQ_MAX_OUTPUT_TOKENS = 4096;

export class GroqProvider implements LLMProvider {
  readonly type = 'groq' as const;
  private apiKey: string;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const { model, messages } = req;
    // Cap max_tokens to GROQ_MAX_OUTPUT_TOKENS regardless of what the caller requests.
    // This prevents 413 errors on free/low-tier Groq plans where TPM is limited.
    const maxTokens = Math.min(req.maxTokens || GROQ_MAX_OUTPUT_TOKENS, GROQ_MAX_OUTPUT_TOKENS);

    // Trim messages to keep total input size reasonable for Groq's limits.
    // We keep the system prompt but truncate it if it's very long,
    // and limit conversation history to stay within budget.
    const trimmedMessages = this.trimMessagesForGroq(messages);

    const url = this.baseUrl + '/chat/completions';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);

    const body: Record<string, unknown> = {
      model,
      messages: trimmedMessages,
      max_tokens: maxTokens,
      temperature: 0.3,
    };

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
        const text = await res.text().catch(() => '');
        let errMsg = text;
        try {
          const parsed = JSON.parse(text);
          errMsg = parsed?.error?.message || parsed?.message || text;
        } catch { /* not JSON */ }
        throw new Error(`Groq API error (${res.status}): ${errMsg}`);
      }

      const data = await res.json();
      const message = data?.choices?.[0]?.message;
      const reply = message?.content;
      if (typeof reply !== 'string' || !reply) {
        // Reasoning models (Groq's gpt-oss line) answer in two parts: their
        // thinking goes to `reasoning` and the answer to `content`. When the
        // output budget runs out inside the thinking, `content` comes back
        // empty with finish_reason "stop" — which reads as a broken provider
        // unless the message says what actually happened.
        if (typeof message?.reasoning === 'string' && message.reasoning) {
          throw new Error(
            'Groq: the model spent its whole output budget on internal reasoning and ' +
            'returned no answer. Ask something narrower, or pick a model that does not reason.',
          );
        }
        throw new Error(`Groq: empty or malformed response. Response: ${JSON.stringify(data).slice(0, 300)}`);
      }

      return { reply, usage: data?.usage, finishReason: normaliseFinishReason(data?.choices?.[0]?.finish_reason) };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Trim messages to keep the total request within Groq's limits.
   * - System prompt: cap at 3000 chars (~800 tokens)
   * - Conversation history: keep last N messages to stay under ~2000 chars total
   * - Always keep the last user message intact
   */
  private trimMessagesForGroq(messages: { role: string; content: string }[]): { role: string; content: string }[] {
    const MAX_SYSTEM_CHARS = 3000;
    const MAX_HISTORY_CHARS = 2000;

    const result: { role: string; content: string }[] = [];
    let historyChars = 0;

    // Process in reverse to keep the most recent messages
    const reversed = [...messages].reverse();

    for (const msg of reversed) {
      if (msg.role === 'system') {
        // Truncate system prompt if needed
        let content = msg.content;
        if (content.length > MAX_SYSTEM_CHARS) {
          content = content.slice(0, MAX_SYSTEM_CHARS) + '\n\n[... system truncated for Groq limits ...]';
        }
        result.unshift({ role: msg.role, content });
      } else {
        // Count non-system messages toward history budget
        if (historyChars + msg.content.length > MAX_HISTORY_CHARS && result.some(m => m.role !== 'system')) {
          // Skip older messages to stay within budget
          continue;
        }
        historyChars += msg.content.length;
        result.unshift({ role: msg.role, content: msg.content });
      }
    }

    return result;
  }
}
