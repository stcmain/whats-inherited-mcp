# whats-inherited-mcp

[![npm](https://img.shields.io/npm/v/whats-inherited-mcp)](https://www.npmjs.com/package/whats-inherited-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Glama](https://glama.ai/mcp/servers/stcmain/whats-inherited-mcp/badge)](https://glama.ai/mcp/servers/stcmain/whats-inherited-mcp)

**You review the code you clone. Almost nobody reviews the part of it that talks to your agent.** An MCP server that enumerates everything in a checkout addressed to an AI agent rather than to you: instruction files, hook commands wired to agent events, MCP servers the repo declares, and the skills and subagents it ships.

## Why

`git diff` shows you code, and you read code. It also shows you three added lines in a `CLAUDE.md`, and you skim those, because they look like documentation. They are not documentation — they are instructions your model will follow.

The surface is bigger than most people picture. A directory you cloned can carry:

- `CLAUDE.md` / `AGENTS.md` / `.cursorrules` — loaded into context and treated as instructions, including **nested** copies deep in the tree that only apply when the agent works in that subdirectory
- hook commands in `.claude/settings.json` — shell wired to fire on tool use, session start, or prompt submit
- `.mcp.json` — MCP servers the repo asks to add, often launched with `npx -y <package>`, which means the code that runs is downloaded at start time and is not the code you reviewed
- `.claude/skills`, `.claude/commands`, `.claude/agents` — capabilities the repo hands the agent

Nothing collects that in one place. This does.

Run against a checkout of [langfuse/langfuse](https://github.com/langfuse/langfuse) at `7d2afa4` — an ordinary, reputable open-source repo, picked precisely because there is nothing wrong with it:

```
# Inherited agent surface

**12 item(s) in this checkout are addressed to an agent, not to you.**

| Surface                       | Count | Detail                                                       |
|-------------------------------|------:|--------------------------------------------------------------|
| Instruction files             |    12 | ~41,848 est. tokens, 5,593 lines your agent is told to follow |
| Hook commands                 |     0 | configured to run on agent events                             |
| MCP servers declared          |     0 | 0 fetch code from a registry at launch                        |
| Skills / commands / subagents | 33 extensions (196 files) | shipped under `.agents/`, available to the agent |

## Worth a look
- 11 instruction file(s) are **not at the repo root** — they apply when the agent
  works in those subdirectories and are easy to miss in review.
```

and `instruction_files` adds:

```
> Counted once, reachable under more than one name (symlinks):
> - `AGENTS.md` ← also `.agents/AGENTS.md`, `CLAUDE.md`
```

Five and a half thousand lines of standing instruction, most of it in files you would never open, in a repo nobody has any reason to distrust. That is the point: the number is large even in the benign case, which is exactly why an unusual entry in it goes unnoticed.

## Tools

| Tool | What it answers |
|---|---|
| `inherited_summary` | The headline: everything in this checkout addressed to an agent. Start here |
| `instruction_files` | Every `CLAUDE.md`/`AGENTS.md`/`.cursorrules`, its size and token cost, and what its `@import` lines pull in — including imports that resolve outside the repo |
| `auto_run_commands` | Hook commands the checkout wires to agent events, and whether the script each references is inside the repo, outside it, or missing |
| `declared_mcp_servers` | MCP servers the repo declares, which of them fetch code at launch, and filesystem paths they are granted outside the checkout |
| `agent_extensions` | Skills, slash commands and subagents the repo ships |

Every tool takes an optional `dir`; it defaults to the working directory.

## Install

Register with Claude Code (available in every session):

```bash
claude mcp add --scope user whats-inherited -- npx -y whats-inherited-mcp
```

Or in any MCP client config:

```json
{
  "mcpServers": {
    "whats-inherited": {
      "command": "npx",
      "args": ["-y", "whats-inherited-mcp"]
    }
  }
}
```

<details>
<summary>From source</summary>

```bash
git clone https://github.com/stcmain/whats-inherited-mcp.git
cd whats-inherited-mcp
npm install && npm run build
# then point your client at node /path/to/whats-inherited-mcp/dist/index.js
```

</details>

Published as [`whats-inherited-mcp`](https://www.npmjs.com/package/whats-inherited-mcp) on npm and as
`io.github.stcmain/whats-inherited-mcp` in the [MCP Registry](https://registry.modelcontextprotocol.io/).

No configuration. No environment variables.

## What it counts, and what it refuses to guess

Inflating this in the alarming direction would be easy and would make the tool useless, so the accounting is deliberately conservative:

- **It does not detect malicious content.** There is no heuristic scanner, no "suspicious phrase" regex, no risk score. Those produce confident false positives on ordinary repos and miss anything written with care. This server tells you *where to look*; you do the reading.
- **Files are counted once.** A repo can expose one file under several names — `CLAUDE.md → AGENTS.md → .agents/AGENTS.md` is a real pattern in the wild. Entries are deduplicated by resolved real path and the aliases are listed, rather than counting the same content three times.
- **`.claude/` is not double-counted.** A skill's own `CLAUDE.md` is reported as a skill, not also as a project instruction file.
- **"No path token identified" is not a safety claim.** When a hook command has no filesystem path this server can confidently extract, it says so and stops. That is a stated gap in the analysis, not a verdict.
- **Import detection is conservative.** Fenced code blocks are stripped first, and an unrooted `@token` only counts when it names a document — so `@scope/pkg` and `@mentions` stay out of the number.

## Honest limitations

- **It reports; it does not judge, and it does not fix.** Nothing is edited, quarantined or scored. Every item it lists is normal in a legitimate repo.
- **Whether your client actually runs project hooks is your client's business.** Clients differ, and they prompt differently and change between versions. This server reports what the files *declare*, not what your client will do with them.
- **Token counts are estimates** (~4 chars/token). Treat them as a ranking and a rough scale, not as billing. Anthropic's tokenizer is not public, so nothing local can do better.
- **Claude Code layout is the model.** Cursor, Windsurf, Cline and Copilot instruction files are recognised, but hook and MCP parsing follows the Claude Code schema.
- **Very large monorepos are truncated.** The walk is depth- and entry-capped; when the cap is hit the output says so and marks the results partial rather than quietly under-reporting.
- **It never reads git history.** It describes the working tree as it is on disk right now, not what a diff changed.
- **Symlinked directories are not followed** (loop risk). Symlinked *files* are.

## Design notes / threat model

This server's whole job is to look at content that may be hostile, so the design assumes it is.

- **It must not become the injection vector it reports on.** The **body of an instruction file is never returned** — only metadata, paths and structured fields parsed out of known JSON config keys. Pasting a repo's `CLAUDE.md` into your context to tell you the repo might contain something bad would be self-defeating.
- **Repo-authored strings are fenced and labelled.** Hook commands and MCP launch lines have to be shown to be useful. They are emitted inside inline code spans with backticks neutralised, pipes escaped and newlines flattened so a crafted string cannot break out of the span or out of a markdown table, and every block carries a standing note that the quoted text is data from the checkout, not instructions.
- **No child processes. No shell. No network. No writes.** The only Node APIs used are `node:fs` reads, `node:path` and `node:os`. There is no `child_process` import anywhere in the source, so nothing in a scanned repo can be executed by scanning it.
- **`dir` is the one model-controlled path**, and it is bounded by construction: it is resolved, real-pathed and required to be an existing directory. Because file bodies are never emitted, pointing it somewhere sensitive discloses filenames and sizes, never contents — and it cannot write, execute or transmit anything.
- **Environment variable values are never read** — only names. `.mcp.json` is a place people leave API keys in plaintext.
- **Bounded work:** depth cap, entry cap, file-size ceiling, and no symlinked-directory traversal.

## Who makes this

Built by [Shift The Culture](https://shifttheculture.media/?utm_source=github&utm_medium=readme&utm_campaign=whats-inherited-mcp) — we run a one-person company on AI agents and ship the tooling we needed ourselves. This server is free and MIT-licensed, no strings.

It has two siblings, both also free and MIT:

- [**whats-running-mcp**](https://github.com/stcmain/whats-running-mcp) — what is *actually* running on the box right now, instead of what an old transcript claims.
- [**whats-loaded-mcp**](https://github.com/stcmain/whats-loaded-mcp) — what is eating your context window before you type: skill descriptions, memory files and their imports.

The rest of that tooling is paid:

- **[Agent Fleet Ops Kit](https://stcai.gumroad.com/l/agent-fleet-ops-kit?wanted=true&utm_source=github&utm_medium=readme&utm_campaign=whats-inherited-mcp)** ($29) — the other failure modes of running three or four agents on one box: two sessions editing the same checkout, a dev server nobody owns (so the agent tests a different app than it edits), and MCP servers leaked from crashed sessions that hold ports and RAM for weeks.
- **[Agent Reliability Kit](https://stcai.gumroad.com/l/agent-reliability-kit?wanted=true&utm_source=github&utm_medium=readme&utm_campaign=whats-inherited-mcp)** ($29) — a Stop hook and two CLIs that block a turn when an agent claims "done" against a repo, URL, or build that was never actually checked.

The server above stays free and MIT either way — it has no upsell in it, no telemetry, and no dependency on the paid kits.

## License

MIT © Zachary Pampu
