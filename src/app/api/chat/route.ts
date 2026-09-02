import { NextRequest, NextResponse } from 'next/server';
import { getOpenFOAMVersion, readCaseFilesDeep, type CaseFileSlice } from '@/lib/wsl';
import { apiError } from '@/lib/api-response';
import { validateCaseName } from '@/lib/wsl-input';
import { resolveLLMConfig, fetchModels } from '@/lib/llm';
import {
  ensureFoamIndex, getFoamIndexIfReady, renderSlices, topicsFor, typesMentioned,
} from '@/lib/foam-index';
import { findExamples, renderExamples } from '@/lib/foam-examples';
import {
  ensureCorpus, getCorpusIfReady, renderExcerpts, selectExcerpts,
} from '@/lib/foam-retrieval';

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

GROUND TRUTH FROM THE INSTALLATION (HARD RULE):
Some messages carry a block headed "[Ground truth from the installed OpenFOAM …]". Those lists are read from the user's own installation with foamToC, so for what they cover they are COMPLETE and AUTHORITATIVE — more reliable than your own recollection, which is dominated by older versions and by the ESI variant.
When such a list is present, pick names ONLY from it. If what the user needs is not in the list, say so plainly instead of offering a name from another version: that name does not exist here and the case will not start.
When no list is present, say that you are going from memory and suggest verifying the name.

TRUNCATED FILES (HARD RULE):
A file in the case context may be marked "TRUNCATED — first N of M bytes". You are seeing only its beginning.
NEVER emit an apply: block for a truncated file: rewriting it whole would silently DELETE the part you were not shown.
Instead, name the file and ask the user to open it in the File Editor — an open file is sent to you in full — or to make the change there themselves.
The same rule applies to any file you have not been shown at all: ask for it, do not reconstruct it from memory.

LENGTH:
If a complete file would be too long to fit in one reply, say so and propose a different approach (for example changing a smaller file, or splitting the work across several replies, one file each). A reply that gets cut off mid-file is worse than no reply, because the user may apply it.

Reply in the same language the user writes in, concisely and technically.`;
}

/**
 * Total size of the case context, in characters.
 *
 * Roughly 60k tokens — large enough for any normal case (a few dozen
 * dictionaries rarely reach 100 KB) and small enough that a case carrying an
 * ASCII STL in constant/triSurface cannot quietly blow up the request. What
 * does not fit is LISTED rather than dropped in silence.
 */
const CASE_CONTEXT_BUDGET = 240_000;

/**
 * Turn the raw file slices into the block that goes into the prompt.
 *
 * Two things matter here, and both exist because FOAMy replies with whole
 * files: a file that was cut must SAY it was cut, and a file that did not fit
 * at all must still be mentioned, so the model asks for it instead of
 * inventing it.
 */
function buildCaseContext(files: CaseFileSlice[]): {
  context: string;
  stats: { included: number; truncated: number; omitted: number; bytes: number };
} {
  // Small dictionaries first: the ones that describe the case are what matter,
  // and a single huge file should never push twenty small ones out.
  const ordered = [...files].sort((a, b) => a.content.length - b.content.length);

  const parts: string[] = [];
  const omitted: CaseFileSlice[] = [];
  let used = 0;
  let truncated = 0;

  for (const f of ordered) {
    const header = f.truncated
      ? `=== ${f.path} (TRUNCATED — first ${f.content.length} of ${f.bytes} bytes) ===`
      : `=== ${f.path} (${f.bytes} bytes) ===`;
    const block = `${header}\n${f.content}`;
    if (used + block.length > CASE_CONTEXT_BUDGET) { omitted.push(f); continue; }
    parts.push(block);
    used += block.length;
    if (f.truncated) truncated++;
  }

  // Back to a readable order for the model.
  parts.sort();
  const included = parts.length;

  if (omitted.length) {
    parts.push(
      `=== ${omitted.length} file(s) NOT included (context budget) ===\n` +
      omitted.map(f => `${f.path} (${f.bytes} bytes)`).join('\n') +
      `\nAsk the user to open one of these in the File Editor if you need it.`
    );
  }

  return {
    context: parts.join('\n\n'),
    stats: { included, truncated, omitted: omitted.length, bytes: used },
  };
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
      return NextResponse.json({ success: true, ...buildCaseContext(files) });
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

    // Files the user applied since that context was sent. Without this the
    // model keeps reasoning about the version it was shown at the start of the
    // session — including changes it proposed itself and the user accepted.
    const changedFiles: unknown = body?.changedFiles;
    if (Array.isArray(changedFiles) && changedFiles.length) {
      const rendered = changedFiles
        .filter((f): f is { path: string; content: string } =>
          !!f && typeof f.path === 'string' && typeof f.content === 'string')
        .map(f => `=== ${f.path} (current content) ===\n${f.content}`)
        .join('\n\n');
      if (rendered) {
        sections.push(`[Files changed since that context — this is what is on disk NOW]\n${rendered}`);
      }
    }

    // What the installation itself says is valid, for the topics this question
    // touches. Small on purpose: a slice is a few hundred tokens, while the
    // whole index would be ~98k. If the index is not built yet the message goes
    // out without it and the build starts for the next one — a chat message
    // must never wait eight seconds on WSL.
    const foamIndex = getFoamIndexIfReady();
    if (foamIndex) {
      const topics = topicsFor(`${message} ${body?.fileContext?.path || ''}`);
      // Examples from this version's own tutorials. Two paths, in order of
      // quality:
      //
      //   the SELECTOR ranks the whole corpus and keeps the best two chunks —
      //   it answers questions that describe a situation instead of naming a
      //   type, which is most of them;
      //
      //   the grep fallback finds a use of a type the question names literally,
      //   and is what runs until the corpus has been indexed.
      //
      // Both are capped at roughly the same size, so this is a better choice at
      // the same token cost, not a bigger payload.
      let examples = '';
      if (getCorpusIfReady()) {
        examples = renderExcerpts(selectExcerpts(message));
        if (examples) console.log(`[chat] selected examples (${examples.length} chars)`);
      } else {
        void ensureCorpus();
        const mentioned = typesMentioned(foamIndex, message, 2);
        if (mentioned.length) {
          examples = renderExamples(await findExamples(mentioned));
          if (examples) console.log(`[chat] grep examples for ${mentioned.join(', ')} (${examples.length} chars)`);
        }
      }
      if (examples) sections.push(examples);

      const slice = renderSlices(foamIndex, topics, message);
      if (slice) {
        sections.push(slice);
        // One line per message: which lists were attached and how big they were.
        // This is the number to watch if token usage ever looks wrong.
        console.log(`[chat] ground truth: ${topics.join(', ')} (${slice.length} chars ≈ ${Math.round(slice.length / 4)} tokens)`);
      }
    } else {
      void ensureFoamIndex();
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


    const { reply, usage, finishReason } = await llmConfig.provider.generate({
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
      // The client refuses to apply file blocks from a cut-off reply: with the
      // whole-file format, a truncated answer is a truncated FILE.
      truncated: finishReason === 'length',
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
