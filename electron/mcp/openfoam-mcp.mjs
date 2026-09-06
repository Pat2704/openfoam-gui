#!/usr/bin/env node
/**
 * The agent's hands: an MCP server that exposes OpenFOAM Studio's own actions.
 *
 * The app launches Claude Code with every built-in tool switched off and this
 * server as its ONLY tool source (see src/lib/claude-cli.ts), so this file is
 * the complete list of what the agent can do. Each call is forwarded to the
 * running app's /api/agent/tools endpoint, which is where the policy lives -
 * the allowlist of executables, the run-directory confinement, and the
 * activity log. Editing this file cannot widen what the agent may do; it only
 * changes what it can ask for.
 *
 * NO DEPENDENCIES ON PURPOSE. The packaged .exe ships no node_modules, so a
 * bridge that imported the MCP SDK could not run from the installed app. The
 * protocol needed here is small: newline-delimited JSON-RPC 2.0 with three
 * methods (initialize, tools/list, tools/call), which is what this implements.
 *
 * It is spawned by the app, with the bundled node.exe, and told where to call
 * back through the environment - so there is no connection file on disk that
 * could go stale, and no setup step for the user.
 */

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
const definitions = JSON.parse(readFileSync(new URL('./openfoam-tools.json', import.meta.url), 'utf8'));

const PROTOCOL_FALLBACK = '2025-06-18';

/**
 * Where the app is listening, and the token it expects.
 *
 * Both are handed over by the app when it spawns this process. The port is not
 * guessable in the packaged app - it binds port 0 and gets a different one every
 * launch - so an empty PORT here means `npm run dev`, which always uses 3000.
 */
const PORT = Number(process.env.OFSTUDIO_PORT) || 3000;
const TOKEN = process.env.OFSTUDIO_AGENT_TOKEN || '';
/**
 * Guarded or unrestricted, decided by the app when it launched this process.
 *
 * It travels in the environment rather than in the tool arguments precisely so
 * the model cannot set it: everything the model writes arrives as `args`.
 */
const MODE = process.env.OFSTUDIO_AGENT_MODE === 'unrestricted' ? 'unrestricted' : 'guarded';

const TOOLS = definitions.map(({ unrestrictedDescription, ...tool }) => ({
  ...tool, description: MODE === "unrestricted" && unrestrictedDescription ? unrestrictedDescription : tool.description,
}));

async function callApp(tool, args) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/agent/tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, mode: MODE, tool, args }),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (data.error) return { text: data.error, isError: true };
  return { text: typeof data.text === 'string' ? data.text : JSON.stringify(data), isError: false };
}

// ── JSON-RPC over stdio ─────────────────────────────────────────────────────

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;

  // Notifications carry no id and expect no answer.
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      reply(id, {
        // Echo the client's version when it names one: the client picked a
        // version it can speak, and this bridge uses nothing version-specific.
        protocolVersion:
          typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: 'openfoam-studio', version: '1.4.0' },
      });
      return;

    case 'ping':
      reply(id, {});
      return;

    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      if (!TOOLS.some(t => t.name === name)) {
        replyError(id, -32602, `unknown tool: ${name}`);
        return;
      }
      try {
        const { text, isError } = await callApp(name, args);
        reply(id, { content: [{ type: 'text', text }], isError });
      } catch (err) {
        // A connection failure almost always means the app is not running.
        reply(id, {
          content: [{
            type: 'text',
            text:
              `Cannot reach OpenFOAM Studio on port ${PORT} (${err?.message || err}). ` +
              'This server drives the running application rather than replacing it.',
          }],
          isError: true,
        });
      }
      return;
    }

    default:
      replyError(id, -32601, `method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;                       // not our business; ignore malformed frames
  }
  handle(msg).catch(err => {
    if (msg && msg.id !== undefined) replyError(msg.id, -32603, String(err?.message || err));
  });
});
