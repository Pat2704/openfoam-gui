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

const TOOLS = [
  {
    name: 'list_cases',
    description: 'List the OpenFOAM cases in the run directory ($FOAM_RUN).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'case_info',
    description: 'Summary of one case: directories, time steps, whether it has a mesh.',
    inputSchema: {
      type: 'object',
      properties: { case: { type: 'string', description: 'Case name' } },
      required: ['case'],
    },
  },
  {
    name: 'list_case_files',
    description: 'List files and directories inside a case. Omit path for the case root.',
    inputSchema: {
      type: 'object',
      properties: {
        case: { type: 'string' },
        path: { type: 'string', description: 'Relative directory, e.g. "system" or "0"' },
      },
      required: ['case'],
    },
  },
  {
    name: 'read_case_file',
    description: 'Read one file from a case, e.g. 0/U or system/controlDict.',
    inputSchema: {
      type: 'object',
      properties: { case: { type: 'string' }, path: { type: 'string' } },
      required: ['case', 'path'],
    },
  },
  {
    name: 'write_case_file',
    description:
      'Write one file in a case, creating parent directories as needed. Confined to the run ' +
      'directory. Check the result with validate_case_files afterwards.',
    inputSchema: {
      type: 'object',
      properties: { case: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' } },
      required: ['case', 'path', 'content'],
    },
  },
  {
    name: 'run_openfoam',
    description: MODE === 'unrestricted'
      ? 'Run a command inside a case directory, in WSL. UNRESTRICTED MODE is on: this is a real ' +
        'shell — any command, pipes, redirects and chaining all work. The one thing still refused ' +
        'is the Windows disk: paths under /mnt/ are out of bounds, because that is the user\'s own ' +
        'documents and this application\'s files, and no OpenFOAM work needs them. Everything ' +
        'inside WSL is yours. Say what you are about to run before running anything destructive. ' +
        'Use background: true for long solves. Returns the exit code and the last lines of output.'
      : 'Run one OpenFOAM executable inside a case (blockMesh, checkMesh, foamRun, snappyHexMesh, ' +
        'decomposePar, Allrun, …). Only executables this installation actually ships are accepted, ' +
        'and shell syntax (pipes, redirects, chaining) is refused. For a parallel run write exactly ' +
        '"mpirun -np <n> <command> -parallel". Use background: true for long solves instead of a ' +
        'trailing "&". Returns the exit code and the last lines of output.',
    inputSchema: {
      type: 'object',
      properties: {
        case: { type: 'string' },
        command: { type: 'string', description: 'e.g. "blockMesh" or "foamRun"' },
        background: { type: 'boolean', description: 'Detach and return immediately' },
      },
      required: ['case', 'command'],
    },
  },
  {
    name: 'validate_case_files',
    description:
      'Check files against THIS OpenFOAM installation: every type/model/solver name against the ' +
      'run-time selection tables, and the syntax through OpenFOAM\'s own parser. Use it after ' +
      'writing, before running.',
    inputSchema: {
      type: 'object',
      properties: {
        case: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' }, description: 'e.g. ["0/U", "system/controlDict"]' },
      },
      required: ['case', 'paths'],
    },
  },
  {
    name: 'foam_lookup',
    description:
      'Ask the installation what is valid. With "name": whether that type exists here, which ' +
      'tables it belongs to, and which dictionary keys it accepts. With "kind": the whole list ' +
      '(solvers, scalarBCs, vectorBCs, functionObjects, fvModels, fvConstraints, applications). ' +
      'This is ground truth for the installed version — prefer it over recollection.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A type name, e.g. nutkWallFunction' },
        kind: { type: 'string', description: 'A list to dump instead' },
      },
    },
  },
  {
    name: 'foam_help',
    description:
      'What a command or type actually IS on this installation, and where the answer came from. ' +
      'Looks in three places in order: the installation index, then the command\'s own -help run in ' +
      'WSL, then the web - the last only if the first two found nothing (or if web:true forces it). ' +
      'Every finding is labelled with its source. USE THIS instead of recalling what an option does: ' +
      'your memory of OpenFOAM is dominated by older versions and by the ESI fork, and this reads the ' +
      'binaries on the user\'s disk. Whatever you take from it, tell the user where it came from.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A command or type name, e.g. snappyHexMesh' },
        question: { type: 'string', description: 'What you want to know, for the web query if it comes to that' },
        web: { type: 'boolean', description: 'Search the web even if the installation answered' },
      },
      required: ['name'],
    },
  },
  {
    name: 'search_tutorials',
    description:
      'Find the closest real examples in the tutorials shipped with this installation. Useful for ' +
      '"how is this normally written".',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

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
