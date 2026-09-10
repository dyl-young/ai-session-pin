import { basename } from "node:path";
import {
  Box,
  RGBA,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  createCliRenderer,
  vstyles,
  type KeyEvent,
  type SelectOption,
} from "@opentui/core";
import { loadStore, saveStore, type Pin, type PinStore } from "../store.js";
import { providerFor } from "../providers/index.js";
import { resumePin } from "./resume.js";
import { relativeTime } from "../time.js";

export type FilterScope = "project" | "name";

export type ListOptions = {
  plain?: boolean;
  all?: boolean;
  filter?: string;
  filterBy?: FilterScope;
};

function matchesFilter(pin: Pin, filter: string, scope: FilterScope): boolean {
  const haystack = scope === "name" ? pin.name : pin.projectPath;
  return haystack.toLowerCase().includes(filter.toLowerCase());
}

function otherScope(scope: FilterScope): FilterScope {
  return scope === "project" ? "name" : "project";
}

type Mark = "unpin" | "repin";

type EnrichedPin = {
  pin: Pin;
  nameRefreshed: boolean;
  lastModified?: string;
  gitBranch?: string;
  missing: boolean;
};

export async function listCommand(opts: ListOptions): Promise<void> {
  const store = await loadStore();
  const initialFilter = opts.filter?.trim() ?? "";
  const initialScope: FilterScope = opts.filterBy ?? "project";
  let visiblePins = opts.all
    ? store.pins
    : store.pins.filter((p) => p.status === "pinned");

  if (opts.plain && initialFilter) {
    visiblePins = visiblePins.filter((p) => matchesFilter(p, initialFilter, initialScope));
  }

  if (visiblePins.length === 0) {
    const emptyMsg = initialFilter
      ? `No pinned sessions match ${initialScope} "${initialFilter}".`
      : opts.all
        ? "No pins yet."
        : "No pinned sessions. Run `pin` in a project directory to add one.";
    console.log(emptyMsg);
    return;
  }

  const rows = await Promise.all(visiblePins.map(enrich));
  const nameRefreshed = rows.some((r) => r.nameRefreshed);
  rows.sort((a, b) => (b.lastModified || "").localeCompare(a.lastModified || ""));

  if (opts.plain) {
    if (nameRefreshed) await saveStore(store);
    printPlain(rows);
    return;
  }

  const outcome = await runTui(rows, initialFilter, initialScope);
  await persistChanges(store, outcome.marks, outcome.namesEdited || nameRefreshed);
  if (outcome.action === "resume") {
    await resumePin(outcome.pin, store);
  }
}

async function enrich(pin: Pin): Promise<EnrichedPin> {
  const provider = providerFor(pin.provider);
  const live = (await provider.sessionsForProject(pin.projectPath)).find(
    (e) => e.sessionId === pin.sessionId,
  );
  // Track the agent's own title unless the user has overridden it here, so a
  // /rename inside Claude or Cursor shows up on the next listing.
  let nameRefreshed = false;
  if (pin.nameSource !== "user" && live?.summary && live.summary !== pin.name) {
    pin.name = live.summary;
    nameRefreshed = true;
  }
  return {
    pin,
    nameRefreshed,
    lastModified: live?.modified ?? pin.lastModified,
    gitBranch: live?.gitBranch || pin.gitBranch,
    missing: !live,
  };
}

type TuiOutcome =
  | { action: "resume"; pin: Pin; marks: Map<string, Mark>; namesEdited: boolean }
  | { action: "quit"; marks: Map<string, Mark>; namesEdited: boolean };

type Mode = "normal" | "filter" | "rename";

async function runTui(
  rows: EnrichedPin[],
  initialFilter: string,
  initialScope: FilterScope,
): Promise<TuiOutcome> {
  const renderer = await createCliRenderer({
    screenMode: "split-footer",
    footerHeight: computeFooterHeight(rows.length),
    exitOnCtrlC: false,
    backgroundColor: "transparent",
  });
  const marks = new Map<string, Mark>();
  let filterText = initialFilter;
  let filterScope: FilterScope = initialScope;
  let mode: Mode = "normal";
  let renameText = "";
  let renamingPin: Pin | undefined;
  let namesEdited = false;

  const widths = computeWidths(renderer.width, rows);

  const visible = (): EnrichedPin[] =>
    filterText
      ? rows.filter((r) => matchesFilter(r.pin, filterText, filterScope))
      : rows;

  const select = new SelectRenderable(renderer, {
    options: buildOptions(visible(), marks, widths),
    selectedIndex: 0,
    wrapSelection: true,
    showDescription: false,
    showScrollIndicator: true,
    backgroundColor: "transparent",
    textColor: PALETTE.text,
    selectedBackgroundColor: PALETTE.selectedBg,
    selectedTextColor: PALETTE.selectedText,
    focusedBackgroundColor: "transparent",
    focusedTextColor: PALETTE.text,
    flexGrow: 1,
  });

  const headerText = new TextRenderable(renderer, { content: header(widths), fg: PALETTE.faint });
  const statusText = new TextRenderable(renderer, { content: statusLine(marks), fg: PALETTE.faint });
  const idText = new TextRenderable(renderer, { content: "", fg: PALETTE.dim });
  populateFooter(idText, visible()[0]);
  const hintText = new TextRenderable(renderer, {
    content: hintLine(mode, filterText, renameText, filterScope),
    fg: PALETTE.dim,
  });
  const syncHint = () => {
    hintText.content = hintLine(mode, filterText, renameText, filterScope);
  };

  renderer.root.add(
    Box(
      {
        flexDirection: "column",
        padding: 1,
        gap: 1,
        flexGrow: 1,
        shouldFill: false,
        backgroundColor: "transparent",
      },
      headerText,
      select,
      statusText,
      idText,
      hintText,
    ),
  );

  select.focus();
  renderer.start();

  const rerenderFilter = () => {
    const v = visible();
    select.options = buildOptions(v, marks, widths);
    select.setSelectedIndex(0);
    populateFooter(idText, v[0]);
    syncHint();
  };

  const rerenderRows = () => {
    const v = visible();
    const idx = select.getSelectedIndex();
    select.options = buildOptions(v, marks, widths);
    select.setSelectedIndex(Math.min(idx, Math.max(0, v.length - 1)));
    syncHint();
  };

  return await new Promise<TuiOutcome>((resolve) => {
    const finish = (out: TuiOutcome) => {
      try {
        renderer.destroy();
      } catch {
        // ignore
      }
      resolve(out);
    };

    select.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
      const row = visible()[select.getSelectedIndex()];
      populateFooter(idText, row);
    });

    select.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
      if (mode !== "normal") return;
      const pin = option?.value as Pin | undefined;
      if (!pin) return;
      finish({ action: "resume", pin, marks, namesEdited });
    });

    renderer.keyInput.on("keypress", (key: KeyEvent) => {
      if (mode === "filter") {
        if (key.name === "escape") {
          filterText = "";
          mode = "normal";
          rerenderFilter();
          return;
        }
        if (key.name === "return") {
          mode = "normal";
          syncHint();
          return;
        }
        if (key.name === "tab") {
          filterScope = otherScope(filterScope);
          rerenderFilter();
          return;
        }
        if (key.name === "backspace") {
          filterText = filterText.slice(0, -1);
          rerenderFilter();
          return;
        }
        const ch = printableChar(key);
        if (ch) {
          filterText += ch;
          rerenderFilter();
        }
        return;
      }

      if (mode === "rename") {
        if (key.name === "escape") {
          mode = "normal";
          renamingPin = undefined;
          renameText = "";
          syncHint();
          return;
        }
        if (key.name === "return") {
          const trimmed = renameText.trim();
          if (renamingPin && trimmed && renamingPin.name !== trimmed) {
            renamingPin.name = trimmed;
            renamingPin.nameSource = "user";
            namesEdited = true;
          }
          mode = "normal";
          renamingPin = undefined;
          renameText = "";
          rerenderRows();
          return;
        }
        if (key.name === "backspace") {
          renameText = renameText.slice(0, -1);
          syncHint();
          return;
        }
        const ch = printableChar(key);
        if (ch) {
          renameText += ch;
          syncHint();
        }
        return;
      }

      if (key.name === "escape" || (key.name === "q" && !key.ctrl && !key.meta)) {
        finish({ action: "quit", marks, namesEdited });
        return;
      }
      if (key.ctrl && key.name === "c") {
        finish({ action: "quit", marks, namesEdited });
        return;
      }
      if (key.ctrl && key.name === "x") {
        const pin = currentPin(visible(), select);
        if (pin) {
          const mark: Mark = pin.status === "pinned" ? "unpin" : "repin";
          toggleMark(marks, pin, mark);
          refresh(visible(), marks, widths, select, statusText);
        }
        return;
      }
      if (key.ctrl && key.name === "r") {
        const pin = currentPin(visible(), select);
        if (pin) {
          renamingPin = pin;
          renameText = pin.name;
          mode = "rename";
          syncHint();
        }
        return;
      }
      if (key.name === "/" && !key.ctrl && !key.meta) {
        mode = "filter";
        syncHint();
        return;
      }
      if (key.name === "tab") {
        filterScope = otherScope(filterScope);
        if (filterText) rerenderFilter();
        else syncHint();
        return;
      }
    });
  });
}

function printableChar(key: KeyEvent): string | null {
  if (key.ctrl || key.meta) return null;
  const seq = key.sequence;
  if (typeof seq === "string" && seq.length === 1 && seq >= " " && seq <= "~") return seq;
  return null;
}

function hintLine(
  mode: Mode,
  filterText: string,
  renameText: string,
  scope: FilterScope,
): string {
  if (mode === "filter") {
    return `filter ${scope}: ${filterText}_  ·  ⇥ ${otherScope(scope)}  ·  ⇧ + ⏎ apply  ·  esc clear`;
  }
  if (mode === "rename") return `rename: ${renameText}_  ·  ⇧ + ⏎ save  ·  esc cancel`;
  const base = "↑↓ navigate  ·  ⏎ resume  ·  ^X toggle pin  ·  ^R rename  ·  / filter  ·  q quit";
  return filterText ? `${base}  ·  filter ${scope}: "${filterText}"` : base;
}

function currentPin(rows: EnrichedPin[], select: SelectRenderable): Pin | undefined {
  return rows[select.getSelectedIndex()]?.pin;
}

function toggleMark(marks: Map<string, Mark>, pin: Pin | undefined, mark: Mark) {
  if (!pin) return;
  if (mark === "unpin" && pin.status === "unpinned") return;
  if (mark === "repin" && pin.status === "pinned") return;
  const existing = marks.get(pin.sessionId);
  if (existing === mark) marks.delete(pin.sessionId);
  else marks.set(pin.sessionId, mark);
}

function refresh(
  rows: EnrichedPin[],
  marks: Map<string, Mark>,
  widths: ColumnWidths,
  select: SelectRenderable,
  statusText: TextRenderable,
) {
  const idx = select.getSelectedIndex();
  select.options = buildOptions(rows, marks, widths);
  select.setSelectedIndex(Math.min(idx, Math.max(0, rows.length - 1)));
  statusText.content = statusLine(marks);
}

type ColumnWidths = {
  src: number;
  project: number;
  name: number;
  modified: number;
  prefix: number;
};

const SELECT_INDICATOR_WIDTH = 2; // SelectRenderable prepends "▶ " / "  " to each row

function computeFooterHeight(rowCount: number): number {
  // chrome: padding(2) + 4 gaps + header(1) + status(1) + id(1) + hint(1) = 10
  const chrome = 10;
  const maxSelectVisible = 12;
  const selectRows = Math.min(rowCount, maxSelectVisible);
  const desired = chrome + selectRows;
  const terminalHeight = process.stdout.rows ?? 24;
  // leave at least 6 rows of prompt/scrollback above the footer
  const cap = Math.max(12, terminalHeight - 6);
  return Math.min(desired, cap);
}

const SRC_PROJECT_GAP = "  ";
const PROJECT_NAME_GAP = "    ";
const NAME_MODIFIED_GAP = "  ";

function computeWidths(terminalWidth: number, rows: EnrichedPin[]): ColumnWidths {
  const usable = Math.max(60, terminalWidth - 6 - SELECT_INDICATOR_WIDTH);
  const prefix = 2;
  const gapTotal =
    SRC_PROJECT_GAP.length + PROJECT_NAME_GAP.length + NAME_MODIFIED_GAP.length;
  const src = rows.reduce(
    (acc, r) => Math.max(acc, providerFor(r.pin.provider).label.length),
    "SRC".length,
  );

  const longestModified = rows.reduce((acc, r) => {
    const s = relativeTime(r.lastModified) + (r.missing ? " (stale)" : "");
    return Math.max(acc, s.length);
  }, "MODIFIED".length);
  const modified = Math.min(longestModified + 4, 20);

  const longestProject = rows.reduce(
    (acc, r) => Math.max(acc, basename(r.pin.projectPath).length),
    "PROJECT".length,
  );
  const project = Math.min(longestProject, 25);

  const name = Math.max(10, usable - prefix - gapTotal - modified - project - src);
  return { prefix, src, project, name, modified };
}

function buildOptions(
  rows: EnrichedPin[],
  marks: Map<string, Mark>,
  w: ColumnWidths,
): SelectOption[] {
  return rows.map((row) => ({
    name: formatRow(row, marks, w),
    description: "",
    value: row.pin,
  }));
}

function formatRow(row: EnrichedPin, marks: Map<string, Mark>, w: ColumnWidths): string {
  const mark = marks.get(row.pin.sessionId);
  const prefix = markGlyph(row.pin.status, mark).padEnd(w.prefix);
  return (
    prefix +
    cell(providerFor(row.pin.provider).label, w.src) +
    SRC_PROJECT_GAP +
    cell(basename(row.pin.projectPath), w.project) +
    PROJECT_NAME_GAP +
    cell(row.pin.name, w.name) +
    NAME_MODIFIED_GAP +
    cell(relativeTime(row.lastModified) + (row.missing ? " (stale)" : ""), w.modified)
  );
}

function markGlyph(status: Pin["status"], mark: Mark | undefined): string {
  const willBePinned = mark === "repin" || (status === "pinned" && mark !== "unpin");
  return willBePinned ? " " : "✗";
}

function header(w: ColumnWidths): string {
  return (
    " ".repeat(SELECT_INDICATOR_WIDTH) +
    " ".padEnd(w.prefix) +
    cell("SRC", w.src) +
    SRC_PROJECT_GAP +
    cell("PROJECT", w.project) +
    PROJECT_NAME_GAP +
    cell("NAME", w.name) +
    NAME_MODIFIED_GAP +
    cell("MODIFIED", w.modified)
  );
}

function populateFooter(footer: TextRenderable, row: EnrichedPin | undefined): void {
  footer.clear();
  if (!row) return;
  footer.add(`id  ${row.pin.sessionId}`);
  if (row.gitBranch) {
    footer.add("   ·   branch  ");
    footer.add(vstyles.fg(PALETTE.branch, row.gitBranch));
  }
}

// Colors:
// - text: terminal's own default foreground (theme-adaptive via ANSI \x1b[39m)
// - faint/dim: ANSI 256 mid-greys that read on both light and dark backgrounds
// - selection / branch: hex shades chosen to keep contrast against the blue/white pair
const PALETTE = {
  text: RGBA.defaultForeground(),
  faint: "#9aa0a6",
  dim: "#6e7681",
  selectedBg: "#1f6feb",
  selectedText: "#ffffff",
  branch: "#22c55e",
};

function statusLine(marks: Map<string, Mark>): string {
  let unpin = 0;
  let repin = 0;
  for (const m of marks.values()) {
    if (m === "unpin") unpin++;
    else repin++;
  }
  if (unpin === 0 && repin === 0) return "";
  const parts: string[] = [];
  if (unpin > 0) parts.push(`${unpin} staged for unpin`);
  if (repin > 0) parts.push(`${repin} staged for re-pin`);
  return parts.join("  ·  ") + "  (applies on quit)";
}

function cell(s: string, width: number): string {
  if (width <= 0) return "";
  if (s.length <= width) return s.padEnd(width);
  if (width <= 1) return s.slice(0, width);
  return s.slice(0, width - 1) + "…";
}


async function persistChanges(store: PinStore, marks: Map<string, Mark>, namesEdited: boolean) {
  let changed = namesEdited;
  for (const [sessionId, mark] of marks) {
    const pin = store.pins.find((p) => p.sessionId === sessionId);
    if (!pin) continue;
    const target: Pin["status"] = mark === "unpin" ? "unpinned" : "pinned";
    if (pin.status !== target) {
      pin.status = target;
      changed = true;
    }
  }
  if (changed) await saveStore(store);
}

function printPlain(rows: EnrichedPin[]): void {
  const cols = rows.map((r) => ({
    src: providerFor(r.pin.provider).label,
    project: basename(r.pin.projectPath),
    name: r.pin.name,
    modified: relativeTime(r.lastModified),
    branch: r.gitBranch || "—",
    status: r.pin.status + (r.missing ? " (stale)" : ""),
    id: r.pin.sessionId,
  }));
  const widths = {
    src: max(cols, "src"),
    project: max(cols, "project"),
    name: max(cols, "name"),
    modified: max(cols, "modified"),
    branch: max(cols, "branch"),
    status: max(cols, "status"),
  };
  for (const c of cols) {
    console.log(
      [
        c.src.padEnd(widths.src),
        c.project.padEnd(widths.project),
        c.name.padEnd(widths.name),
        c.modified.padEnd(widths.modified),
        c.branch.padEnd(widths.branch),
        c.status.padEnd(widths.status),
        c.id,
      ].join("  "),
    );
  }
}

function max<T extends Record<string, string>>(rows: T[], key: keyof T): number {
  return rows.reduce((acc, r) => Math.max(acc, String(r[key]).length), 0);
}
