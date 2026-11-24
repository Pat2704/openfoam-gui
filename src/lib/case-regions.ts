/**
 * The mesh regions of a case, for the features that read a case's layout.
 *
 * A multi-region case (foamMultiRun from v11, chtMultiRegionFoam and friends on
 * 9–10) has no constant/polyMesh and no fields directly in 0/: every region
 * keeps its own constant/<region>/polyMesh, 0/<region>/, system/<region>/ and,
 * for function objects, postProcessing/<region>/. Everything that looked only
 * at the single-region places found nothing there — no mesh, no fields, no
 * patches — and said so.
 *
 * The regions are found the way OpenFOAM and paraFoam find them, in this order:
 *   regionSolvers in system/controlDict      foamMultiRun, v11 and later
 *   regions in constant/regionProperties     the multi-region solvers of 9–10
 *   every constant/<region>/polyMesh         what paraFoam -touchAll lists
 * The first two name the regions before a mesh exists; the last catches a case
 * whose dictionaries say nothing (split by splitMeshRegions, say).
 *
 * Pure: the shell function is text the WSL scripts include, and the parsers
 * take what they print.
 */

/** A region name as OpenFOAM accepts it, and safe to put on a command line. */
export const REGION_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

/**
 * Bash: `case_regions <caseDir>` prints the case's regions, one per line, and
 * nothing for a single-region case.
 *
 * Plain quotes rather than a template literal: the shell's `${…}` would
 * otherwise be read as JavaScript.
 */
export const CASE_REGIONS_SH = [
  'case_regions() {',
  '  local c="$1" p',
  '  {',
  '    if [ -f "$c/system/controlDict" ]; then',
  // The `name solver;` lines one level inside `regionSolvers { … }`.
  '      awk \'{ sub(/[/][/].*/, "") }',
  '        !on && /^[ \\t]*regionSolvers([ \\t{]|$)/ { on = 1 }',
  '        on { line = $0; o = gsub(/[{]/, "{", line); cl = gsub(/[}]/, "}", line) }',
  '        on && depth == 1 && $1 ~ /^[A-Za-z_][A-Za-z0-9_.:-]*$/ && $2 ~ /;$/ { print $1 }',
  '        on { depth += o - cl; if (o) opened = 1; if (opened && depth <= 0) exit }\' "$c/system/controlDict" 2>/dev/null',
  '    fi',
  '    if [ -f "$c/constant/regionProperties" ]; then',
  // `regions ( fluid (bottomAir topAir) solid (heater) );` → the inner lists.
  '      sed \'s://.*$::\' "$c/constant/regionProperties" | tr \'\\n\' \' \' | grep -o \'regions[^;]*\' |',
  '        grep -o \'([^()]*)\' | tr -d \'()\' | tr -s \' \\t\' \'\\n\'',
  '    fi',
  '    for p in "$c"/constant/*/polyMesh; do',
  '      [ -d "$p" ] || continue',
  '      p=${p%/polyMesh}; printf \'%s\\n\' "${p##*/}"',
  '    done',
  '  } | awk \'/^[A-Za-z_][A-Za-z0-9_.:-]*$/ && $0 != "polyMesh" && !seen[$0]++\'',
  '}',
].join('\n');

export interface CaseRegions {
  /** Every region, in the order the case names them; empty for a single-region case. */
  regions: string[];
  /** The regions that have a mesh (constant/<region>/polyMesh). */
  meshRegions: string[];
  /** constant/polyMesh exists. */
  defaultMesh: boolean;
  /** `application` in system/controlDict (foamMultiRun, chtMultiRegionFoam, foamRun, …), or ''. */
  application: string;
}

/**
 * Bash that prints a case's regions as `R|name`, `M|name` (meshed), `DEFAULT`
 * and `APP|name` lines. `CASE` must already hold the case path.
 */
export const CASE_REGIONS_REPORT_SH = [
  CASE_REGIONS_SH,
  'for r in $(case_regions "$CASE"); do',
  '  echo "R|$r"',
  '  [ -d "$CASE/constant/$r/polyMesh" ] && echo "M|$r"',
  'done',
  '[ -d "$CASE/constant/polyMesh" ] && echo "DEFAULT"',
  'echo "APP|$(sed -n \'s/^[[:space:]]*application[[:space:]]\\{1,\\}\\([A-Za-z][A-Za-z0-9_.-]*\\)[[:space:]]*;.*/\\1/p\' "$CASE/system/controlDict" 2>/dev/null | head -1)"',
].join('\n');

export function parseCaseRegions(output: string): CaseRegions {
  const result: CaseRegions = { regions: [], meshRegions: [], defaultMesh: false, application: '' };
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (line === 'DEFAULT') result.defaultMesh = true;
    else if (line.startsWith('R|') && REGION_NAME.test(line.slice(2))) result.regions.push(line.slice(2));
    else if (line.startsWith('M|') && REGION_NAME.test(line.slice(2))) result.meshRegions.push(line.slice(2));
    else if (line.startsWith('APP|')) result.application = line.slice(4);
  }
  return result;
}

/** The meshes to work on: each region's, or the single default one (''). */
export function meshTargets(regions: CaseRegions): string[] {
  if (regions.meshRegions.length) return regions.defaultMesh ? ['', ...regions.meshRegions] : regions.meshRegions;
  return regions.defaultMesh ? [''] : [];
}

/** `-region <name>`, or nothing for the default mesh. */
export function regionOption(region: string): string {
  if (!region) return '';
  if (!REGION_NAME.test(region)) throw new Error(`Region name is not valid: ${region}`);
  return ` -region ${region}`;
}

/** A path inside a region: `constant/polyMesh` → `constant/fluid/polyMesh`. */
export function regionPath(top: '0' | 'system' | 'constant' | string, region: string, rest = ''): string {
  return [top, region, rest].filter(Boolean).join('/');
}

/**
 * The parts of a mesh-region name the ParaView reader reports.
 *
 * Its OpenFOAM reader names a single-region case's parts `internalMesh`,
 * `patch/inlet`, `group/wall`, and a multi-region case's `/fluid/internalMesh`,
 * `/fluid/patch/inlet`: the same parts behind the region they belong to.
 */
export function describeReaderPart(name: string): { region: string; kind: string; label: string } {
  const match = name.match(/^\/([^/]+)\/(.*)$/);
  const region = match ? match[1] : '';
  const rest = match ? match[2] : name;
  const slash = rest.indexOf('/');
  if (slash < 0) return { region, kind: 'mesh', label: rest };
  return { region, kind: rest.slice(0, slash), label: rest.slice(slash + 1) };
}

export function isReaderInternalMesh(name: string): boolean {
  return describeReaderPart(name).kind === 'mesh' && describeReaderPart(name).label === 'internalMesh';
}

export function isReaderPatch(name: string): boolean {
  return describeReaderPart(name).kind === 'patch';
}
