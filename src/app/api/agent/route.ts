import { buildSystemPrompt } from '@/lib/agent-prompt';
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-response';
import { getOpenFOAMVersion } from '@/lib/wsl';
import { allowedCommands, recentActivity } from '@/lib/agent-policy';
import { getFoamIndexIfReady } from '@/lib/foam-index';
import { getCorpusIfReady } from '@/lib/foam-retrieval';
import {
  findClaude, authStatus, startLogin, submitLoginCode, loginState, logout,
  send, unsubscribe, interrupt, endSession, probeReport,
  EFFORTS, type Effort, type AgentEventOut,
} from '@/lib/claude-cli';

/**
 * The Claude agent's endpoint: status, sign-in, and the conversation itself.
 *
 * A turn is streamed as Server-Sent Events rather than answered in one piece,
 * because an agent turn is not one answer — it is thinking, then a tool call,
 * then its result, then more of the same, and a solve can run for minutes. The
 * panel renders those as they happen; a JSON reply would show a spinner and
 * then a wall of text.
 */

/**
 * What the agent is told about the machine it is working on.
 *
 * Kept short on purpose. The ground truth about this OpenFOAM version is
 * available to it through foam_lookup and search_tutorials, which read the real
 * installation — repeating a summary here would only give it something to
 * contradict.
 */
// ── GET: status, activity log, sign-in progress ─────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const action = new URL(req.url).searchParams.get('action') || 'status';

    if (action === 'log') {
      return NextResponse.json({ events: recentActivity() });
    }
    if (action === 'login') {
      return NextResponse.json(loginState());
    }

    // `refresh` forces a fresh search: the panel's "Look again" must actually
    // look again, not re-read a remembered failure.
    const params = new URL(req.url).searchParams;
    const force = params.get('refresh') === '1';
    const install = await findClaude({ force, explicitPath: params.get('path') || '' });
    const auth = install ? await authStatus() : { loggedIn: false };
    return NextResponse.json({
      installed: Boolean(install),
      path: install?.path || '',
      version: install?.version || '',
      source: install?.source || '',
      auth,
      // Empty when it was found. When it was not, this is the only way anyone
      // can tell WHY — including the user, in the panel.
      probe: install ? [] : probeReport(),
      commands: allowedCommands().size,
      indexReady: Boolean(getFoamIndexIfReady()),
      corpusReady: Boolean(getCorpusIfReady()),
    });
  } catch (error: unknown) {
    return apiError(error);
  }
}

// ── POST: sign-in actions, interrupt, and the conversation ──────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = typeof body?.action === 'string' ? body.action : 'chat';
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : 'default';

    // Every action that needs the binary passes the panel's own path through,
    // so a machine where the automatic search cannot reach it still works.
    const explicitPath = typeof body?.claudePath === 'string' ? body.claudePath : '';
    if (action === 'login') { await findClaude({ explicitPath }); return NextResponse.json(await startLogin()); }
    if (action === 'loginCode') {
      const code = typeof body?.code === 'string' ? body.code : '';
      return NextResponse.json({ sent: submitLoginCode(code) });
    }
    if (action === 'logout') return NextResponse.json({ ok: await logout() });
    if (action === 'interrupt') return NextResponse.json({ ok: interrupt(sessionId) });
    if (action === 'end') { endSession(sessionId); return NextResponse.json({ ok: true }); }

    // ── chat ──
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) return NextResponse.json({ error: 'Message required' }, { status: 400 });

    const install = await findClaude({ explicitPath });
    if (!install) {
      return NextResponse.json({
        error: 'No Claude Code executable could be reached. Install it, or set its path in the panel.',
      }, { status: 400 });
    }
    if (!(await authStatus()).loggedIn) {
      return NextResponse.json({ error: 'Not signed in to your Claude account.' }, { status: 401 });
    }

    const model = typeof body?.model === 'string' ? body.model : 'sonnet';
    const rawEffort = typeof body?.effort === 'string' ? body.effort : 'high';
    const effort = (EFFORTS as readonly string[]).includes(rawEffort) ? (rawEffort as Effort) : 'high';
    const caseName = typeof body?.caseName === 'string' ? body.caseName : '';
    const unrestricted = body?.unrestricted === true;

    let foamVersion = '';
    try { foamVersion = getOpenFOAMVersion().trim(); } catch { /* best effort */ }

    const encoder = new TextEncoder();
    let listener: ((event: AgentEventOut) => void) | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const write = (event: AgentEventOut) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch { closed = true; }
        };

        listener = (event: AgentEventOut) => {
          write(event);
          // A turn ends at `done`; the child stays alive for the next message.
          if (event.t === 'done') {
            closed = true;
            unsubscribe(sessionId, listener!);
            try { controller.close(); } catch { /* already closed */ }
          }
        };

        const started = send(
          {
            sessionId,
            message,
            model,
            effort,
            unrestricted,
            systemPrompt: buildSystemPrompt(foamVersion, caseName, unrestricted),
            caseName,
          },
          listener,
        );

        if (!started.ok) {
          write({ t: 'error', message: started.error });
          write({ t: 'done', ok: false, text: '', turns: 0, durationMs: 0, costUsd: 0 });
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
        }
      },
      cancel() {
        // The page went away mid-turn. Stop listening, but let the agent finish:
        // it may be halfway through writing a file, and killing it there is worse
        // than letting it complete into the activity log.
        if (listener) unsubscribe(sessionId, listener);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // The packaged app is served through a plain Node server, but this
        // costs nothing and stops any proxy from buffering the stream.
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error: unknown) {
    return apiError(error);
  }
}
