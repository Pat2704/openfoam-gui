/**
 * thermoType choices, read from the installation instead of from memory.
 *
 * `foamToC` lists every thermophysical model an installation was compiled with
 * as one instantiated template per combination, e.g.
 *
 *   heRhoThermo<pureMixture<const<hConst<perfectGas<specie>>,sensibleEnthalpy>>>
 *
 * which is exactly the `thermoType` dictionary a case writes:
 *
 *   type heRhoThermo; mixture pureMixture; transport const; thermo hConst;
 *   equationOfState perfectGas; specie specie; energy sensibleEnthalpy;
 *
 * Only those combinations exist — `const` + `janaf` + `rhoConst` may simply
 * not have been instantiated, and the solver then stops with "Unknown
 * thermoType". So the wizard offers each component narrowed to the values that
 * still form a real combination with the others (see thermoOptions), and the
 * lists come from the app's foamToC index for the selected installation.
 *
 * Pure: the component passes in the table it got from /api/foam-index.
 */

export const THERMO_KEYS = ['type', 'mixture', 'transport', 'thermo', 'equationOfState', 'specie', 'energy'] as const;
export type ThermoKey = typeof THERMO_KEYS[number];

/** One real combination. `properties` is set for the liquid/solid forms that carry no transport chain. */
export type ThermoCombo = Record<ThermoKey, string> & { properties?: string };

interface Node { name: string; args: Node[] }

function parseNode(s: string, i = 0): [Node, number] {
  let name = '';
  while (i < s.length && !'<>,'.includes(s[i])) name += s[i++];
  const node: Node = { name: name.trim(), args: [] };
  if (s[i] === '<') {
    i++;
    for (;;) {
      const [child, next] = parseNode(s, i);
      node.args.push(child);
      i = next;
      if (s[i] === ',') { i++; continue; }
      if (s[i] === '>') { i++; break; }
      break;
    }
  }
  return [node, i];
}

/**
 * `type<mixture<transport<thermo<equationOfState<specie>>,energy>>>` — the
 * energy form is the transport template's second argument, as foamToC prints
 * it — or the liquid form `type<mixture<liquid,energy>>`. Anything else is not
 * a thermoType the wizard can write, and gives null.
 */
export function parseThermoCombo(raw: string): ThermoCombo | null {
  const [type, end] = parseNode(raw.trim());
  if (end !== raw.trim().length || type.args.length !== 1) return null;
  const mixture = type.args[0];

  if (mixture.args.length === 2) {
    const [properties, energy] = mixture.args;
    if (properties.args.length || energy.args.length) return null;
    return {
      type: type.name, mixture: mixture.name, transport: '', thermo: '',
      equationOfState: '', specie: '', energy: energy.name, properties: properties.name,
    };
  }
  if (mixture.args.length !== 1) return null;

  const transport = mixture.args[0];
  if (transport.args.length !== 2) return null;
  const [thermo, energy] = transport.args;
  const eos = thermo.args[0];
  const specie = eos?.args[0];
  if (!eos || !specie || thermo.args.length !== 1 || eos.args.length !== 1 || specie.args.length || energy.args.length) return null;
  return {
    type: type.name, mixture: mixture.name, transport: transport.name, thermo: thermo.name,
    equationOfState: eos.name, specie: specie.name, energy: energy.name,
  };
}

export function parseThermoTable(raws: string[]): ThermoCombo[] {
  const out: ThermoCombo[] = [];
  const seen = new Set<string>();
  for (const r of raws) {
    const c = parseThermoCombo(r);
    if (!c) continue;
    const key = THERMO_KEYS.map(k => c[k]).join('|') + '|' + (c.properties ?? '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function matches(c: ThermoCombo, chosen: Partial<Record<ThermoKey, string>>, except?: ThermoKey): boolean {
  return THERMO_KEYS.every(k => k === except || !chosen[k] || c[k] === chosen[k]);
}

/**
 * For each component, the values that still form a real combination with what
 * is chosen for the OTHER components — so a dropdown never offers a value that
 * leads to "Unknown thermoType".
 */
export function thermoOptions(combos: ThermoCombo[], chosen: Partial<Record<ThermoKey, string>>): Record<ThermoKey, string[]> {
  const out = {} as Record<ThermoKey, string[]>;
  for (const k of THERMO_KEYS) {
    out[k] = [...new Set(combos.filter(c => matches(c, chosen, k)).map(c => c[k]).filter(Boolean))].sort();
  }
  return out;
}

/**
 * A real combination as close as possible to `chosen`: the keys are honoured in
 * order of `priority` (the one the user just changed first), dropping the
 * least important ones until a combination exists. Null only for an empty table.
 */
export function resolveThermo(
  combos: ThermoCombo[],
  chosen: Partial<Record<ThermoKey, string>>,
  priority: ThermoKey[] = [...THERMO_KEYS],
): ThermoCombo | null {
  const order = [...priority, ...THERMO_KEYS.filter(k => !priority.includes(k))];
  for (let keep = order.length; keep >= 0; keep--) {
    const partial: Partial<Record<ThermoKey, string>> = {};
    for (const k of order.slice(0, keep)) if (chosen[k]) partial[k] = chosen[k];
    const hit = combos.find(c => matches(c, partial));
    if (hit) return hit;
  }
  return null;
}

/** Whether `chosen` is exactly one of the installation's combinations. */
export function isRealThermo(combos: ThermoCombo[], chosen: Partial<Record<ThermoKey, string>>): boolean {
  return combos.some(c => THERMO_KEYS.every(k => (c[k] || '') === (chosen[k] || '')));
}

/** The `thermoType` block as the tutorials write it. */
export function thermoTypeBlock(c: Partial<Record<ThermoKey, string>> & { properties?: string }): string {
  const lines: [string, string][] = c.properties
    ? [['type', c.type ?? ''], ['mixture', c.mixture ?? ''], ['properties', c.properties], ['energy', c.energy ?? '']]
    : THERMO_KEYS.map(k => [k, c[k] ?? '']);
  return `thermoType\n{\n${lines.map(([k, v]) => `    ${k.padEnd(16)}${v};`).join('\n')}\n}`;
}
