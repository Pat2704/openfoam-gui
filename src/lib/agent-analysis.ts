/**
 * What the Mesh and Results buttons of the agent panels send.
 *
 * They are ordinary user messages — the click is the user asking — written so
 * that the agent reaches for the digest tools and does not run anything. The
 * panel does not show this text, only a short label (see `label` below), so
 * the transcript reads as the user pressing a button rather than as a prompt
 * they never typed.
 *
 * The request is in English like the rest of the app, which says nothing about
 * the language of the answer. That follows the conversation: the language it
 * has been in, or English when the chat is still empty.
 */

export type AnalysisKind = 'mesh' | 'results';

export const ANALYSIS_LABELS: Record<AnalysisKind, string> = {
  mesh: 'Mesh analysis',
  results: 'Results analysis',
};

function languageInstruction(conversationStarted: boolean): string {
  return conversationStarted
    ? ' Reply in the language this conversation has been in.'
    : ' Reply in English.';
}

export function buildMeshAnalysisRequest(caseName: string, conversationStarted: boolean): string {
  return `Analyse the mesh of "${caseName}". Use mesh_summary with quality: true, and nothing that changes the case. `
    + 'Tell me: its size and dimensionality (2D/3D, cells, bounding box and whether the units look right), the patches '
    + 'and whether their types fit what they are, the zones, how it is decomposed if it is (balance, interface faces), '
    + 'every quality check that fails or warns and what it will do to the solver, and concrete fixes in order of '
    + `importance.${languageInstruction(conversationStarted)}`;
}

export function buildResultsAnalysisRequest(caseName: string, conversationStarted: boolean): string {
  return `Analyse the results of the run in "${caseName}". Use analyze_log, analyze_fields (it covers the processor `
    + 'directories if the case is decomposed) and postprocess_summary; use read_log_excerpt only to look at a place a '
    + 'digest points to. Do not run or change anything. Tell me: whether the run finished, crashed or is still running, '
    + 'and why; how the residuals, continuity errors and Courant number behaved; whether the fields at the latest time '
    + 'are physical; whether the monitored quantities in postProcessing have settled; and the problems you find, with '
    + `their likely cause and fix.${languageInstruction(conversationStarted)}`;
}

export function buildAnalysisRequest(kind: AnalysisKind, caseName: string, conversationStarted: boolean): string {
  return kind === 'mesh'
    ? buildMeshAnalysisRequest(caseName, conversationStarted)
    : buildResultsAnalysisRequest(caseName, conversationStarted);
}
