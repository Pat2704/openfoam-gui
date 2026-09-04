import { NextRequest, NextResponse } from 'next/server';
import {
  wslCheck,
  wslListDistros,
  setDistro,
  getOpenFOAMVersion,
  getOpenFOAMEnv,
  getRunDirectory,
  getTutorialDirectory,
  getProcesses,
  killProcess,
  killAllProcesses,
  killProcessesForCase,
  resetCache,
  getQuickStatus,
  findOpenFOAMVersions,
  setOpenFOAMVersion,
  getSelectedBashrc,
} from '@/lib/wsl';
import { apiError } from '@/lib/api-response';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action');

    switch (action) {
      case 'status': {
        const status = wslCheck();
        return NextResponse.json(status);
      }
      case 'ping': {
        // Lightweight health check for the header status dot.
        // Returns { running, name } — name is already computed by wslCheck at no extra cost.
        const s = wslCheck();
        return NextResponse.json({ running: s.running, name: s.name });
      }
      case 'distros': {
        const distros = wslListDistros();
        return NextResponse.json({ distros });
      }
      case 'setDistro': {
        const name = searchParams.get('name');
        if (!name) return NextResponse.json({ error: 'Distro name required' }, { status: 400 });
        const selected = setDistro(name);
        const status = wslCheck();
        return NextResponse.json({ success: status.running, distro: selected, current: selected, ...status });
      }
      case 'foamVersions': {
        // List all installed OpenFOAM versions (auto-detected from /opt, /usr/lib, /usr/local).
        const versions = findOpenFOAMVersions();
        const selected = getSelectedBashrc();
        return NextResponse.json({ versions, selectedBashrc: selected });
      }
      case 'setFoamVersion': {
        // Select which OpenFOAM version to use. Resets all caches so the new
        // environment (install dir, FOAM_RUN, FOAM_TUTORIALS, etc.) is picked up.
        const bashrc = searchParams.get('bashrc');
        if (!bashrc) return NextResponse.json({ error: 'bashrc path required' }, { status: 400 });
        const ok = setOpenFOAMVersion(bashrc);
        if (!ok) return NextResponse.json({ error: 'Invalid bashrc path' }, { status: 400 });
        // Return the new version + runDir so the client can refresh immediately.
        const version = getOpenFOAMVersion().trim();
        let runDir = '';
        try { runDir = getRunDirectory().trim(); } catch {}
        return NextResponse.json({ success: true, version, runDir, bashrc });
      }
      case 'version': {
        const version = getOpenFOAMVersion();
        return NextResponse.json({ version: version.trim() });
      }
      case 'env': {
        const env = getOpenFOAMEnv();
        return NextResponse.json({ env: env.trim() });
      }
      case 'runDir': {
        const runDir = getRunDirectory();
        return NextResponse.json({ runDir: runDir.trim() });
      }
      case 'tutDir': {
        const tutDir = getTutorialDirectory();
        return NextResponse.json({ tutorialDir: tutDir.trim() });
      }
      case 'processes': {
        const raw = getProcesses();
        const processes: any[] = [];
        for (const line of raw.split('\n').filter(Boolean)) {
          // Each line is now: "<ps fields...> | <cwd>"
          // Split on the LAST '|' so command fields (which never contain '|')
          // are preserved intact. cwd may be empty if resolution failed.
          let psLine = line;
          let cwd = '';
          const sep = line.lastIndexOf('|');
          if (sep >= 0) {
            psLine = line.substring(0, sep);
            cwd = line.substring(sep + 1).trim();
          }
          const parts = psLine.trim().split(/\s+/);
          // ps -o output (no `start` field — it can contain spaces like "Jul 23"):
          // user pid cpu mem vsz rss stat time etimes command...
          //                 0    1    2   3    4   5    6    7    8      9+
          if (parts.length < 10) continue;
          const user = parts[0];
          const pid = parts[1];
          const cpu = parts[2];
          const mem = parts[3];
          const vsz = parts[4];
          const rss = parts[5];
          const stat = parts[6];
          const time = parts[7];
          const etimes = parts[8];
          const command = parts.slice(9).join(' ');

          // Compute start datetime from etimes (elapsed seconds since process start)
          const now = new Date();
          const startDatetime = (() => {
            const elapsed = parseInt(etimes, 10);
            if (isNaN(elapsed)) return '';
            const startMs = now.getTime() - elapsed * 1000;
            const sd = new Date(startMs);
            const dd = String(sd.getDate()).padStart(2, '0');
            const mm = String(sd.getMonth() + 1).padStart(2, '0');
            const hh = String(sd.getHours()).padStart(2, '0');
            const mi = String(sd.getMinutes()).padStart(2, '0');
            return `${dd}/${mm} ${hh}:${mi}`;
          })();
          const start = startDatetime;

          processes.push({
            pid, user, cpu, mem, vsz, rss, stat, start, time,
            etimes,
            startDatetime,
            command,
            cwd,
          });
        }
        return NextResponse.json({ processes });
      }
      case 'kill': {
        const pid = searchParams.get('pid');
        if (!pid) return NextResponse.json({ error: 'PID required' }, { status: 400 });
        const result = killProcess(pid);
        const killed = result.includes('OK');
        return NextResponse.json({ result, killed });
      }
      case 'killAll': {
        const result = killAllProcesses();
        return NextResponse.json(result);
      }
      case 'killCase': {
        // Kill only the OpenFOAM processes whose working directory belongs to
        // the named case. Returns { killed, pids, output }.
        const name = searchParams.get('name');
        if (!name) return NextResponse.json({ error: 'Case name required' }, { status: 400 });
        const result = killProcessesForCase(name);
        return NextResponse.json(result);
      }
      case 'fullStatus': {
        const status = wslCheck();
        let version = 'N/A';
        let runDir = 'N/A';
        let tutorialDir = 'N/A';
        let env = 'N/A';
        let processes = 'No processes';
        let cases: any[] = [];

        if (status.running) {
          // Parallelize independent WSL calls to reduce total latency.
          // getQuickStatus() does: source bashrc + echo env + listCasesBatch (2-3 WSL calls)
          // getProcesses() does: ps -e (1 WSL call)
          // wslListDistros() does: wsl --list -q (1 process call)
          // Running these in parallel saves ~500-1000ms vs sequential.
          const [quickResult, processesResult, distrosResult] = await Promise.all([
            // getQuickStatus can throw — wrap in try/catch inside the promise
            (async () => {
              try {
                const quick = getQuickStatus();
                return {
                  version: quick.version,
                  runDir: quick.runDir,
                  tutorialDir: quick.tutorialDir,
                  env: quick.envSnippet || 'N/A',
                  cases: quick.cases,
                };
              } catch {
                // Fallback: call each function individually
                return {
                  version: (() => { try { return getOpenFOAMVersion().trim(); } catch { return 'N/A'; } })(),
                  runDir: (() => { try { return getRunDirectory().trim(); } catch { return 'N/A'; } })(),
                  tutorialDir: (() => { try { return getTutorialDirectory().trim(); } catch { return 'N/A'; } })(),
                  env: (() => { try { return getOpenFOAMEnv().trim(); } catch { return 'N/A'; } })(),
                  cases: [] as any[],
                };
              }
            })(),
            (async () => {
              try { return getProcesses(); } catch { return 'No processes'; }
            })(),
            (async () => {
              try { return wslListDistros(); } catch { return []; }
            })(),
          ]);

          version = quickResult.version;
          runDir = quickResult.runDir;
          tutorialDir = quickResult.tutorialDir;
          env = quickResult.env;
          cases = quickResult.cases;
          processes = processesResult;

          return NextResponse.json({ ...status, version, runDir, tutorialDir, env, processes, distros: distrosResult, cases });
        }

        const distros = wslListDistros();
        return NextResponse.json({ ...status, version, runDir, tutorialDir, env, processes, distros, cases });
      }
      default:
        return NextResponse.json(
          { error: 'Invalid action. Use: status, distros, setDistro, version, env, runDir, tutDir, processes, fullStatus, kill, killAll' },
          { status: 400 }
        );
    }
  } catch (error: unknown) {
    return apiError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (body.action === 'fullStatus') {
      // resetCache() belongs INSIDE the branch that wanted it. Called before the
      // action was looked at, it threw away every resolved path — and deleted the
      // on-disk cache file — for any POST at all, including ones that go on to
      // return 400. The next request then had to re-detect the distro, the
      // bashrc, the run and tutorial directories from scratch, several seconds of
      // synchronous WSL calls, for a request that did nothing.
      resetCache();
      const status = wslCheck();
      let version = 'N/A';
      let runDir = 'N/A';
      let tutorialDir = 'N/A';
      let env = 'N/A';
      let processes = 'No processes';
      let cases: any[] = [];

      if (status.running) {
        try {
          const quick = getQuickStatus();
          version = quick.version;
          runDir = quick.runDir;
          tutorialDir = quick.tutorialDir;
          env = quick.envSnippet || 'N/A';
          cases = quick.cases;
        } catch {
          try { version = getOpenFOAMVersion().trim(); } catch {}
          try { runDir = getRunDirectory().trim(); } catch {}
          try { tutorialDir = getTutorialDirectory().trim(); } catch {}
          try { env = getOpenFOAMEnv().trim(); } catch {}
        }
        try { processes = getProcesses(); } catch {}
      }

      const distros = wslListDistros();
      return NextResponse.json({ ...status, version, runDir, tutorialDir, env, processes, distros, cases });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error: unknown) {
    return apiError(error);
  }
}
