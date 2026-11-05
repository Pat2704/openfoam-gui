/**
 * What the Mesh and Results buttons of the agent panels send.
 *
 * They are ordinary user messages — the click is the user asking — written so
 * that the agent reaches for the digest tools and does not run anything. The
 * text is English like the rest of the app, but the answer should come in the
 * user's language, which is taken from the system locale.
 */

/** "Reply in Italian." from the browser/OS locale, or nothing if it is English or unknown. */
export function replyLanguageHint(locale: string | undefined): string {
  if (!locale) return '';
  const code = locale.split('-')[0].toLowerCase();
  if (!code || code === 'en') return '';
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    return name && name.toLowerCase() !== code ? ` Reply in ${name}.` : '';
  } catch {
    return '';
  }
}

export function buildMeshAnalysisRequest(caseName: string, locale?: string): string {
  return `Analyse the mesh of "${caseName}". Use mesh_summary with quality: true, and nothing that changes the case. `
    + 'Tell me: its size and dimensionality (2D/3D, cells, bounding box and whether the units look right), the patches '
    + 'and whether their types fit what they are, the zones, how it is decomposed if it is (balance, interface faces), '
    + 'every quality check that fails or warns and what it will do to the solver, and concrete fixes in order of '
    + `importance.${replyLanguageHint(locale)}`;
}

export function buildResultsAnalysisRequest(caseName: string, locale?: string): string {
  return `Analyse the results of the run in "${caseName}". Use analyze_log, analyze_fields (it covers the processor `
    + 'directories if the case is decomposed) and postprocess_summary; use read_log_excerpt only to look at a place a '
    + 'digest points to. Do not run or change anything. Tell me: whether the run finished, crashed or is still running, '
    + 'and why; how the residuals, continuity errors and Courant number behaved; whether the fields at the latest time '
    + 'are physical; whether the monitored quantities in postProcessing have settled; and the problems you find, with '
    + `their likely cause and fix.${replyLanguageHint(locale)}`;
}
