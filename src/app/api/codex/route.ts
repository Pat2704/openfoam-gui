import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-response';
import { codexStatus, startLogin, loginState, logout, send, interrupt, endSession, unsubscribe } from '@/lib/codex-cli';
import { buildSystemPrompt } from '@/lib/agent-prompt';
import { getOpenFOAMVersion } from '@/lib/wsl';
import { allowedCommands, recentActivity } from '@/lib/agent-policy';
import { getFoamIndexIfReady } from '@/lib/foam-index';
import { getCorpusIfReady } from '@/lib/foam-retrieval';
import type { PanelEvent } from '@/lib/codex-protocol';

export async function GET(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams;
    if (p.get('action') === 'login') return NextResponse.json(loginState());
    if (p.get('action') === 'log') return NextResponse.json({ events: recentActivity() });
    return NextResponse.json({ ...await codexStatus(p.get('path') || '', p.get('refresh') === '1'),
      commands: allowedCommands().size, indexReady: Boolean(getFoamIndexIfReady()), corpusReady: Boolean(getCorpusIfReady()) });
  } catch (e) { return apiError(e); }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const path = typeof body.codexPath === 'string' ? body.codexPath : '';
    const id = typeof body.sessionId === 'string' ? body.sessionId : 'default';
    if (body.action === 'login') return NextResponse.json(await startLogin(path));
    if (body.action === 'logout') return NextResponse.json({ ok: await logout() });
    if (body.action === 'interrupt') return NextResponse.json({ ok: await interrupt(id) });
    if (body.action === 'end') { await endSession(id); return NextResponse.json({ ok: true }); }
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return NextResponse.json({ error: 'Message required' }, { status: 400 });
    const status = await codexStatus(path);
    if (!status.auth.loggedIn) return NextResponse.json({ error: 'Sign in with your ChatGPT account first.' }, { status: 401 });
    const model = status.models.find(m => m.id === body.model);
    if (!model || !model.efforts.some(e => e.id === body.effort)) {
      return NextResponse.json({ error: 'Choose an available Codex model and reasoning level.' }, { status: 400 });
    }
    let version = ''; try { version = getOpenFOAMVersion().trim(); } catch { /* installation may be starting */ }
    const prompt = buildSystemPrompt(version, typeof body.caseName === 'string' ? body.caseName : '', body.unrestricted === true)
      .split('Claude').join('Codex');
    const encoder = new TextEncoder(); let listener: ((e: PanelEvent) => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        listener = event => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { closed = true; }
          if (event.t === 'done') { closed = true; if (listener) unsubscribe(id, listener); try { controller.close(); } catch { /* gone */ } }
        };
        void send({ sessionId: id, message, model: model.id, effort: body.effort,
          systemPrompt: prompt, unrestricted: body.unrestricted === true }, listener).catch(e => {
          listener?.({ t: 'error', message: e instanceof Error ? e.message : String(e) });
          listener?.({ t: 'done', ok: false });
        });
      },
      // Disconnecting the panel must not kill a write already in progress.
      cancel() { if (listener) unsubscribe(id, listener); },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } });
  } catch (e) { return apiError(e); }
}
