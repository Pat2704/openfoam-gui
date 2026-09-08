import { createHash } from 'crypto';

export interface InstallationIdentityParts {
  distro: string;
  bashrc: string;
  version: string;
  projectDir: string;
  tutorials: string;
  applicationBin: string;
  metadata: string;
}

/** Pure, deterministic key used by every installation-derived cache. */
export function buildInstallationId(parts: InstallationIdentityParts): {
  id: string; baseId: string; fingerprint: string;
} {
  const base = [
    parts.distro,
    parts.bashrc,
    parts.version,
    parts.projectDir,
    parts.tutorials,
    parts.applicationBin,
  ].join('\0');
  return {
    id: createHash('sha256').update(`${base}\0${parts.metadata}`).digest('hex'),
    baseId: createHash('sha256').update(base).digest('hex'),
    fingerprint: createHash('sha256').update(parts.metadata).digest('hex'),
  };
}
