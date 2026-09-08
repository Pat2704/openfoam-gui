import { NextRequest, NextResponse } from 'next/server';
import {
  listPostProcessing,
  readPostProcessDataset,
  listFunctionCatalog,
  runPostProcessFunction,
} from '@/lib/wsl';
import {
  parseFoamTable,
  mergeRestarts,
  downsampleRows,
  summarizeColumn,
  validateTypedSpec,
  isTimeSeries,
} from '@/lib/postprocess';
import { apiError } from '@/lib/api-response';
import { validateCaseName, boundedInteger } from '@/lib/wsl-input';

// GET /api/postprocess
//   ?action=list&case=…                       → { datasets }
//   ?action=data&case=…&dataset=…&file=…      → merged, thinned table + per-column stats
//   ?action=catalog&refresh=…                 → { entries }
//
// POST /api/postprocess
//   { action: 'run', case, spec, time, fields, region } → { exitCode, output, spec }

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action');

    switch (action) {
      case 'list': {
        const caseName = validateCaseName(searchParams.get('case') || '');
        return NextResponse.json({ datasets: listPostProcessing(caseName) });
      }

      case 'data': {
        const caseName = validateCaseName(searchParams.get('case') || '');
        const dataset = searchParams.get('dataset') || '';
        const file = searchParams.get('file') || '';
        // The chart cannot resolve more points than the viewport has pixels,
        // and the browser pays for every one of them. Thinning happens here so
        // a long probe series never crosses the wire in full.
        const maxPoints = boundedInteger(searchParams.get('maxPoints'), 4000, 100, 50000);

        const slices = readPostProcessDataset(caseName, dataset, file)
          .map(slice => ({ startTime: slice.startTime, truncated: slice.truncated, table: parseFoamTable(slice.content) }));
        const readable = slices.filter(slice => slice.table.columns.length > 0);
        const times = readable.map(slice => slice.startTime);

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
          const requested = searchParams.get('time');
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

        return NextResponse.json({
          mode: seriesLike ? 'series' : 'profile',
          columns: table.columns,
          rows: downsampleRows(table.rows, maxPoints),
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
        });
      }

      case 'catalog': {
        const refresh = searchParams.get('refresh') === 'true';
        return NextResponse.json({ entries: listFunctionCatalog(refresh) });
      }

      default:
        return NextResponse.json(
          { error: 'Invalid action. Use: list, data, catalog' },
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

    if (body?.action !== 'run') {
      return NextResponse.json({ error: 'Invalid action. Use: run' }, { status: 400 });
    }

    const caseName = validateCaseName(body.case || '');

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

    const result = runPostProcessFunction(caseName, spec, {
      time: typeof body.time === 'string' && body.time.trim() ? body.time.trim() : undefined,
      fields: fields?.length ? fields : undefined,
      region: typeof body.region === 'string' && body.region.trim() ? body.region.trim() : undefined,
    });

    return NextResponse.json({ ...result, spec });
  } catch (error: unknown) {
    return apiError(error);
  }
}
