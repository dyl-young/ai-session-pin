import {
  latestPerProvider,
  providerFor,
  resolveProviderToken,
  findByPrefix,
  type SessionEntry,
} from "../providers/index.js";
import { loadStore, saveStore, type Pin } from "../store.js";
import { bold, dim, green, yellow } from "../colors.js";
import { relativeTime } from "../time.js";

export type AddOptions = {
  sessionToken?: string;
  name?: string;
  syncName?: boolean;
  /** Short label ("cr") or full id ("cursor"); restricts which tool to pin from. */
  provider?: string;
};

/**
 * Largest gap between the winning session and the next tool's before we stop
 * mentioning the runner-up. This measures the gap, not absolute age: two tools
 * used minutes apart are an ambiguous choice whenever that happened, while a
 * tool last used a day before the winner clearly is not what you meant.
 */
const RUNNER_UP_WINDOW_MS = 24 * 60 * 60 * 1000;

type Located = { entry: SessionEntry; runnerUp?: SessionEntry };

export async function addCommand(opts: AddOptions): Promise<void> {
  const { entry, runnerUp } = await locateSession(opts.sessionToken, opts.provider);

  const store = await loadStore();
  const existing = store.pins.find((p) => p.sessionId === entry.sessionId);
  if (existing) {
    existing.summary = entry.summary || existing.summary;
    existing.firstPrompt = entry.firstPrompt || existing.firstPrompt;
    existing.lastModified = entry.modified || existing.lastModified;
    existing.gitBranch = entry.gitBranch ?? existing.gitBranch;
    const custom = opts.name?.trim();
    if (custom) {
      existing.name = custom;
      existing.nameSource = "user";
    } else if (opts.syncName) {
      if (entry.summary) existing.name = entry.summary;
      existing.nameSource = "provider";
    } else if (existing.nameSource !== "user" && entry.summary) {
      existing.name = entry.summary;
    }
    if (existing.status === "unpinned") {
      existing.status = "pinned";
      existing.pinnedAt = new Date().toISOString();
      await saveStore(store);
      printPinSummary("Re-pinned", existing, { runnerUp });
      return;
    }
    await saveStore(store);
    printPinSummary("Already pinned", existing, { footer: "cache refreshed", runnerUp });
    return;
  }

  const name = opts.name?.trim() || entry.summary || entry.firstPrompt.slice(0, 60) || "untitled";

  const pin: Pin = {
    sessionId: entry.sessionId,
    provider: entry.provider,
    projectPath: entry.projectPath,
    name,
    nameSource: opts.name?.trim() ? "user" : "provider",
    pinnedAt: new Date().toISOString(),
    status: "pinned",
    summary: entry.summary,
    firstPrompt: entry.firstPrompt,
    lastModified: entry.modified,
    gitBranch: entry.gitBranch || undefined,
  };

  store.pins.push(pin);
  await saveStore(store);
  printPinSummary("Pinned", pin, { runnerUp });
}

function printPinSummary(
  verb: string,
  pin: Pin,
  opts: { footer?: string; runnerUp?: SessionEntry } = {},
): void {
  const provider = providerFor(pin.provider);
  console.log(bold(`⚲ ${verb} "${pin.name}"`) + dim(` · ${provider.id}`));
  console.log(
    `  ${dim("id")}  ${green(pin.sessionId)}   ${dim("·")}   ${dim(pin.projectPath)}`,
  );
  if (opts.runnerUp) {
    const other = providerFor(opts.runnerUp.provider);
    console.log(
      `  ${yellow(`${other.id} was also active here ${relativeTime(opts.runnerUp.modified)}`)}` +
        dim(`  ·  pin it with -P ${other.label}`),
    );
  }
  if (opts.footer) console.log(`  ${yellow(opts.footer)}`);
}

async function locateSession(
  token: string | undefined,
  providerToken: string | undefined,
): Promise<Located> {
  const only = providerToken ? resolveProviderToken(providerToken) : undefined;

  if (!token) {
    const cwd = process.cwd();
    if (only) {
      // An explicit --provider is a request, not a hint: fall back to another
      // tool and we would silently pin the thing that was not asked for.
      const latest = await only.latestForCwd(cwd);
      if (!latest) throw new Error(`No ${only.id} sessions found for ${cwd}.`);
      return { entry: latest };
    }
    const perProvider = await latestPerProvider(cwd);
    if (perProvider.length === 0) {
      throw new Error(
        `No agent sessions found for ${cwd}. Provide a session id explicitly.`,
      );
    }
    const [entry, next] = perProvider;
    const recent = next && entry.fileMtime - next.fileMtime <= RUNNER_UP_WINDOW_MS;
    return { entry, runnerUp: recent ? next : undefined };
  }

  const matches = only ? await only.findByPrefix(token) : await findByPrefix(token);
  const scope = only ? ` in ${only.id}` : "";
  if (matches.length === 0) throw new Error(`No session found matching "${token}"${scope}.`);
  if (matches.length > 1) {
    const list = matches
      .map((m) => `  ${m.sessionId}  ${providerFor(m.provider).label}  ${m.summary || m.firstPrompt.slice(0, 50)}`)
      .join("\n");
    throw new Error(`Ambiguous session prefix "${token}". Candidates:\n${list}`);
  }
  return { entry: matches[0] };
}
