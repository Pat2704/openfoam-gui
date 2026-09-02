/**
 * What the Claude agent is allowed to do, and the record of what it did.
 *
 * The agent runs as a Claude Code process the app itself launches (see
 * src/lib/claude-cli.ts). Every built-in tool of that process is switched OFF,
 * so the ONLY way it can touch anything is the small MCP server in
 * electron/mcp/openfoam-mcp.mjs, which forwards each call to /api/agent/tools,
 * which calls straight into this file.
 *
 * The policy therefore lives HERE, on the app's side of the boundary, and
 * neither half of the agent can widen it: the bridge holds schemas and no
 * authority, the agent holds neither.
 *
 * Three rules define that policy - they are the ones the user chose:
 *
 *   1. Everything is addressed by CASE NAME, never by absolute path. Case
 *      names and relative paths go through the same validators the UI uses, so
 *      nothing outside $FOAM_RUN is reachable - not by `..`, not by symlink,
 *      not by an absolute path in an argument.
 *   2. Execution is an ALLOWLIST, built from the executables this installation
 *      actually ships (the 151 the index found) plus the case's own Allrun /
 *      Allclean. There is no free shell: `rm -rf` is not expressible.
 *   3. Every call is recorded, and the app shows the log. The user chose no
 *      per-action confirmations, so visibility after the fact is the safeguard.
 */

import {
  listCases, listDirectory, readFile, writeFile, executeCommandAsync, getCaseInfo,
} from '@/lib/wsl';
import { validateCaseName, validateRelativePath } from '@/lib/wsl-input';
import {
  ensureFoamIndex, getFoamIndexIfReady, validateDictText, checkDictSyntax, suggest,
} from '@/lib/foam-index';
import { getCorpusIfReady, renderExcerpts, selectExcerpts } from '@/lib/foam-retrieval';

/** In-memory activity log, newest last. Survives as long as the server does. */
export interface AgentEvent {
  at: string;
  tool: string;
  summary: string;
  ok: boolean;
}
const activity: AgentEvent[] = [];
const MAX_ACTIVITY = 200;

export function recentActivity(limit = 50): AgentEvent[] {
  return activity.slice(-limit).reverse();
}

export function activityCount(): number {
  return activity.length;
}

function record(tool: string, summary: string, ok: boolean): void {
  activity.push({ at: new Date().toISOString(), tool, summary, ok });
  if (activity.length > MAX_ACTIVITY) activity.shift();
}

/**
 * Commands an agent may run.
 *
 * Anything OpenFOAM installed is fair game — that list came from the
 * installation itself, so it is right for this version without a hand-kept
 * table. The extras are the two scripts every tutorial case carries.
 */
const SCRIPT_COMMANDS = new Set(['Allrun', 'Allclean', 'Allmesh', 'Allpre', 'Allpost']);

/** Fallback for the seconds before the index exists. */
const CORE_COMMANDS = new Set([
  'blockMesh', 'checkMesh', 'foamRun', 'snappyHexMesh', 'surfaceFeatures',
  'decomposePar', 'reconstructPar', 'foamLog', 'foamDictionary', 'foamToC',
  'transformPoints', 'topoSet', 'createPatch', 'setFields', 'mapFields',
  'postProcess', 'foamListTimes', 'potentialFoam', 'icoFoam',
]);

/** Shell syntax that would turn one allowed command into something else. */
const SHELL_METACHARACTERS = /[;&|`$><\n\r\\]|\$\(/;

export function allowedCommands(): Set<string> {
  const index = getFoamIndexIfReady();
  const names = index?.applications.map(a => a.name) ?? [];
  return new Set<string>([...(names.length ? names : CORE_COMMANDS), ...SCRIPT_COMMANDS]);
}

/**
 * Decide whether a command string may run, and return it normalised.
 *
 * Accepts an optional `mpirun -np N` prefix, because a parallel run is a normal
 * thing to ask for and building it out of allowed pieces is safer than letting
 * the agent write the whole line.
 */
function checkCommand(raw: string): { ok: true; command: string } | { ok: false; reason: string } {
  const command = raw.trim();
  if (!command) return { ok: false, reason: 'empty command' };
  if (SHELL_METACHARACTERS.test(command)) {
    return {
      ok: false,
      reason: 'shell syntax is not allowed here (no pipes, redirects, chaining or substitution) — ' +
        'run one OpenFOAM command per call, and use background: true instead of a trailing &',
    };
  }

  const parts = command.split(/\s+/);
  let head = parts[0];
  if (head === 'mpirun') {
    if (parts[1] !== '-np' || !/^\d+$/.test(parts[2] || '')) {
      return { ok: false, reason: 'mpirun must be written exactly as: mpirun -np <n> <command> -parallel' };
    }
    head = parts[3];
    if (!head) return { ok: false, reason: 'mpirun needs a command to run' };
  }

  const allowed = allowedCommands();
  if (!allowed.has(head)) {
    const near = [...allowed].filter(c => c.toLowerCase().startsWith(head.slice(0, 4).toLowerCase())).slice(0, 5);
    return {
      ok: false,
      reason: `"${head}" is not an executable of this OpenFOAM installation` +
        (near.length ? ` — did you mean: ${near.join(', ')}?` : ''),
    };
  }
  return { ok: true, command };
}

/**
 * The one line unrestricted mode does not cross: out of WSL.
 *
 * "No limits" means a real shell for CFD work — the whole Linux side, including
 * the OpenFOAM installation and anything under the user's WSL home. It does NOT
 * mean the Windows disk, and WSL exposes that at /mnt/<drive>: from there a
 * single `rm -rf` reaches the user's documents, or the app's own program files,
 * which is never what "let the agent work on my cases" was asking for.
 *
 * Two honest limits on this check. It reads the command as text, so a
 * determined bypass (building the path in a variable, say) is possible — it
 * stops an accident, not an adversary. And everything inside WSL stays
 * reachable, which is the point of the mode.
 */
const WINDOWS_MOUNT = /(^|[^\w/])\/mnt\//;

function checkUnrestrictedCommand(raw: string): { ok: true; command: string } | { ok: false; reason: string } {
  const command = raw.trim();
  if (!command) return { ok: false, reason: 'empty command' };
  if (WINDOWS_MOUNT.test(command)) {
    return {
      ok: false,
      reason: 'even with the limits off, this agent stays inside WSL: /mnt/… is the Windows disk '
        + '(your documents, and this application\'s own files), and nothing about an OpenFOAM case '
        + 'needs to reach it. Work under $FOAM_RUN or the OpenFOAM installation instead, and ask '
        + 'the user if a Windows file really has to change.',
    };
  }
  return { ok: true, command };
}

// ── Tools ───────────────────────────────────────────────────────────────────

export type ToolResult = { text: string } | { error: string };

/**
 * Unrestricted mode: the user has turned the guard rails off.
 *
 * It is not something the model can grant itself. The flag reaches this file
 * from the tool server's ENVIRONMENT, which the app sets when it launches the
 * agent process — so it is a property of the session the user switched on, and
 * no amount of arguing by the model can change it mid-conversation. Flipping
 * the switch restarts the agent, which is what makes that true.
 *
 * It changes exactly one thing: run_openfoam stops being an allowlist of
 * OpenFOAM executables and becomes a shell in the case directory. That is all
 * it needs to change — with a shell, everything else follows.
 */
async function call(tool: string, args: Record<string, unknown>, unrestricted = false): Promise<ToolResult> {
  const str = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '');

  switch (tool) {
    case 'list_cases': {
      const cases = listCases();
      return { text: cases.length ? cases.join('\n') : '(no cases in the run directory)' };
    }

    case 'case_info': {
      const name = validateCaseName(str('case'));
      const info = getCaseInfo(name);
      return { text: JSON.stringify(info, null, 2) };
    }

    case 'list_case_files': {
      const name = validateCaseName(str('case'));
      const dir = str('path');
      const items = listDirectory(name, dir);
      return {
        text: items.length
          ? items.map(i => `${i.isDir ? 'dir ' : 'file'}  ${i.path}`).join('\n')
          : '(empty)',
      };
    }

    case 'read_case_file': {
      const name = validateCaseName(str('case'));
      const path = validateRelativePath(str('path'), 'File path');
      return { text: readFile(name, path) };
    }

    case 'write_case_file': {
      const name = validateCaseName(str('case'));
      const path = validateRelativePath(str('path'), 'File path');
      const content = typeof args.content === 'string' ? args.content : '';
      writeFile(name, path, content);
      return { text: `written: ${name}/${path} (${content.length} bytes)` };
    }

    case 'run_openfoam': {
      const name = validateCaseName(str('case'));
      const decision = unrestricted
        ? checkUnrestrictedCommand(str('command'))
        : checkCommand(str('command'));
      if (!decision.ok) return { error: decision.reason };
      if (!decision.command) return { error: 'empty command' };
      const background = args.background === true;
      const result = await executeCommandAsync(
        name,
        background ? `${decision.command} &` : decision.command,
      );
      const tail = result.output.split('\n').slice(-120).join('\n');
      return {
        text: `exit ${result.exitCode}\n\n${tail}`,
      };
    }

    case 'validate_case_files': {
      const name = validateCaseName(str('case'));
      const index = getFoamIndexIfReady();
      if (!index) { void ensureFoamIndex(); return { error: 'the version index is still building — try again in a few seconds' }; }

      const paths: string[] = Array.isArray(args.paths)
        ? (args.paths as unknown[]).filter((p): p is string => typeof p === 'string')
        : [];
      if (!paths.length) return { error: 'give the paths to check, e.g. ["0/U", "system/controlDict"]' };

      const files = paths.map(p => ({ path: p, content: readFile(name, validateRelativePath(p, 'File path')) }));
      const names = files.flatMap(f => validateDictText(index, f.content, f.path));
      const syntax = await checkDictSyntax(files);

      if (!names.length && !syntax.length) return { text: `all ${files.length} file(s) check out against OpenFOAM ${index.version}` };
      const lines = [
        ...syntax.map(s => `SYNTAX  ${s.path}${s.line ? ` line ${s.line}` : ''}: ${s.message}`),
        ...names.map(n => `NAME    ${n.where}: "${n.name}" does not exist here` +
          (n.suggestions.length ? ` — did you mean ${n.suggestions.join(', ')}?` : '')),
      ];
      return { text: lines.join('\n') };
    }

    case 'foam_lookup': {
      const index = getFoamIndexIfReady();
      if (!index) { void ensureFoamIndex(); return { error: 'the version index is still building — try again in a few seconds' }; }
      const name = str('name');
      if (name) {
        const tables = index.names[name];
        const keys = index.keysByType[name];
        if (!tables) {
          return { text: `"${name}" does not exist in OpenFOAM ${index.version}. Closest: ${suggest(index, name).join(', ') || '(nothing close)'}` };
        }
        return {
          text: [
            `${name} — valid in OpenFOAM ${index.version}`,
            `tables: ${tables.join(', ')}`,
            keys?.length ? `accepted keys: ${keys.join(' ')}` : 'accepted keys: (none found in the sources)',
          ].join('\n'),
        };
      }

      const kind = str('kind') || 'solvers';
      const lists: Record<string, string[]> = {
        solvers: index.solvers,
        scalarBCs: index.boundaryConditions.scalar,
        vectorBCs: index.boundaryConditions.vector,
        functionObjects: index.functionObjects,
        fvModels: index.fvModels,
        fvConstraints: index.fvConstraints,
        applications: index.applications.map(a => a.name),
      };
      const list = lists[kind];
      if (!list) return { error: `unknown kind "${kind}" — use one of: ${Object.keys(lists).join(', ')}` };
      return { text: `${kind} in OpenFOAM ${index.version} (${list.length}):\n${list.join(' ')}` };
    }

    case 'search_tutorials': {
      if (!getCorpusIfReady()) return { error: 'the tutorial corpus is still being indexed — try again shortly' };
      const block = renderExcerpts(selectExcerpts(str('query')));
      return { text: block || '(nothing matched in the tutorials)' };
    }

    default:
      return { error: `unknown tool "${tool}"` };
  }
}

/** Run one tool and log it. The only entry point - nothing else calls `call`. */
export async function callTool(
  tool: string,
  args: Record<string, unknown>,
  unrestricted = false,
): Promise<ToolResult> {
  try {
    const result = await call(tool, args, unrestricted);
    // The log is the safeguard the user kept, so it has to say which mode ran.
    record(tool, (unrestricted ? '[unrestricted] ' : '') + summarise(tool, args, result), !('error' in result));
    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown error';
    record(tool, summarise(tool, args, { error: message }), false);
    return { error: message };
  }
}

/** One readable line for the activity log in the app. */
function summarise(tool: string, args: Record<string, unknown>, result: ToolResult): string {
  const c = typeof args.case === 'string' ? args.case : '';
  const p = typeof args.path === 'string' ? args.path : '';
  if ('error' in result) return `${c || ''}${p ? '/' + p : ''} — refused: ${result.error}`.trim();
  switch (tool) {
    case 'run_openfoam': return `${c}: ${typeof args.command === 'string' ? args.command : ''}`;
    case 'write_case_file': return `wrote ${c}/${p}`;
    case 'read_case_file': return `read ${c}/${p}`;
    case 'validate_case_files': return `checked ${c}`;
    case 'search_tutorials': return `searched: ${typeof args.query === 'string' ? args.query.slice(0, 60) : ''}`;
    case 'foam_lookup': return `looked up ${typeof args.name === 'string' && args.name ? args.name : (typeof args.kind === 'string' ? args.kind : '')}`;
    default: return c || tool;
  }
}

/**
 * The token the bridge must present.
 *
 * electron/main.js puts it in the server's environment and passes the same
 * value to the agent's MCP config. The server only listens on 127.0.0.1, so
 * this is not defending against the network - it stops another local program
 * from driving the user's cases just because it guessed the port.
 */
export function expectedToken(): string {
  return process.env.OFSTUDIO_AGENT_TOKEN || '';
}
