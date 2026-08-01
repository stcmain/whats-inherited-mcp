/**
 * Scanning layer — pure, read-only, bounded.
 *
 * Hard rules enforced here:
 *  - No child processes, no shell, no network. `fs` reads only.
 *  - The BODY of an instruction file is never returned to the caller. Only
 *    metadata (size, estimated tokens, path) and structured fields parsed out
 *    of known JSON config keys ever leave this module.
 *  - Every walk is depth-capped and entry-capped so a mis-aimed `dir` cannot
 *    turn into a whole-disk enumeration.
 */

import {
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
  existsSync,
  type Dirent,
} from "node:fs";
import { join, relative, resolve, sep, dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();

/** Characters per token. ~4 is the usual English-prose approximation. ESTIMATE ONLY. */
const CHARS_PER_TOKEN = 4;
export const estTokens = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN);

/** Bounds. A checkout that exceeds these is reported as truncated, never silently cut. */
const MAX_DEPTH = 8;
const MAX_ENTRIES = 40_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Directories that never contain first-party agent config worth reporting. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target",
  "vendor", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".cache",
  ".turbo", ".gradle", "Pods", ".terraform", "coverage", ".pytest_cache",
]);

/**
 * Skipped by the instruction-file walk specifically. Everything under `.claude`
 * is agent config reported by `agent_extensions` / `auto_run_commands`; counting
 * a skill's own CLAUDE.md as a project instruction file too would double-count it.
 */
const INSTRUCTION_SKIP_DIRS = new Set([".claude"]);

/**
 * Files that a coding agent reads as INSTRUCTIONS rather than as source.
 * Kept to formats that are actually auto-loaded by a shipping agent, so the
 * count stays defensible rather than impressive.
 */
const INSTRUCTION_FILES: ReadonlyArray<{ name: string; agent: string }> = [
  { name: "CLAUDE.md", agent: "Claude Code" },
  { name: "CLAUDE.local.md", agent: "Claude Code (local)" },
  { name: "AGENTS.md", agent: "Codex / agents.md convention" },
  { name: ".cursorrules", agent: "Cursor" },
  { name: ".windsurfrules", agent: "Windsurf" },
  { name: ".clinerules", agent: "Cline" },
  { name: ".rules", agent: "generic" },
];

/** Nested path -> agent, for instruction files that do not sit at a directory root. */
const NESTED_INSTRUCTION_PATHS: ReadonlyArray<{ rel: string; agent: string }> = [
  { rel: join(".github", "copilot-instructions.md"), agent: "GitHub Copilot" },
];

export type PathClass = "in-repo" | "outside-repo" | "missing" | "unresolved";

export interface ImportRef {
  raw: string;
  resolved: string | null;
  klass: PathClass;
}

export interface InstructionFile {
  rel: string;
  agent: string;
  bytes: number;
  tokens: number;
  lines: number;
  depth: number;
  imports: ImportRef[];
  /** Other paths in the checkout that resolve to this same file (symlinks). */
  aliases: string[];
}

export interface HookEntry {
  event: string;
  matcher: string | null;
  command: string;
  type: string;
  source: string;
  pathToken: string | null;
  klass: PathClass;
}

export interface McpEntry {
  name: string;
  command: string | null;
  args: string[];
  envKeys: string[];
  source: string;
  fetchesAtLaunch: boolean;
  externalPaths: string[];
  url: string | null;
}

export interface ExtensionEntry {
  kind: "skill" | "command" | "subagent" | "plugin";
  name: string;
  rel: string;
  bytes: number;
}

export interface ScanResult {
  root: string;
  rootDisplay: string;
  instructionFiles: InstructionFile[];
  hooks: HookEntry[];
  mcpServers: McpEntry[];
  extensions: ExtensionEntry[];
  settingsFiles: string[];
  truncated: boolean;
  entriesSeen: number;
}

/* ------------------------------------------------------------------ *
 * Low-level helpers
 * ------------------------------------------------------------------ */

export function displayPath(p: string): string {
  return p.startsWith(HOME) ? p.replace(HOME, "~") : p;
}

function readTextSafe(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJsonSafe(path: string): Record<string, unknown> | null {
  const raw = readTextSafe(path);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the caller-supplied directory.
 * Throws on anything that is not an existing directory, so a bad `dir` fails
 * loudly instead of silently scanning something adjacent.
 */
export function resolveRoot(dir?: string): string {
  const candidate = resolve(dir && dir.trim() ? dir.trim() : process.cwd());
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new Error(`Directory does not exist: ${displayPath(candidate)}`);
  }
  if (!statSync(real).isDirectory()) {
    throw new Error(`Not a directory: ${displayPath(real)}`);
  }
  return real;
}

/** True when `child` is inside `root` (after normalisation). */
function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Classify an already-resolved absolute path relative to the scan root. */
function classify(root: string, abs: string): PathClass {
  if (!existsSync(abs)) return "missing";
  return isInside(root, abs) ? "in-repo" : "outside-repo";
}

/* ------------------------------------------------------------------ *
 * Instruction files
 * ------------------------------------------------------------------ */

/** Strip fenced code blocks so examples inside docs are not counted as imports. */
function stripFences(text: string): string {
  return text.replace(/^```[\s\S]*?^```/gm, "").replace(/^~~~[\s\S]*?^~~~/gm, "");
}

/**
 * Claude Code memory imports look like `@./path`, `@~/path`, `@/abs/path` or
 * `@dir/file.md`. Deliberately conservative: a token must look like a path
 * (contain `/`) to count, which excludes `@mentions` and npm scopes.
 */
function parseImports(root: string, fileAbs: string, body: string): ImportRef[] {
  const out: ImportRef[] = [];
  const seen = new Set<string>();
  const re = /(?:^|\s)@((?:~|\.{1,2})?\/[^\s`'")\]]+|[A-Za-z0-9_.-]+\/[^\s`'")\]]+)/g;
  const DOC_EXT = /\.(md|markdown|mdc|txt|rst)$/i;
  let m: RegExpExecArray | null;

  while ((m = re.exec(stripFences(body))) !== null) {
    const raw = m[1];
    if (seen.has(raw)) continue;

    // Conservative: an unrooted token only counts as an import when it names a
    // document. This keeps npm scopes and `@org/handle` mentions out of the count.
    const rooted = /^(?:[~.]|\/)/.test(raw);
    if (!rooted && !DOC_EXT.test(raw)) continue;
    seen.add(raw);

    let resolved: string | null = null;
    try {
      if (raw.startsWith("~/")) resolved = join(HOME, raw.slice(2));
      else if (isAbsolute(raw)) resolved = raw;
      else resolved = resolve(dirname(fileAbs), raw);
    } catch {
      resolved = null;
    }

    out.push({
      raw,
      resolved,
      klass: resolved === null ? "unresolved" : classify(root, resolved),
    });
  }
  return out;
}

function makeInstructionFile(
  root: string,
  abs: string,
  agent: string,
): InstructionFile | null {
  const body = readTextSafe(abs);
  if (body === null) return null;
  const rel = relative(root, abs) || ".";
  return {
    rel,
    agent,
    bytes: Buffer.byteLength(body, "utf8"),
    tokens: estTokens(body.length),
    lines: body.split("\n").length,
    depth: rel === "." ? 0 : rel.split(sep).length - 1,
    imports: parseImports(root, abs, body),
    aliases: [],
  };
}

/** True for regular files and for symlinks that resolve to a regular file. */
function isFileLike(e: Dirent, abs: string): boolean {
  if (e.isFile()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Hooks (from project-scoped settings only)
 * ------------------------------------------------------------------ */

/**
 * Pull the first token from a hook command that is confidently a filesystem
 * path. Returns null when none is identifiable — the caller reports that as
 * "not analysed", never as "safe".
 */
function extractPathToken(command: string): string | null {
  // Matches $CLAUDE_PROJECT_DIR/..., ~/..., ./..., ../... and bare /absolute/...
  const m = command.match(
    /(?:\$\{?CLAUDE_PROJECT_DIR\}?|\$\{?CLAUDE_PLUGIN_ROOT\}?|~|\.{1,2})?\/[^\s"';|&)]+/,
  );
  return m ? m[0] : null;
}

/**
 * Resolve a path token to an absolute path. Relative tokens resolve against the
 * checkout root, which is the working directory a project hook runs in.
 */
function resolvePathToken(root: string, token: string): { abs: string | null; klass: PathClass } {
  let t = token
    .replace(/^\$\{?CLAUDE_PROJECT_DIR\}?/, root)
    .replace(/^\$\{?CLAUDE_PLUGIN_ROOT\}?/, root);
  if (t.startsWith("~/")) t = join(HOME, t.slice(2));
  if (!isAbsolute(t)) t = resolve(root, t);
  return { abs: t, klass: classify(root, t) };
}

function parseHooks(root: string, settingsAbs: string): HookEntry[] {
  const json = readJsonSafe(settingsAbs);
  if (!json) return [];
  const hooks = json.hooks;
  if (!hooks || typeof hooks !== "object") return [];

  const out: HookEntry[] = [];
  for (const [event, matchers] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      if (!matcher || typeof matcher !== "object") continue;
      const m = matcher as Record<string, unknown>;
      const inner = Array.isArray(m.hooks) ? m.hooks : [];
      for (const h of inner) {
        if (!h || typeof h !== "object") continue;
        const hook = h as Record<string, unknown>;
        const command = typeof hook.command === "string" ? hook.command : null;
        if (!command) continue;
        const token = extractPathToken(command);
        const res = token ? resolvePathToken(root, token) : { abs: null, klass: "unresolved" as PathClass };
        out.push({
          event,
          matcher: typeof m.matcher === "string" && m.matcher ? m.matcher : null,
          command,
          type: typeof hook.type === "string" ? hook.type : "command",
          source: relative(root, settingsAbs),
          pathToken: token,
          klass: res.klass,
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * MCP servers declared by the checkout
 * ------------------------------------------------------------------ */

/** Launchers that fetch and execute code from a registry at start time. */
const FETCHING_LAUNCHERS = new Set(["npx", "bunx", "pnpx", "uvx", "pipx", "dlx"]);

function parseMcp(root: string, abs: string): McpEntry[] {
  const json = readJsonSafe(abs);
  if (!json) return [];
  const servers = json.mcpServers ?? json.servers;
  if (!servers || typeof servers !== "object") return [];

  const out: McpEntry[] = [];
  for (const [name, vRaw] of Object.entries(servers as Record<string, unknown>)) {
    if (!vRaw || typeof vRaw !== "object") continue;
    const v = vRaw as Record<string, unknown>;
    const command = typeof v.command === "string" ? v.command : null;
    const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === "string") : [];
    const env = v.env && typeof v.env === "object" ? Object.keys(v.env as object) : [];
    const base = command ? command.split(/[\\/]/).pop() ?? command : "";

    const externalPaths: string[] = [];
    for (const a of args) {
      if (!a.startsWith("/") && !a.startsWith("~/")) continue;
      const t = a.startsWith("~/") ? join(HOME, a.slice(2)) : a;
      if (!isInside(root, t)) externalPaths.push(a);
    }

    out.push({
      name,
      command,
      args,
      envKeys: env,
      source: relative(root, abs),
      fetchesAtLaunch: FETCHING_LAUNCHERS.has(base),
      externalPaths,
      url: typeof v.url === "string" ? v.url : null,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Repo-shipped agent extensions
 * ------------------------------------------------------------------ */

function listExtensions(root: string): ExtensionEntry[] {
  const out: ExtensionEntry[] = [];

  const addDirOfMd = (relDir: string, kind: ExtensionEntry["kind"]) => {
    const abs = join(root, relDir);
    if (!existsSync(abs)) return;
    for (const f of walk(abs, 3)) {
      if (!f.endsWith(".md")) continue;
      const bytes = statSync(f).size;
      const rel = relative(root, f);
      if (out.some((e) => e.rel === rel)) continue; // root and nested passes can overlap
      out.push({ kind, name: relative(abs, f), rel, bytes });
    }
  };

  // Both conventions ship agent extensions: `.claude/` and `.agents/`. Scanning
  // only `.claude/` made this tool report "ships no skills" about repos that
  // ship them under `.agents/` — while its own instruction-file list showed
  // those same files. Look for `.agents/` at the repo root AND nested (e.g.
  // `web/.agents/skills`), which monorepos use per package.
  const EXT_KINDS: [string, ExtensionEntry["kind"]][] = [
    ["skills", "skill"],
    ["commands", "command"],
    ["agents", "subagent"],
  ];

  for (const container of [".claude", ".agents"]) {
    for (const [sub, kind] of EXT_KINDS) addDirOfMd(join(container, sub), kind);
  }

  // Nested `.agents/` directories, bounded: only look a couple of levels down
  // so a large monorepo stays cheap to scan.
  const NESTED_SKIP = new Set([
    "node_modules", ".git", "dist", "build", ".next", "vendor", "target", "coverage",
  ]);
  const findNested = (dir: string, depth: number) => {
    if (depth > 2) return;
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !NESTED_SKIP.has(d.name))
        .map((d) => d.name);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      if (name === ".agents" || name === ".claude") {
        if (abs === join(root, name)) continue; // root already covered above
        for (const [sub, kind] of EXT_KINDS) addDirOfMd(relative(root, join(abs, sub)), kind);
        continue;
      }
      if (name.startsWith(".")) continue;
      findNested(abs, depth + 1);
    }
  };
  findNested(root, 0);

  for (const marker of [".claude-plugin", join(".claude", "plugins")]) {
    const abs = join(root, marker);
    if (existsSync(abs)) {
      out.push({ kind: "plugin", name: marker, rel: marker, bytes: 0 });
    }
  }
  return out;
}

/** Bounded recursive file walk. Returns absolute file paths. */
function walk(dir: string, maxDepth: number, depth = 0, acc: string[] = []): string[] {
  if (depth > maxDepth || acc.length > 5000) return acc;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && depth > 0) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, maxDepth, depth + 1, acc);
    } else if (e.isFile()) {
      acc.push(p);
    }
  }
  return acc;
}

/* ------------------------------------------------------------------ *
 * Top-level scan
 * ------------------------------------------------------------------ */

export function scan(root: string, maxDepth = MAX_DEPTH): ScanResult {
  const instructionFiles: InstructionFile[] = [];
  const settingsFiles: string[] = [];
  let entriesSeen = 0;
  let truncated = false;

  const byName = new Map(INSTRUCTION_FILES.map((f) => [f.name, f.agent]));

  /**
   * One entry per real file. A repo may expose the same file under several
   * names (`CLAUDE.md -> AGENTS.md -> .agents/AGENTS.md` is a real pattern);
   * counting each alias separately would inflate both the file count and the
   * token total, so aliases are recorded against the first path seen.
   */
  const byReal = new Map<string, InstructionFile>();

  const record = (abs: string, agent: string): void => {
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return;
    }
    const rel = relative(root, abs) || ".";
    const existing = byReal.get(real);
    if (existing) {
      if (existing.rel !== rel && !existing.aliases.includes(rel)) existing.aliases.push(rel);
      // Prefer the shallowest path as the canonical one.
      const depth = rel.split(sep).length - 1;
      if (depth < existing.depth) {
        existing.aliases = existing.aliases.filter((a) => a !== rel).concat(existing.rel);
        existing.rel = rel;
        existing.depth = depth;
      }
      return;
    }
    const f = makeInstructionFile(root, abs, agent);
    if (f) byReal.set(real, f);
  };

  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth || truncated) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++entriesSeen > MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const abs = join(dir, e.name);
      // Symlinked directories are not followed: they are a loop risk and their
      // real target is reached through its own path when it lives in the tree.
      if (e.isDirectory() && !e.isSymbolicLink()) {
        if (SKIP_DIRS.has(e.name) || INSTRUCTION_SKIP_DIRS.has(e.name)) continue;
        visit(abs, depth + 1);
      } else if (isFileLike(e, abs)) {
        const agent = byName.get(e.name);
        if (agent) record(abs, agent);
      }
    }
  };

  visit(root, 0);

  for (const { rel, agent } of NESTED_INSTRUCTION_PATHS) {
    const abs = join(root, rel);
    if (existsSync(abs)) record(abs, agent);
  }

  instructionFiles.push(...byReal.values());

  const hooks: HookEntry[] = [];
  for (const rel of [join(".claude", "settings.json"), join(".claude", "settings.local.json")]) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    settingsFiles.push(rel);
    hooks.push(...parseHooks(root, abs));
  }

  const mcpServers: McpEntry[] = [];
  for (const rel of [".mcp.json", join(".claude", ".mcp.json"), join(".vscode", "mcp.json")]) {
    const abs = join(root, rel);
    if (existsSync(abs)) mcpServers.push(...parseMcp(root, abs));
  }

  instructionFiles.sort((a, b) => b.tokens - a.tokens || a.rel.localeCompare(b.rel));

  return {
    root,
    rootDisplay: displayPath(root),
    instructionFiles,
    hooks,
    mcpServers,
    extensions: listExtensions(root),
    settingsFiles,
    truncated,
    entriesSeen,
  };
}
