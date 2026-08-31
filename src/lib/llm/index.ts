// LLM Manager — resolves the provider configuration from the request body
// (which carries the config from the chat popup localStorage).
// No .env needed — all config lives in the browser.

import { createProvider, LLMProvider, ProviderType, ProviderConfig, ApiFormat } from './types';

export interface ResolvedConfig {
  provider: LLMProvider;
  model: string;
  providerType: ProviderType;
  baseUrl: string;
  apiFormat: ApiFormat;
}

// Default model per provider.
const DEFAULT_MODELS: Record<ProviderType, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-20250514',
  groq: 'llama-3.3-70b-versatile',
  custom: '',
};

// Default base URL per provider.
const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  groq: 'https://api.groq.com/openai/v1',
  custom: '',
};

// Default API format per provider.
const DEFAULT_API_FORMATS: Record<ProviderType, ApiFormat> = {
  openai: 'openai-chat',
  anthropic: 'anthropic-messages',
  groq: 'openai-chat',
  custom: 'openai-chat',
};

// Valid provider types.
const VALID_PROVIDERS: ProviderType[] = ['openai', 'anthropic', 'groq', 'custom'];

// Resolve LLM config from the chat popup (provider + key + model + baseUrl + apiFormat
// passed in the request body). Returns null if not configured.
export function resolveLLMConfig(params: {
  modelOverride: string;
  provider: string;
  apiKey: string;
  baseUrl?: string;
  apiFormat?: string;
}): ResolvedConfig | null {
  const { modelOverride, provider, apiKey, baseUrl: baseUrlOverride, apiFormat: apiFormatOverride } = params;

  if (!provider || !apiKey) return null;

  const providerType = provider.toLowerCase() as ProviderType;
  if (!VALID_PROVIDERS.includes(providerType)) return null;

  // For custom provider, baseUrl is required.
  if (providerType === 'custom' && !baseUrlOverride?.trim()) return null;

  const model = (modelOverride?.trim() || DEFAULT_MODELS[providerType]).trim();
  const baseUrl = (baseUrlOverride?.trim() || DEFAULT_BASE_URLS[providerType]).replace(/\/+$/, '');

  // Resolve API format: explicit override > default for provider type
  let apiFormat: ApiFormat = DEFAULT_API_FORMATS[providerType];
  if (apiFormatOverride === 'anthropic-messages') {
    apiFormat = 'anthropic-messages';
  } else if (apiFormatOverride === 'openai-chat') {
    apiFormat = 'openai-chat';
  }

  return {
    provider: createProvider(providerType, { apiKey, model, baseUrl, apiFormat }),
    model,
    providerType,
    baseUrl,
    apiFormat,
  };
}

// Fetch available models from an OpenAI-compatible /models endpoint.
export async function fetchModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const url = baseUrl.replace(/\/+$/, '') + '/models';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let errMsg = text;
      try {
        const parsed = JSON.parse(text);
        errMsg = parsed?.error?.message || parsed?.message || text;
      } catch { /* not JSON */ }
      throw new Error(`Fetch models error (${res.status}): ${errMsg}`);
    }

    const data = await res.json();
    const models: string[] = (data?.data || []).map((m: { id?: string }) => m.id).filter(Boolean).sort();
    return models;
  } finally {
    clearTimeout(timeout);
  }
}

// Re-export types for convenience
export { type LLMProvider, type ProviderType, type ApiFormat, type ChatMessage, type GenerateRequest, type GenerateResponse } from './types';
