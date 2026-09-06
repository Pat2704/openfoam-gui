/** Optional contract test against an installed CLI; all model replies are local fixtures.
 * OFSTUDIO_TEST_CODEX=<absolute codex.exe> npm test
 * No subscription tokens, API calls or OpenFOAM cases are used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { CODEX_CONFIG } from '../src/lib/codex-protocol';
import { Rpc } from '../src/lib/codex-rpc';

test('real Codex exposes only the shared tools, calls them, resumes, and interrupts', {
  skip: !process.env.OFSTUDIO_TEST_CODEX, timeout: 60000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofstudio-codex-contract-'));
  const definitions = JSON.parse(readFileSync(new URL('../electron/mcp/openfoam-tools.json', import.meta.url), 'utf8'));
  const requests: any[] = [];
  const notices: any[] = [];
  let hold = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw); requests.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (hold) { res.write(': waiting\n\n'); return; }
    const output = requests.length === 1 ? [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_case_file', arguments: '{"case":"fixture","path":"system/controlDict"}' }] : [];
    const event = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    for (const item of output) event({ type: 'response.output_item.done', output_index: 0, item });
    event({ type: 'response.completed', response: { id: `resp_${requests.length}`, status: 'completed', output,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const config = { ...CODEX_CONFIG, model_provider: 'fixture',
    'model_providers.fixture.name': 'Fixture', 'model_providers.fixture.base_url': `http://127.0.0.1:${port}/v1`,
    'model_providers.fixture.wire_api': 'responses', 'model_providers.fixture.requires_openai_auth': false };
  const args = ['app-server', '--listen', 'stdio://'];
  for (const [k, v] of Object.entries(config)) args.push('-c', `${k}=${typeof v === 'object' ? '{}' : JSON.stringify(v)}`);
  const child = spawn(process.env.OFSTUDIO_TEST_CODEX!, args, { cwd: root, env: { ...process.env, CODEX_HOME: root }, windowsHide: true });
  let calls = 0;
  const rpc = new Rpc(child, msg => {
    notices.push(msg);
    if (msg.method === 'item/tool/call') {
      calls++;
      rpc.write({ id: msg.id, result: { success: true, contentItems: [{ type: 'inputText', text: 'application foamRun;' }] } });
    }
  }, () => {});
  const waitFor = async (predicate: () => boolean) => {
    const until = Date.now() + 15000;
    while (!predicate()) { if (Date.now() > until) throw new Error('Timed out waiting for Codex event'); await new Promise(r => setTimeout(r, 25)); }
  };
  try {
    await rpc.request('initialize', { clientInfo: { name: 'openfoam_studio_test', version: '1.0' }, capabilities: { experimentalApi: true } });
    rpc.write({ method: 'initialized' });
    const started = await rpc.request('thread/start', { model: 'gpt-5.4', environments: [], sandbox: 'read-only', approvalPolicy: 'never',
      baseInstructions: 'Use the supplied OpenFOAM functions.', dynamicTools: definitions.map((t: any) => ({ type: 'function', name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    const threadId = started.thread.id;
    await rpc.request('turn/start', { threadId, environments: [], input: [{ type: 'text', text: 'Read the fixture', text_elements: [] }] });
    await waitFor(() => notices.some(n => n.method === 'turn/completed'));
    assert.equal(calls, 1);
    for (const body of requests) assert.deepEqual(body.tools.map((t: any) => t.name).sort(), definitions.map((t: any) => t.name).sort());
    assert.ok(requests[1].input.some((i: any) => i.type === 'function_call_output' && JSON.stringify(i).includes('application foamRun;')));
    await rpc.request('thread/unsubscribe', { threadId });
    await rpc.request('thread/resume', { threadId, baseInstructions: 'Mode changed; retain the conversation.' });
    hold = true;
    const next = await rpc.request('turn/start', { threadId, environments: [], effort: 'high', input: [{ type: 'text', text: 'Continue', text_elements: [] }] });
    await waitFor(() => requests.length >= 3);
    assert.ok(JSON.stringify(requests[2]).includes('Mode changed; retain the conversation.'));
    await rpc.request('turn/interrupt', { threadId, turnId: next.turn.id });
    await waitFor(() => notices.some(n => n.method === 'turn/completed' && n.params.turn.status === 'interrupted'));
  } finally {
    rpc.close(); server.closeAllConnections(); server.close();
    await new Promise<void>(r => { if (child.exitCode !== null) r(); else child.once('exit', () => r()); });
    // Delete only the disposable directory created above, never a Codex home.
    assert.equal(resolve(dirname(root)), resolve(tmpdir()));
    assert.ok(root.includes('ofstudio-codex-contract-'));
    rmSync(root, { recursive: true, force: true });
  }
});
