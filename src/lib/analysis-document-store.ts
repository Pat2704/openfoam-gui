import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateCaseName, WslInputError } from './wsl-input';
import type { AnalysisDocument, AnalysisNamespace } from './analysis-documents';

export const ANALYSIS_DOCUMENT_BYTES = 8 * 1024 * 1024;
const STORE_BYTES = 24 * 1024 * 1024;
const DOCUMENT_LIMIT = 30;
const queues = new Map<string, Promise<unknown>>();

export function analysisNamespace(value: unknown): AnalysisNamespace {
  if (value !== 'postprocess' && value !== 'paraview') throw new WslInputError('Invalid analysis namespace.');
  return value;
}

export function analysisDocumentId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/.test(value)) throw new WslInputError('Invalid saved analysis ID.');
  return value;
}

export function validateAnalysisDocument(value: unknown): AnalysisDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WslInputError('Invalid saved analysis.');
  const document = value as Record<string, unknown>;
  const id = analysisDocumentId(document.id);
  if (typeof document.name !== 'string' || !document.name.trim() || document.name.length > 120 || /[\x00-\x1f]/.test(document.name)) {
    throw new WslInputError('Choose an analysis name of 1–120 characters.');
  }
  if (!document.data || typeof document.data !== 'object' || Array.isArray(document.data)) throw new WslInputError('Invalid analysis data.');
  if (typeof document.savedAt !== 'string' || !Number.isFinite(Date.parse(document.savedAt))) throw new WslInputError('Invalid analysis date.');
  const result = { id, name: document.name.trim(), savedAt: new Date(document.savedAt).toISOString(), data: document.data };
  if (Buffer.byteLength(JSON.stringify(result)) > ANALYSIS_DOCUMENT_BYTES) throw new WslInputError('The saved analysis exceeds the 8 MB limit.');
  return result;
}

/** Paths are derived solely from the server's installation identity and validated case. */
export class AnalysisDocumentStore {
  private root: string;
  constructor(root: string) { this.root = root; }

  private file(namespace: AnalysisNamespace, installation: string, caseName: string): string {
    analysisNamespace(namespace); validateCaseName(caseName);
    if (!installation) throw new Error('OpenFOAM installation identity is unavailable.');
    const scope = createHash('sha256').update(JSON.stringify([installation, caseName])).digest('hex');
    return path.join(this.root, namespace, `${scope}.json`);
  }

  private async read(file: string): Promise<AnalysisDocument[]> {
    let text: string;
    try { text = await readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (Buffer.byteLength(text) > STORE_BYTES) throw new Error('The saved analysis library exceeds its size limit.');
    const value = JSON.parse(text);
    if (value.version !== 1 || !Array.isArray(value.documents) || value.documents.length > DOCUMENT_LIMIT) throw new Error('Unsupported saved analysis library.');
    const documents = value.documents.map(validateAnalysisDocument);
    if (new Set(documents.map((document: AnalysisDocument) => document.id)).size !== documents.length) throw new Error('Duplicate saved analysis IDs.');
    return documents;
  }

  async list(namespace: AnalysisNamespace, installation: string, caseName: string): Promise<AnalysisDocument[]> {
    const file = this.file(namespace, installation, caseName);
    await queues.get(file)?.catch(() => undefined);
    return (await this.read(file)).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  private async mutate(file: string, edit: (documents: AnalysisDocument[]) => AnalysisDocument[]): Promise<void> {
    const pending = (queues.get(file) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const documents = edit(await this.read(file));
      if (documents.length > DOCUMENT_LIMIT) throw new WslInputError('This case already has 30 saved analyses. Delete one before adding another.');
      const content = JSON.stringify({ version: 1, documents });
      if (Buffer.byteLength(content) > STORE_BYTES) throw new WslInputError('This analysis library exceeds the 24 MB limit.');
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, file); }
      finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
    queues.set(file, pending);
    try { await pending; } finally { if (queues.get(file) === pending) queues.delete(file); }
  }

  async save(namespace: AnalysisNamespace, installation: string, caseName: string, value: unknown): Promise<AnalysisDocument> {
    const document = validateAnalysisDocument(value);
    await this.mutate(this.file(namespace, installation, caseName), documents => [...documents.filter(item => item.id !== document.id), document]);
    return document;
  }

  async delete(namespace: AnalysisNamespace, installation: string, caseName: string, value: unknown): Promise<void> {
    const id = analysisDocumentId(value);
    await this.mutate(this.file(namespace, installation, caseName), documents => documents.filter(item => item.id !== id));
  }
}

export function analysisDocumentStore(): AnalysisDocumentStore {
  const root = process.env.OFSTUDIO_USER_DATA
    ? path.join(process.env.OFSTUDIO_USER_DATA, 'analyses')
    : path.join(process.cwd(), '.analysis-documents');
  return new AnalysisDocumentStore(root);
}
