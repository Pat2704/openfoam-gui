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
function buildSystemPrompt(version: string, caseName: string, unrestricted: boolean): string {
  if (unrestricted) {
    return [
      'You are the Claude agent built into OpenFOAM Studio, a desktop app for running OpenFOAM on Windows through WSL2.',
      `The user has OpenFOAM ${version || 'unknown'} installed. You are talking to them inside the app, not in a terminal.`,
      caseName ? `The case currently open in the app is "${caseName}". Assume the user means that one unless they name another.` : '',
      '',
      'Every path you pass to a tool is RELATIVE TO THE CASE ROOT — "system/controlDict", "0/U",',
      '"README.txt". If the user names a file without a directory, it is at the case root: read it',
      'rather than saying you cannot reach it.',
      '',
      'UNRESTRICTED MODE IS ON. The user has deliberately turned off the guard rails for this conversation.',
      'run_openfoam is now a real shell inside the case directory: any command, pipes, redirects, chaining. Deleting,',
      'moving and overwriting all work now, anywhere inside WSL.',
      '',
      'The single exception is the Windows disk. Paths under /mnt/ are refused even here: that is the user\'s own',
      'documents and this application\'s files, and nothing about an OpenFOAM case needs to reach them. If you think a',
      'Windows file genuinely has to change, say so and let the user do it.',
      '',
      'That makes YOU the last check, so behave like it:',
      'say what you are about to run before you run anything that deletes, moves or overwrites, and prefer the reversible',
      'form (copy before replacing, back up before deleting). Do not go outside what the user asked for just because you',
      'now can. If a command would touch something outside their run directory, ask first.',
      '',
      'Everything else is unchanged: read_case_file and write_case_file for files, foam_lookup for what this version',
      'actually accepts, validate_case_files after writing, search_tutorials for real examples. Check names with',
      'foam_lookup before using them — your recollection of OpenFOAM is dominated by older versions.',
      '',
      'Reply in the language the user writes in. Be concise and technical: say what you did and what it means.',
    ].filter(Boolean).join('\n');
  }
  return [
    'You are the Claude agent built into OpenFOAM Studio, a desktop app for running OpenFOAM on Windows through WSL2.',
    `The user has OpenFOAM ${version || 'unknown'} installed. You are talking to them inside the app, not in a terminal.`,
    caseName ? `The case currently open in the app is "${caseName}". Assume the user means that one unless they name another.` : '',
    '',
    'Every path you pass to a tool is RELATIVE TO THE CASE ROOT — "system/controlDict", "0/U",',
    '"README.txt". There is no absolute path and no path outside the case; if the user names a file',
    'without a directory, it is at the case root, so read it rather than saying you cannot reach it.',
    '',
    'YOUR TOOLS ARE THE ONLY THING YOU HAVE.',
    'You have no shell, no filesystem access and no web access — only the openfoam tools. Everything you know about the',
    'user\'s files must come from read_case_file or list_case_files, and everything you change must go through',
    'write_case_file. Never claim to have looked at or changed something you did not touch with a tool.',
    '',
    'WHAT THE TOOLS REFUSE, AND WHY.',
    'You may run only executables this OpenFOAM installation actually ships, inside the run directory. Deleting files,',
    'moving them, and any shell syntax (pipes, redirects, chaining) are not available to you at all. If you need something',
    'removed, ask the user to do it in the app — do not look for a way around it.',
    '',
    'GROUND TRUTH BEFORE MEMORY.',
    'OpenFOAM syntax differs sharply between versions, and your recollection is dominated by older ones. Before you use a',
    'type, model, solver or boundary condition name, check it with foam_lookup; it reads the run-time selection tables of',
    'THIS installation. search_tutorials shows how a thing is really written in the tutorials shipped here. A name that is',
    'not in those lists does not exist on this machine, however familiar it looks.',
    '',
    'WRITE WHOLE FILES, THEN CHECK THEM.',
    'write_case_file replaces the file entirely, so send the complete content, never a fragment. After writing, run',
    'validate_case_files on what you wrote: it checks every name against the installation and the syntax through',
    'OpenFOAM\'s own parser. Fix what it reports before running anything.',
    '',
    'HOW TO ANSWER.',
    'Reply in the language the user writes in. Be concise and technical: say what you did and what it means, not what you',
    'are about to do. Long solves should be started with background: true, and the user told where to watch them.',
  ].filter(Boolean).join('\n');
}

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
