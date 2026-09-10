import { claudeProvider } from "./claude.js";
import { cursorProvider } from "./cursor.js";
import type { Provider, ProviderId, SessionEntry } from "./types.js";

export type { Provider, ProviderId, SessionEntry } from "./types.js";

export const PROVIDERS: Provider[] = [claudeProvider, cursorProvider];

export function providerFor(id: ProviderId): Provider {
  const found = PROVIDERS.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown session provider "${id}".`);
  return found;
}

/** Sessions for one project path, across every provider. */
export async function sessionsForProject(projectPath: string): Promise<SessionEntry[]> {
  const perProvider = await Promise.all(PROVIDERS.map((p) => p.sessionsForProject(projectPath)));
  return perProvider.flat();
}

/** Id-prefix search across every provider. Callers handle 0 or >1 matches. */
export async function findByPrefix(prefix: string): Promise<SessionEntry[]> {
  const perProvider = await Promise.all(PROVIDERS.map((p) => p.findByPrefix(prefix)));
  return perProvider.flat();
}

/**
 * Each provider's most recent session in a directory, newest first. Callers use
 * this to pick a winner and still say what they passed over.
 */
export async function latestPerProvider(cwd: string): Promise<SessionEntry[]> {
  const perProvider = await Promise.all(PROVIDERS.map((p) => p.latestForCwd(cwd)));
  return perProvider
    .filter((e): e is SessionEntry => e !== undefined)
    .sort((a, b) => b.fileMtime - a.fileMtime);
}

/** Most recently touched session in a directory, whichever tool owns it. */
export async function latestForCwd(cwd: string): Promise<SessionEntry | undefined> {
  return (await latestPerProvider(cwd))[0];
}

/**
 * Resolves a --provider value against the registry, accepting either the short
 * label shown in the TUI ("cc") or the full id ("claude"). Validating against
 * PROVIDERS rather than a fixed list means new providers work without changes.
 */
export function resolveProviderToken(token: string): Provider {
  const t = token.trim().toLowerCase();
  const found = PROVIDERS.find((p) => p.id === t || p.label === t);
  if (found) return found;
  const known = PROVIDERS.map((p) => `${p.label} (${p.id})`).join(", ");
  throw new Error(`Unknown provider "${token}". Known providers: ${known}.`);
}
