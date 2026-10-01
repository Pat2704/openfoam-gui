import { NextRequest, NextResponse } from 'next/server';
import {
  listPostProcessingInventory,
  readPostProcessDataset,
  listFunctionCatalog,
  startPostProcessFunction,
  getOpenFOAMInstallationIdentity,
  postProcessUtility,
  readFunctionClassDoc,
  getPostProcessContext,
} from '@/lib/wsl';
import {
  parseFoamTable,
  mergeRestarts,
  sampleRowsForChart,
  summarizeColumn,
  validateTypedSpec,
  isTimeSeries,
} from '@/lib/postprocess';
import { apiError } from '@/lib/api-response';
import { validateCaseName, boundedInteger } from '@/lib/wsl-input';
import { postProcessJobs } from '@/lib/postprocess-jobs';

// GET /api/postprocess
//   ?action=list&case=…                       → { datasets }
//   ?action=data&case=…&dataset=…&file=…      → merged, thinned table + per-column stats
//   ?action=catalog&refresh=…                 → { entries, utility, options }
//   ?action=doc&type=…                        → { doc } — the class reference
//   ?action=context&case=…                    → what the case can be asked
//
// POST /api/postprocess
//   { action: 'run', case, spec, time, fields, region, solver,
//     latestTime, noZero, constant }           → { job } (202)
//   { action: 'cancel', case, id }              → { job }

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action');

    switch (action) {
      case 'list': {
        const caseName = validateCaseName(searchParams.get('case') || '');
        return NextResponse.json(listPostProcessingInventory(caseName));
      }

      case 'job': {
        const caseName = validateCaseName(searchParams.get('case') || '');
        const installationId = getOpenFOAMInstallationIdentity().id;
        return NextResponse.json({ job: postProcessJobs.get(caseName, installationId, searchParams.get('id') || undefined) });
      }

      case 'data': {
        const caseName = validateCaseName(searchParams.get('case') || '');
        const dataset = searchParams.get('dataset') || '';
        const file = searchParams.get('file') || '';
        // The chart cannot resolve more points than the viewport has pixels,
        // and the browser pays for every one of them. Thinning happens here so
        // a long probe series never crosses the wire in full. CSV explicitly
        // asks for the parser's larger ceiling because it is data, not a plot.
        const maxPoints = boundedInteger(searchParams.get('maxPoints'), 4000, 100, 200000);

        const requestedTime = searchParams.get('time') || undefined;
        const datasetRead = readPostProcessDataset(caseName, dataset, file, requestedTime);
        const slices = datasetRead.slices
          .map(slice => ({ startTime: slice.startTime, truncated: slice.truncated, table: parseFoamTable(slice.content) }));
        const readable = slices.filter(slice => slice.table.columns.length > 0);
        const times = datasetRead.times;

        // A time series continues across its time directories; a spatial profile
        // has one complete curve in each of them. `isTimeSeries` explains why
        // the file's own first column is what decides.
        const seriesLike = readable.length > 0 && isTimeSeries(readable[readable.length - 1].table.columns);

        let table;
        let startTimes: string[] = [];
        let incompatible: string[] = [];
        let overwritten = 0;
        let shownTime: string | null = null;

        if (seriesLike) {
          const merged = mergeRestarts(readable.map(slice => ({ startTime: slice.startTime, table: slice.table })));
          table = merged;
          startTimes = merged.startTimes;
          incompatible = merged.incompatible;
          overwritten = merged.overwritten;
        } else {
          const requested = requestedTime;
          const chosen = readable.find(slice => slice.startTime === requested) ?? readable[readable.length - 1];
          table = chosen?.table ?? { columns: [], rows: [], notes: [], synthesizedColumns: false, truncated: false };
          shownTime = chosen?.startTime ?? null;
        }

        // Statistics are computed on EVERY row, then the rows are thinned. The
        // other order would report the minimum of a sample rather than of the
        // series, which is exactly the number someone would quote.
        const stats = table.columns.map((name, index) =>
          index === 0 ? null : { name, ...summarizeColumn(table.rows, index) },
        );
        const sampled = sampleRowsForChart(table.rows, maxPoints);
        const diagnosticSlices = seriesLike
          ? readable.filter(slice => !incompatible.includes(slice.startTime))
          : readable.filter(slice => slice.startTime === shownTime);
        const diagnostics = diagnosticSlices.reduce((total, slice) => ({
          skippedRows: total.skippedRows + (slice.table.diagnostics?.skippedRows ?? 0),
          nonFiniteCells: total.nonFiniteCells,
        }), { skippedRows: 0, nonFiniteCells: 0 });
        diagnostics.nonFiniteCells = table.rows.reduce((total, row) => total + row.slice(1).filter(value => !Number.isFinite(value)).length, 0);

        return NextResponse.json({
          mode: seriesLike ? 'series' : 'profile',
          columns: table.columns,
          rows: sampled.rows,
          totalRows: table.rows.length,
          stats: stats.filter(Boolean),
          notes: table.notes,
          times,
          shownTime,
          startTimes,
          incompatible,
          overwritten,
          synthesizedColumns: table.synthesizedColumns,
          truncated: table.truncated || slices.some(slice => slice.truncated),
          timesTruncated: datasetRead.timesTruncated,
          runsTruncated: seriesLike && datasetRead.slicesTruncated,
          diagnostics,
          omittedFeatures: sampled.omittedFeatures,
        });
      }

      case 'catalog': {
        const refresh = searchParams.get('refresh') === 'true';
        const utility = postProcessUtility();
        return NextResponse.json({
          entries: listFunctionCatalog(refresh),
          // So the command shown carries the name this OpenFOAM actually has,
          // and offers only the options it actually accepts.
          utility: utility.name,
          options: utility.options,
        });
      }

      case 'doc': {
        // The class behind a configured function object, as the installation's
        // own source documents it. Fetched when a function is chosen rather
        // than with the catalogue: it is one header per function, and only the
        // one on screen is ever needed.
        const type = searchParams.get('type') || '';
        return NextResponse.json({ doc: readFunctionClassDoc(type) });
      }

      case 'context': {
        const caseName = validateCaseName(searchParams.get('case') || '');
        return NextResponse.json(getPostProcessContext(caseName));
      }

      default:
        return NextResponse.json(
          { error: 'Invalid action. Use: list, data, catalog, doc, context, job' },
          { status: 400 },
        );
    }
  } catch (error: unknown) {
    return apiError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (body?.action !== 'run' && body?.action !== 'cancel') {
      return NextResponse.json({ error: 'Invalid action. Use: run, cancel' }, { status: 400 });
    }

    const caseName = validateCaseName(body.case || '');
    const installationId = getOpenFOAMInstallationIdentity().id;
    if (body.action === 'cancel') {
      return NextResponse.json({ job: await postProcessJobs.cancel(caseName, installationId, String(body.id || '')) });
    }

    // The specification arrives as the text the user edited, so it is checked
    // rather than composed: a leading name this installation actually offers,
    // balanced brackets, and nothing outside the character set an OpenFOAM
    // entry needs. A version that gained or lost a function object stays
    // correct without a code change here.
    const known = listFunctionCatalog().map(entry => entry.name);
    const spec = validateTypedSpec(String(body.spec ?? ''), known);

    const fields = Array.isArray(body.fields)
      ? body.fields.filter((field: unknown): field is string => typeof field === 'string')
      : undefined;

    const options = {
      time: typeof body.time === 'string' && body.time.trim() ? body.time.trim() : undefined,
      fields: fields?.length ? fields : undefined,
      region: typeof body.region === 'string' && body.region.trim() ? body.region.trim() : undefined,
      solver: typeof body.solver === 'string' && body.solver.trim() ? body.solver.trim() : undefined,
      latestTime: body.latestTime === true,
      noZero: body.noZero === true,
      constant: body.constant === true,
    };
    const job = postProcessJobs.start(caseName, installationId, spec,
      output => startPostProcessFunction(caseName, spec, options, output));
    return NextResponse.json({ job }, { status: 202 });
  } catch (error: unknown) {
    return apiError(error);
  }
}
