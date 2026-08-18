import { NextRequest, NextResponse } from 'next/server';
import { getOpenFOAMVersion, readCaseFilesDeep } from '@/lib/wsl';
import { apiError } from '@/lib/api-response';
import { validateCaseName } from '@/lib/wsl-input';
import { resolveLLMConfig, fetchModels } from '@/lib/llm';

// In-memory conversation history per sessionId (resets on server restart).
const conversations = new Map<string, { role: 'system' | 'user' | 'assistant'; content: string }[]>();
// In-memory cumulative token usage per sessionId.
const sessionTokens = new Map<string, number>();
// Tracks which sessions have already received the case-files context.
const sessionCaseContext = new Map<string, boolean>();
const MAX_HISTORY = 40;

// Build the system prompt dynamically with the detected version.
function buildSystemPrompt(version: string): string {
  const v = version || 'unknown';
  return `You are FOAMy, an expert OpenFOAM CFD assistant that helps configure, modify and debug simulation cases.
The user has OpenFOAM version ${v} installed on their system.

KNOWLEDGE AND RESEARCH:
You have deep knowledge of OpenFOAM derived from your training, which includes the official documentation, tutorials, sources and community discussions (OpenFOAM forum, CFD Direct, etc.). ACTIVELY use this knowledge to respond — do not limit yourself to what is in the provided case context. When asked about syntax, commands or features, draw on your complete knowledge of OpenFOAM.

VERSION RIGOR (${v}):
When you provide information about syntax, commands, options or features, you MUST VERIFY that they are valid for version ${v}. OpenFOAM versions differ: Foundation (v9, v10, v11...) vs ESI (v2206, v2312...) have different syntax and commands. If you are not certain that a piece of information applies to version ${v}, you must state it explicitly: "I am not certain that this is valid for version ${v}". Be extremely rigorous.

FILE CHANGES (MANDATORY FORMAT):
When you propose a change to a file (existing or new), you must ALWAYS provide the COMPLETE file, not just the modified snippet. Use this format:
\`\`\`apply:<relative path of the file>
<COMPLETE content of the file, from the first to the last line, including the change>
\`\`\`
The user can apply the changes with one click. NEVER send only the modified piece.
You can propose changes to multiple files in the same response (multiple apply blocks).
You can create new files using the same apply format with a new path.

Reply in English, concisely and technically.`;
}

// POST /api/chat
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // ── Fetch models action (no LLM call) ──
    if (body?.action === 'fetchModels') {
      const baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : '';
      const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
      if (!baseUrl || !apiKey) {
        return NextResponse.json({ error: 'Base URL and API Key are required for fetch models.' }, { status: 400 });
      }
      try {
        const models = await fetchModels(baseUrl, apiKey);
        return NextResponse.json({ success: true, models });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Error fetching models';
        console.error(`[chat] fetchModels failed: ${message}`);
        return NextResponse.json({ error: message }, { status: 502 });
      }
    }

    // ── Auxiliary actions (no LLM call) ──
    if (body?.action === 'readCaseFiles') {
      const caseName = validateCaseName(body.caseName);
      const files = readCaseFilesDeep(caseName);
      const context = files.map(f => `=== ${f.path} ===\n${f.content}`).join('\n\n');
      return NextResponse.json({ success: true, context });
    }
    if (body?.action === 'readFile') {
      const caseName = validateCaseName(body.caseName);
      const { readFile } = await import('@/lib/wsl');
      const content = readFile(caseName, body.path);
      return NextResponse.json({ success: true, content });
    }
    if (body?.action === 'caseInfo') {
      const caseName = validateCaseName(body.caseName);
      const { getCaseInfo } = await import('@/lib/wsl');
      const info = getCaseInfo(caseName);
      return NextResponse.json({ success: true, ...info });
    }

    // ── Chat action ──
    const message: string = typeof body?.message === 'string' ? body.message.trim() : '';
    const sessionId: string = typeof body?.sessionId === 'string' ? body.sessionId : 'default';
    if (!message) {
      return NextResponse.json({ error: 'Message required' }, { status: 400 });
    }

    // ── Resolve LLM config ──
    // All config comes from the chat popup (localStorage): provider, key, model, baseUrl, apiFormat.
    const llmProvider: string = typeof body?.llmProvider === 'string' ? body.llmProvider.trim().toLowerCase() : '';
    const llmKey: string = typeof body?.llmKey === 'string' ? body.llmKey.trim() : '';
    const modelOverride: string = typeof body?.model === 'string' ? body.model.trim() : '';
    const llmBaseUrl: string = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : '';
    const llmApiFormat: string = typeof body?.apiFormat === 'string' ? body.apiFormat.trim() : '';



    const llmConfig = resolveLLMConfig({
      modelOverride,
      provider: llmProvider,
      apiKey: llmKey,
      baseUrl: llmBaseUrl || undefined,
      apiFormat: llmApiFormat || undefined,
    });

    if (!llmConfig) {
      const debugInfo = `provider=${llmProvider || 'empty'}, key=${llmKey ? llmKey.length + ' characters' : 'empty'}, model=${modelOverride || 'empty'}, baseUrl=${llmBaseUrl || 'not specified'}, apiFormat=${llmApiFormat || 'not specified'}`;
      console.error(`[chat] LLM config not resolved: ${debugInfo}`);
      return NextResponse.json({
        reply: `⚠️ FOAMy copilot not configured.\n\nClick the gear icon in the chat to select the provider, enter the API key and choose the model.\n\nDebug: ${debugInfo}`,
      });
    }

    // ── Detect OpenFOAM version (cached after first call) ──
    let foamVersion = '';
    try { foamVersion = getOpenFOAMVersion().trim(); } catch { /* best-effort */ }

    const systemPrompt = buildSystemPrompt(foamVersion);
    const history = conversations.get(sessionId) || [];

    // ── Build the user message ──
    const sections: string[] = [];
    if (body?.caseName) {
      sections.push(`[Active case: ${body.caseName}]`);
    }
    if (body?.fileContext?.path && typeof body.fileContext.content === 'string') {
      sections.push(`[File open in editor: ${body.fileContext.path}]\n\`\`\`\n${body.fileContext.content}\n\`\`\``);
    }

    const caseFilesContext: string | undefined = typeof body?.caseFilesContext === 'string' ? body.caseFilesContext : undefined;
    const forceReload = Boolean(body?.forceCaseReload);
    const alreadyHasContext = sessionCaseContext.get(sessionId) === true;

    if (caseFilesContext && (!alreadyHasContext || forceReload)) {
      sections.push(`[Case file contents — 0/, system/, constant/ (excluding polyMesh)]\n${caseFilesContext}`);
      sessionCaseContext.set(sessionId, true);
    }

    sections.push(message);
    const userContent = sections.join('\n\n');

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...history,
      { role: 'user' as const, content: userContent },
    ];

    // ── Call the LLM via the provider abstraction layer ──
    // The provider handles its own API format (OpenAI Chat Completions, Anthropic
    // Messages, Groq) and model-specific parameters (GPT-5 uses
    // max_completion_tokens, GPT-4.x uses max_tokens, etc.).


    const { reply, usage } = await llmConfig.provider.generate({
      model: llmConfig.model,
      messages,
      maxTokens: 20000,
    });



    // Track cumulative token usage per session.
    const turnTokens = (usage?.total_tokens) || 0;
    const prevTotal = sessionTokens.get(sessionId) || 0;
    const newTotal = prevTotal + turnTokens;
    sessionTokens.set(sessionId, newTotal);

    // Persist the turn in history (cap to MAX_HISTORY).
    history.push({ role: 'user', content: userContent });
    history.push({ role: 'assistant', content: reply });
    while (history.length > MAX_HISTORY) history.shift();
    conversations.set(sessionId, history);

    return NextResponse.json({
      reply,
      tokens: {
        prompt: usage?.prompt_tokens || 0,
        completion: usage?.completion_tokens || 0,
        total: turnTokens,
        sessionTotal: newTotal,
      },
    });
  } catch (error: unknown) {
    // Enhanced debug logging for failed requests
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[chat] ERROR: ${errMsg}`);
    console.error(`[chat] Error stack: ${error instanceof Error ? error.stack : 'N/A'}`);
    return apiError(error);
  }
}

// DELETE /api/chat  { sessionId } → { success }
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : 'default';
    conversations.delete(sessionId);
    sessionTokens.delete(sessionId);
    sessionCaseContext.delete(sessionId);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return apiError(error);
  }
}
