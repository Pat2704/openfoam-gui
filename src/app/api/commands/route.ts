import { NextRequest, NextResponse } from 'next/server';
import { executeCommandAsync } from '@/lib/wsl';
import { apiError } from '@/lib/api-response';
import { validateCaseName, boundedInteger } from '@/lib/wsl-input';
import { ensureCatalog, getCatalogIfReady } from '@/lib/foam-commands';

// POST /api/commands
//   { caseName, command, parallel?, nProcs?, background?, stream? }
//   → { success, output, message, exitCode }
//   → with stream: true, newline-delimited JSON as the command runs:
//       {"t":"out","d":"…"}   a chunk of stdout or stderr, in the order it came
//       {"t":"end","exitCode":0,"output":"…"}
//       {"t":"error","message":"…"}
//
// Why streaming exists: a command in the foreground used to be invisible until
// it finished, so a three-minute snappyHexMesh was indistinguishable from a
// hung app. executeCommandAsync has always taken an onLog callback and nobody
// passed one — this is that callback, reaching the browser.
//
// `output` on the end event is the resolved result, and it matters for the
// BACKGROUND path: that one streams nothing and reports a single line ("started
// in background, PID …"), so the client uses it when no chunk arrived.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const caseName = validateCaseName(body?.caseName);
    const command = typeof body?.command === 'string' ? body.command.trim() : '';
    if (!command) {
      return NextResponse.json({ error: 'Command required' }, { status: 400 });
    }
    const _parallel = Boolean(body?.parallel);
    const nProcs = boundedInteger(body?.nProcs, 1, 1, 4096);
    const background = Boolean(body?.background);
    void _parallel; // parallel decomposes the case upstream (mpirun) when enabled
    void nProcs;    // currently forwarded via the command string by the client

    // Background commands are those whose string ends with '&' OR explicitly
    // flagged as background — executeCommandAsync handles the nohup wrapper.
    const fullCommand = background && !command.endsWith('&') ? `${command} &` : command;

    if (body?.stream === true) {
      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        start(controller) {
          let closed = false;
          const send = (obj: unknown) => {
            if (closed) return;
            try { controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n')); } catch { closed = true; }
          };
          const close = () => { if (!closed) { closed = true; try { controller.close(); } catch { /* already gone */ } } };

          executeCommandAsync(caseName, fullCommand, chunk => send({ t: 'out', d: chunk }))
            .then(result => {
              send({ t: 'end', exitCode: result.exitCode, output: result.output });
              close();
            })
            .catch((e: unknown) => {
              send({ t: 'error', message: e instanceof Error ? e.message : String(e) });
              close();
            });
        },
      });

      return new Response(readable, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          // Nothing proxies this in the packaged app, but the header costs
          // nothing and is what stops a proxy holding the chunks back.
          'X-Accel-Buffering': 'no',
        },
      });
    }

    const result = await executeCommandAsync(caseName, fullCommand);
    const success = result.exitCode === 0;
    return NextResponse.json({
      success,
      output: result.output,
      message: success ? 'Command completed' : `Command terminated (exit ${result.exitCode})`,
      exitCode: result.exitCode,
    });
  } catch (error: unknown) {
    return apiError(error);
  }
}

// GET /api/commands?action=catalog[&build=1]
//   → { ready, building, version, commands: [{ name, category, description, … }] }
//
// The command list the sidebar shows, read from the installation itself
// (see src/lib/foam-commands.ts). It answers immediately with whatever is
// cached and starts a build when there is nothing, so the panel is never
// blocked on WSL — it renders the static fallback for those two seconds.
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    if (searchParams.get('action') !== 'catalog') {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }

    if (searchParams.get('build') === '1') {
      const built = await ensureCatalog(searchParams.get('force') === '1');
      if (!built) return NextResponse.json({ ready: false, building: false, commands: [] });
      return NextResponse.json({ ready: true, building: false, ...built });
    }

    const catalog = getCatalogIfReady();
    if (!catalog) {
      void ensureCatalog();
      return NextResponse.json({ ready: false, building: true, commands: [] });
    }
    return NextResponse.json({ ready: true, building: false, ...catalog });
  } catch (error: unknown) {
    return apiError(error);
  }
}
