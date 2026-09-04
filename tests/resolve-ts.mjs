/**
 * Let `node --test` resolve imports the way the app writes them.
 *
 * The source uses the two forms every Next.js project uses — extensionless
 * relative imports (`./case-name`) and the `@/` alias for `src/` — and neither
 * is resolvable by Node's ESM loader, which requires a real file path with a
 * real extension. Without this hook a test that imports `src/lib/wsl-input.ts`
 * fails not on its own behaviour but on that file's own `import './case-name'`.
 *
 * The alternatives were worse. Writing `./case-name.ts` in the app source would
 * put an extension in one import that appears nowhere else in the project and
 * relies on the bundler tolerating it; duplicating the shared code back into
 * both sides is exactly the divergence `case-name.ts` was created to end. A
 * loader used only by the tests keeps the application source idiomatic and
 * costs nothing at runtime.
 *
 * `module.registerHooks` is synchronous and built into Node 22.15+/24, so this
 * adds no dependency. Node's own type stripping then compiles the .ts it points
 * at, which is why the suite needs no build step and no test framework.
 *
 * Used via `--import` in the `test` script; see package.json.
 */

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const projectRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

/** The candidates TypeScript would consider for a specifier with no extension. */
function candidates(base) {
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    // `@/foo` is the project's alias for `src/foo` (see tsconfig paths).
    if (specifier.startsWith('@/')) {
      const base = resolvePath(projectRoot, 'src', specifier.slice(2));
      const hit = existsSync(base) ? base : candidates(base).find(existsSync);
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
    }

    // A relative import with no extension: './case-name' -> './case-name.ts'.
    if (specifier.startsWith('.') && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
      const parentPath = context.parentURL && context.parentURL.startsWith('file:')
        ? fileURLToPath(context.parentURL)
        : null;
      if (parentPath) {
        const base = resolvePath(dirname(parentPath), specifier);
        const hit = candidates(base).find(existsSync);
        if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
      }
    }

    return nextResolve(specifier, context);
  },
});
