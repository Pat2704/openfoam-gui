import { NextRequest, NextResponse } from 'next/server';
import {
  ensureFoamIndex,
  getFoamIndexIfReady,
  isBuilding,
  renderSlices,
  topicsFor,
  validateDictText,
  checkDictSyntax,
  suggest,
  applicationOptions,
  typesMentioned,
  type NameProblem,
} from '@/lib/foam-index';
import { findExamples } from '@/lib/foam-examples';
import {
  corpusStats, ensureCorpus, isCorpusBuilding, renderExcerpts, selectExcerpts,
} from '@/lib/foam-retrieval';
import { apiError } from '@/lib/api-response';

// GET /api/foam-index
//   ?action=status                  → { ready, building, version, counts }
//   ?action=build[&force=1]         → builds (≈11 s) and returns the status
//   ?action=slice&q=…               → the prompt slice a question would get
//   ?action=app&name=blockMesh      → that executable's option flags
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action') || 'status';

    if (action === 'build') {
      const index = await ensureFoamIndex(searchParams.get('force') === '1');
      return NextResponse.json(status(index));
    }

    if (action === 'slice') {
      const q = searchParams.get('q') || '';
      const index = getFoamIndexIfReady();
      if (!index) return NextResponse.json({ ready: false, building: isBuilding(), slice: '' });
      const topics = topicsFor(q);
      return NextResponse.json({ ready: true, topics, slice: renderSlices(index, topics, q) });
    }

    if (action === 'bc') {
      // The boundary-condition names this installation offers, for the pickers
      // in the UI. Scalar and vector merged: a picker sits on a field whose
      // rank the wizard does not always know, and offering a name that exists
      // for the other rank is a far smaller error than offering one that does
      // not exist at all.
      const index = getFoamIndexIfReady();
      if (!index) {
        void ensureFoamIndex();
        return NextResponse.json({ ready: false, types: [] });
      }
      const types = [...new Set([
        ...index.boundaryConditions.scalar,
        ...index.boundaryConditions.vector,
      ])].sort();
      return NextResponse.json({ ready: true, version: index.version, types });
    }

    if (action === 'corpus') {
      // Build or report the tutorial corpus the selector ranks over.
      if (searchParams.get('build') === '1') await ensureCorpus(searchParams.get('force') === '1');
      return NextResponse.json({ ...corpusStats(), building: isCorpusBuilding() });
    }

    if (action === 'select') {
      // What the selector would attach for this question, and why.
      const q = searchParams.get('q') || '';
      const picked = selectExcerpts(q);
      return NextResponse.json({
        ...corpusStats(),
        picked: picked.map(p => ({ path: p.path, line: p.line, score: Number(p.score.toFixed(2)), chars: p.text.length })),
        block: renderExcerpts(picked),
      });
    }

    if (action === 'examples') {
      // Exposed for testing and for a future "show me an example" button.
      const q = searchParams.get('q') || '';
      const index = getFoamIndexIfReady();
      if (!index) return NextResponse.json({ ready: false, examples: [] });
      const names = typesMentioned(index, q, 2);
      const examples = await findExamples(names);
      return NextResponse.json({ ready: true, names, examples });
    }

    if (action === 'app') {
      const index = getFoamIndexIfReady();
      const name = searchParams.get('name') || '';
      if (!index) return NextResponse.json({ ready: false });
      return NextResponse.json({ ready: true, name, options: applicationOptions(index, name) });
    }

    return NextResponse.json(status(getFoamIndexIfReady()));
  } catch (error: unknown) {
    return apiError(error);
  }
}

// POST /api/foam-index
//   { action: 'validate', files: [{ path, content }] }
//     → { ready, problems: [{ file, name, where, suggestions }] }
//   { action: 'suggest', name }
//     → { ready, valid, tables, suggestions }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (body?.action === 'validate') {
      const index = getFoamIndexIfReady();
      if (!index) {
        // Never block the user's click on an eleven-second build: report that
        // the check could not run, and start the build for next time.
        void ensureFoamIndex();
        return NextResponse.json({ ready: false, building: true, problems: [] });
      }
      const files: { path: string; content: string }[] = (Array.isArray(body.files) ? body.files : [])
        .filter((f: unknown): f is { path: string; content: string } =>
          !!f && typeof (f as { path?: unknown }).path === 'string'
          && typeof (f as { content?: unknown }).content === 'string');

      const problems: (NameProblem & { file: string })[] = [];
      for (const f of files) {
        for (const p of validateDictText(index, f.content, f.path)) {
          problems.push({ ...p, file: f.path });
        }
      }

      // Two different failures, checked together so the client asks once: a
      // name this version does not have, and a file its parser cannot read.
      const syntax = body.skipSyntax ? [] : await checkDictSyntax(files);

      return NextResponse.json({ ready: true, version: index.version, problems, syntax });
    }

    if (body?.action === 'suggest') {
      const index = getFoamIndexIfReady();
      const name = typeof body.name === 'string' ? body.name : '';
      if (!index) return NextResponse.json({ ready: false });
      return NextResponse.json({
        ready: true,
        valid: Boolean(index.names[name]),
        tables: index.names[name] || [],
        suggestions: index.names[name] ? [] : suggest(index, name),
      });
    }

    return NextResponse.json({ error: 'Invalid action. Use: validate, suggest' }, { status: 400 });
  } catch (error: unknown) {
    return apiError(error);
  }
}

function status(index: ReturnType<typeof getFoamIndexIfReady>) {
  if (!index) return { ready: false, building: isBuilding() };
  return {
    ready: true,
    building: isBuilding(),
    version: index.version,
    hasToC: index.hasToC,
    builtAt: index.builtAt,
    counts: {
      names: Object.keys(index.names).length,
      scalarBCs: index.boundaryConditions.scalar.length,
      vectorBCs: index.boundaryConditions.vector.length,
      solvers: index.solvers.length,
      functionObjects: index.functionObjects.length,
      fvModels: index.fvModels.length,
      applications: index.applications.length,
    },
  };
}
