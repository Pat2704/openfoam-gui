import type { FoamApplication, FoamIndex } from './foam-index';

export type KnowledgeToolResult = { text: string } | { error: string };

/** Validate option names and required values against this binary's own -help. */
export function validateApplicationArguments(
  application: FoamApplication,
  args: string[],
): { ok: true } | { ok: false; reason: string } {
  if (!application.optionDetails?.length) return { ok: true };
  const details = new Map(application.optionDetails.map(option => [option.name, option]));

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!/^-[A-Za-z]/.test(token)) continue;
    const equals = token.indexOf('=');
    const name = equals >= 0 ? token.slice(0, equals) : token;
    const detail = details.get(name);
    if (!detail) {
      const near = application.options
        .filter(option => option.toLowerCase().startsWith(name.slice(0, 4).toLowerCase()))
        .slice(0, 4);
      return {
        ok: false,
        reason: `option "${name}" is not listed by ${application.name} -help` +
          (near.length ? ` — did you mean ${near.join(', ')}?` : ''),
      };
    }
    if (detail.requiresValue && equals < 0) {
      const value = args[i + 1];
      if (!value || /^-[A-Za-z]/.test(value)) {
        return {
          ok: false,
          reason: `${application.name} -help requires ${detail.valueHint || 'a value'} after ${name}`,
        };
      }
      i++;
    }
  }
  return { ok: true };
}

/** Pure rendering of foam_lookup, including the v9/v10 no-foamToC boundary. */
export function foamLookupResult(
  index: FoamIndex,
  name: string,
  kind: string,
  suggestions: string[] = [],
): KnowledgeToolResult {
  if (name) {
    const tables = index.names[name];
    const keys = index.keysByType[name];
    if (!index.hasToC) {
      return {
        text: keys?.length
          ? `${name} appears in the OpenFOAM ${index.version} sources and accepts: ${keys.join(' ')}\n` +
            'Runtime availability cannot be proven because this version does not provide foamToC.'
          : `Runtime availability of "${name}" cannot be verified on OpenFOAM ${index.version}: ` +
            'this version does not provide foamToC. Absence from this reduced index does not mean the type is invalid.',
      };
    }
    if (!tables) {
      return { text: `"${name}" does not exist in OpenFOAM ${index.version}. Closest: ${suggestions.join(', ') || '(nothing close)'}` };
    }
    return {
      text: [
        `${name} — valid in OpenFOAM ${index.version}`,
        `tables: ${tables.join(', ')}`,
        keys?.length ? `accepted keys: ${keys.join(' ')}` : 'accepted keys: (none found in the sources)',
      ].join('\n'),
    };
  }

  const lists: Record<string, string[]> = {
    solvers: index.solvers,
    scalarBCs: index.boundaryConditions.scalar,
    vectorBCs: index.boundaryConditions.vector,
    functionObjects: index.functionObjects,
    fvModels: index.fvModels,
    fvConstraints: index.fvConstraints,
    applications: index.applications.map(application => application.name),
  };
  const list = lists[kind];
  if (!list) return { error: `unknown kind "${kind}" — use one of: ${Object.keys(lists).join(', ')}` };
  if (!index.hasToC && kind !== 'applications') {
    return { text: `${kind} cannot be enumerated authoritatively on OpenFOAM ${index.version} because foamToC is unavailable.` };
  }
  return { text: `${kind} in OpenFOAM ${index.version} (${list.length}):\n${list.join(' ')}` };
}
