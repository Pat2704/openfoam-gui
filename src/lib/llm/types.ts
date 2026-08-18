// LLM abstraction layer — provider-agnostic interfaces.
// The GUI/route never calls OpenAI/Anthropic/Groq directly; it calls
// LLMProvider.generate(). Each provider handles its own API format, auth,
// and model-specific parameter differences (e.g. GPT-5 vs GPT-4.x).

export type ProviderType = 'openai' | 'anthropic' | 'groq' | 'custom';

export type ApiFormat = 'openai-chat' | 'anthropic-messages';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number; // desired cap on output tokens
}

export interface GenerateResponse {
  reply: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface LLMProvider {
  readonly type: ProviderType;
  /** Generate a completion. Throws Error with the REAL provider error message. */
  generate(req: GenerateRequest): Promise<GenerateResponse>;
}

export interface ProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string; // optional override (defaults to the provider's official endpoint)
  apiFormat?: ApiFormat; // explicit API format override (for 'custom' provider)
}

// ── Factory: create a provider from its type + config ──
export function createProvider(type: ProviderType, config: ProviderConfig): LLMProvider {
  switch (type) {
    case 'openai':
      return new OpenAIProvider(config);
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'groq':
      return new GroqProvider(config);
    case 'custom':
      // Custom provider uses OpenAI-compatible format by default,
      // but can use Anthropic Messages API if apiFormat is set.
      if (config.apiFormat === 'anthropic-messages') {
        return new AnthropicProvider(config);
      }
      return new OpenAIProvider(config);
  }
}

// ── Provider implementations are imported below ──
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { GroqProvider } from './groq';
