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
  getRunDirectory,
} from '@/lib/wsl';
import { argumentStaysInside, looksLikePath, validateCaseName, validateRelativePath } from '@/lib/wsl-input';
import {
  ensureFoamIndex, getFoamIndexIfReady, validateDictText, checkDictSyntax, suggest,
} from '@/lib/foam-index';
import { getCorpusIfReady, renderExcerpts, selectExcerpts } from '@/lib/foam-retrieval';
import { resolveHelp, renderFindings } from '@/lib/foam-help';

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

/**
 * The agent may RUN the case's own scripts. It may not WRITE them.
 *
 * Without this the allowlist was decorative. `Allrun` is on it, and
 * normalizeCommand() in src/lib/wsl.ts turns the bare word into `bash ./Allrun`
 * — so an agent that could also author that file had a general-purpose shell in
 * two guarded, individually-permitted steps:
 *
 *     write_case_file { case: "cavity", path: "Allrun", content: "#!/bin/bash\nrm -rf …" }
 *     run_openfoam    { case: "cavity", command: "Allrun" }
 *
 * Both calls pass every check: "Allrun" is a valid relative path, and "Allrun"
 * is an allowed command. The claim in this file's header that "there is no free
 * shell: `rm -rf` is not expressible" was therefore false, and the run-directory
 * confinement went with it — the script body is ordinary bash and reaches
 * anything the user can.
 *
 * Refusing the write is what closes it while keeping the capability that made
 * these names worth allowing: the Allrun that SHIPPED with a tutorial is still
 * runnable, because the agent cannot have been the one to put it there.
 */
function isCaseScriptPath(relativePath: string): boolean {
  const basename = relativePath.split('/').pop() ?? '';
  return SCRIPT_COMMANDS.has(basename);
}

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
function checkCommand(raw: string, caseName: string): { ok: true; command: string } | { ok: false; reason: string } {
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

  // Checking argv[0] is not enough, because the ARGUMENTS decide where an
  // OpenFOAM utility does its work. Every one of them parses OpenFOAM's own
  // argList, and argList understands `-case <dir>`: `checkMesh -case /mnt/c/Users`
  // is an allowlisted executable pointed at the Windows disk, and
  // `foamDictionary -case … -set …` is an allowlisted executable WRITING there.
  // The confinement this file promises ("nothing outside $FOAM_RUN is reachable
  // — not by `..`, not by symlink, not by an absolute path in an argument") was
  // only true of the paths that went through the validators, and command
  // arguments did not.
  //
  // The test is WHERE A TOKEN RESOLVES, not how it is spelled. Banning `..`
  // outright was the first attempt and it was too blunt: it took out the whole
  // two-case family of utilities — `mapFields ../coarse`, `mapFieldsPar`,
  // `foamCloneCase ../pitzDaily myCase` — none of which is an escape, because a
  // sibling case is inside $FOAM_RUN, which the agent may already read and write
  // through list_cases and read_case_file. There is also no other spelling
  // available: siblings can only be named with `..`, and absolute paths are
  // refused too, so the ban left no way to express a legitimate operation.
  //
  // So each path-shaped token is resolved against the case directory and must
  // land inside the run directory. `-region fluid` and `-latestTime` are not
  // path-shaped and are untouched.
  for (const token of parts.slice(1)) {
    if (!looksLikePath(token)) continue;
    const verdict = resolvesInsideRunDir(token, caseName);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
  }

  return { ok: true, command };
}

/**
 * Does this argument stay inside the run directory?
 *
 * The resolution itself is `argumentStaysInside` in src/lib/wsl-input.ts, kept
 * there because it is pure and therefore testable. This wrapper supplies the
 * directories and the wording.
 *
 * Fails CLOSED: if the run directory cannot be determined, a path-shaped
 * argument is refused rather than waved through, because this check is the only
 * thing standing between an allowlisted executable and the rest of the disk.
 */
function resolvesInsideRunDir(token: string, caseName: string): { ok: true } | { ok: false; reason: string } {
  let runDir = '';
  try { runDir = getRunDirectory().trim().replace(/\/+$/, ''); } catch { runDir = ''; }
  if (!runDir || !runDir.startsWith('/')) {
    return { ok: false, reason: `the run directory could not be determined, so the path argument "${token}" cannot be checked — try again in a moment` };
  }
  if (!argumentStaysInside(token, `${runDir}/${caseName}`, runDir)) {
    return {
      ok: false,
      reason: `"${token}" points outside the run directory. Everything this agent runs stays under ${runDir}.`,
    };
  }
  return { ok: true };
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
      // See isCaseScriptPath: these are the names run_openfoam executes as shell
      // scripts, so writing one is writing a command, not a case file.
      if (isCaseScriptPath(path)) {
        return {
          error: `"${path}" is a script this tool can RUN, so it is not something it may write — writing it would ` +
            'be a way of running arbitrary shell. Put the changes in the case dictionaries instead, or ask the ' +
            'user to edit the script themselves in the File Editor.',
        };
      }
      const content = typeof args.content === 'string' ? args.content : '';
      writeFile(name, path, content);
      return { text: `written: ${name}/${path} (${content.length} bytes)` };
    }

    case 'run_openfoam': {
      const name = validateCaseName(str('case'));
      const decision = unrestricted
        ? checkUnrestrictedCommand(str('command'))
        : checkCommand(str('command'), name);
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

    case 'foam_help': {
      // The three-tier lookup: what the installation knows, then the command's
      // own -help, then the web if neither had anything. The findings come
      // back labelled, and the agent's system prompt requires it to pass the
      // label on — an unattributed web answer is indistinguishable from ground
      // truth, which is the failure this tool exists to stop.
      const name = str('name');
      if (!name) return { error: 'give the name of a command or type to look up' };
      const findings = await resolveHelp({
        names: [name],
        context: str('question'),
        forceWeb: args.web === true,
      });
      if (!findings.length) {
        return { text: `Nothing found for "${name}" — not in the installation, no -help, and the web was not consulted.` };
      }
      return { text: renderFindings(findings) };
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
    case 'foam_help': return `read the documentation for ${typeof args.name === 'string' ? args.name : ''}${args.web === true ? ' (web included)' : ''}`;
    default: return c || tool;
  }
}

/**
 * The token the bridge must present — see src/lib/agent-token.ts.
 *
 * Re-exported here because this is where callers expect to find it, but it is
 * defined apart so that src/lib/claude-cli.ts can hand the same value to the
 * bridge without importing this whole policy (and with it wsl.ts and the index).
 */
export { expectedToken } from '@/lib/agent-token';
