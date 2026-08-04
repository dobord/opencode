# Documentation–Code Alignment Audit

**Repository:** `dobord/opencode`
**Audited branch:** `dev`
**Audited commit:** `ceb4890ca3651899dd3e2b1564168ab098ac540d`
**Audit date:** 2026-08-04
**Documentation scope:** canonical English documentation under `packages/web/src/content/docs/`

## Executive summary

The audit compared the public documentation with executable command definitions, configuration schemas, permission defaults and tests, built-in agent/tool/skill registries, server implementation, and the generated OpenAPI document.

Thirteen material documentation-drift classes were confirmed. The most important affected security and behavioral expectations: Plan and Build permissions, `.env` read approval, removed built-in agents, conditional tool exposure, the server API contract, and server port selection. All confirmed discrepancies in the canonical English documentation were corrected in this change. One inaccurate CLI help string was also corrected because it repeated the same port-selection mismatch as the documentation.

The audit deliberately did not copy English edits into the 17 translated documentation trees. Those mirrors contain some of the same stale statements and require translation-aware synchronization; they are recorded as residual work rather than being replaced with unreviewed machine translations.

## Methodology

The audit treated code-generated or executable definitions as the source of truth:

- **CLI:** yargs command builders in `packages/opencode/src/cli/cmd/` and command registration in `packages/opencode/src/index.ts`.
- **Runtime flags:** `packages/opencode/src/effect/runtime-flags.ts` plus direct environment reads in runtime code.
- **Configuration:** Effect schemas under `packages/core/src/v1/config/`, configuration merge order in `packages/opencode/src/config/config.ts`, and runtime consumers.
- **Permissions:** built-in agent rules in `packages/opencode/src/agent/agent.ts` and focused permission/read tests.
- **Agents and tools:** `packages/opencode/src/agent/agent.ts`, `packages/opencode/src/tool/registry.ts`, and individual tool definitions.
- **Skills:** `packages/opencode/src/skill/index.ts`, `packages/opencode/src/skill/discovery.ts`, the skills config schema, and skill tests.
- **Server API:** `packages/sdk/openapi.json`, server routing code, and the `/doc` implementation. The generated specification contains **162 paths and 188 operations** at the audited commit.
- **Cross-checks:** stale-claim searches, documented-route-to-OpenAPI comparison, public CLI option comparison, environment-variable comparison, and `git diff --check`.

## Findings and remediations

### DOC-001 — Removed Scout agent remained documented

**Severity:** High
**Status:** Fixed

**Documentation before:** The agents guide claimed three built-in subagents and described a built-in Scout agent. The CLI environment-variable table also included `OPENCODE_EXPERIMENTAL_SCOUT`.

**Code evidence:** `packages/opencode/src/agent/agent.ts` defines only the visible built-in subagents `general` and `explore`. The runtime flag registry contains no Scout flag.

**Remediation:** Removed Scout, corrected built-in counts, and removed the dead environment variable.

### DOC-002 — Built-in agent permission behavior was overstated or incorrect

**Severity:** High
**Status:** Fixed

**Documentation before:** Build was described as having every tool enabled. Plan was described as asking for all edits and all shell commands. Explore was described as strictly read-only.

**Code evidence:**

- Build starts from the normal permission defaults, adds `question` and `plan_enter`, and then applies user overrides.
- Plan denies ordinary `edit` operations, allows Markdown plan files in `.opencode/plans/` and the managed plan directory, allows `question`/`plan_exit`, and inherits the normal `bash` default unless the user restricts it.
- Explore starts from deny-all but explicitly allows search/read/research tools and `bash`; it is edit-disabled, not a general “read-only” sandbox.

**Remediation:** Rewrote the built-in-agent descriptions and use-case summary to match the actual merged rules.

### DOC-003 — Agent metadata contract was incomplete

**Severity:** Medium
**Status:** Fixed

**Documentation before:** `description` was called required, and the agent-level `variant` setting was not described.

**Code evidence:** `description` is optional in the agent schema. Task routing uses descriptions when advertising subagents, while agents without a description can still be invoked manually. `variant` is a public schema field and is applied when the selected model matches the agent's configured model and the provider exposes that variant.

**Remediation:** Marked `description` optional but recommended, explained its routing effect, and documented `variant` with its model constraint.

### DOC-004 — `.env` read policy was documented as deny instead of ask

**Severity:** High
**Status:** Fixed

**Documentation before:** Permission examples and prose implied `.env` reads were denied by default.

**Code evidence:** The built-in read rules are `"*": "allow"`, `"*.env": "ask"`, `"*.env.*": "ask"`, and `"*.env.example": "allow"`. Focused read tests assert the approval behavior.

**Remediation:** Corrected the permission and configuration guides to describe approval prompts rather than denial.

### DOC-005 — Permission/tool names did not match the active registry

**Severity:** Medium
**Status:** Fixed

**Documentation before:** The `edit` permission referred to a generic `patch` name, agent permission tables listed the removed `todoread` tool, and the central permissions guide omitted `todowrite`.

**Code evidence:** Model-dependent patching uses tool ID `apply_patch`, all file mutation tools map to the `edit` permission, and the active todo tool is only `todowrite`.

**Remediation:** Replaced `patch` with `apply_patch`, removed `todoread`, and added `todowrite` to the available permissions.

### DOC-006 — Public CLI options, required arguments, and command aliases had drifted

**Severity:** Medium
**Status:** Fixed

**Documentation before:** The CLI guide omitted public TUI/attach mini-mode options, omitted `run --interactive`, rendered the required attach URL as optional, and presented `auth` without explaining that `providers` is the canonical command. It also omitted the optional provider-login URL.

**Code evidence:**

- TUI and attach expose `--mini`, `--no-replay`, and `--replay-limit`.
- Run exposes `--interactive`/`-i`.
- Attach is declared as `attach <url>` with a required positional.
- `providers` is registered with alias `auth`; `providers login [url]` supports a custom `/.well-known/opencode` auth provider.

**Remediation:** Updated usages, flags, canonical/alias wording, login URL behavior, and platform-neutral credential-path wording.

### DOC-007 — Non-interactive MCP creation was undocumented

**Severity:** Medium
**Status:** Fixed

**Documentation before:** `opencode mcp add` was described only as an interactive wizard.

**Code evidence:** `mcp add [name]` accepts a remote `--url`, repeatable `--header` values, repeatable local `--env` values, or a local command after `--`. Non-interactive additions are written to global config.

**Remediation:** Added remote and local examples, exclusivity rules, persistence scope, and a flags table.

### DOC-008 — Runtime environment-variable reference was stale and semantically inaccurate

**Severity:** Medium
**Status:** Fixed

**Documentation before:** The table omitted active flags, retained a removed Scout flag, and described Exa/Parallel flags as generic enablement or parallel execution.

**Code evidence:** The runtime flag registry and direct consumers expose additional user-facing settings, including pure mode, project-config suppression, embedded-UI suppression, question-tool exposure, local model metadata, diagnostic/storage flags, and experimental transports. Web-search provider selection supports `OPENCODE_WEBSEARCH_PROVIDER=exa|parallel`; `OPENCODE_ENABLE_EXA` and `OPENCODE_ENABLE_PARALLEL` prefer a provider rather than enabling parallel execution.

**Remediation:** Added active variables, removed the dead Scout flag, documented the forced provider override, corrected Exa/Parallel semantics, and narrowed `OPENCODE_DISABLE_EXTERNAL_SKILLS` to compatibility discovery from `.claude/skills` and `.agents/skills`.

### DOC-009 — Configuration reference omitted active schema and merge behavior

**Severity:** Medium
**Status:** Fixed

**Documentation before:** The guide omitted the active Console organization layer in precedence, `logLevel`, conversation `username`, `tool_output`, current compaction controls, and runtime-consumed experimental fields. It also claimed all operations were allowed by default.

**Code evidence:** The configuration loader merges remote, global, custom, project, directory/content, active organization, and managed sources in a defined order. Current schemas and consumers include the newly documented fields. Permission defaults contain safety exceptions.

**Remediation:** Updated precedence and permissions, and added schema-backed sections for logging, username, tool-output truncation, compaction tail/token preservation, and runtime-consumed experimental options.

### DOC-010 — Tool availability and the Task tool were misrepresented

**Severity:** Medium
**Status:** Fixed

**Documentation before:** The tools guide said every built-in tool was always enabled and did not document the Task tool.

**Code evidence:** `ToolRegistry` conditions tools on client, provider, model, and feature flags. Models receive either `edit`/`write` or `apply_patch`; question, LSP, plan, code-mode, and web-search exposure are conditional. Task descriptions include only subagents visible under the current `task` permission, and background work is experiment-gated.

**Remediation:** Explained conditional exposure and model-dependent mutation tools, and added a Task tool section covering permissions, resume behavior, and background gating.

### DOC-011 — Skills guide described validation the runtime does not enforce

**Severity:** Medium
**Status:** Fixed

**Documentation before:** The guide required `description`, claimed strict name/length/directory validation, and omitted configured local paths and remote indexes.

**Code evidence:** The loader requires only a string `name`; `description` is optional. A descriptionless skill loads and remains explicitly addressable but is excluded from the native available-skills advertisement. Name regex, length, and directory matching are not enforced. The schema supports `skills.paths` and `skills.urls`; remote sources resolve `index.json` and cache downloaded content.

**Remediation:** Documented actual frontmatter handling, converted unenforced constraints into portability recommendations, and added local/remote discovery configuration.

### DOC-012 — Server API page conflicted with the generated OpenAPI contract

**Severity:** High
**Status:** Fixed

**Documentation before:** `/doc` was described as an HTML page, Express-style `:id` placeholders were mixed with OpenAPI syntax, several compatibility routes were omitted, and a selective table was presented as the server's API.

**Code evidence:** `/doc` serializes the public OpenAPI document as JSON. The generated spec contains 162 paths and 188 operations, including compatibility, `/api/*`, and `/experimental/*` surfaces.

**Remediation:** Made `/doc` the authoritative contract, explicitly marked the tables non-exhaustive, normalized placeholders, added missing auth/TUI/request/question/PTY summaries, and clarified additional MCP operations. Every endpoint row retained or added in the page was checked against the generated OpenAPI document.

### DOC-013 — Server port behavior was wrong in docs and CLI help

**Severity:** Medium
**Status:** Fixed

**Documentation before:** TUI, Web, and `run --port` help described an unspecified port as random.

**Code evidence:** The server first attempts port `4096`; if unavailable, it falls back to an available port.

**Remediation:** Corrected the Server, Web, and CLI guides and updated the inaccurate `run --port` help string.

## Files changed

- `DOCUMENTATION_CODE_AUDIT.md` — this report.
- `packages/opencode/src/cli/cmd/run.ts` — accurate port fallback help.
- `packages/web/src/content/docs/agents.mdx` — built-ins, permissions, description, variant, tool names.
- `packages/web/src/content/docs/cli.mdx` — CLI arguments/options, providers/auth, MCP add, environment variables.
- `packages/web/src/content/docs/config.mdx` — precedence and active schema fields.
- `packages/web/src/content/docs/permissions.mdx` — active permission IDs and `.env` defaults.
- `packages/web/src/content/docs/server.mdx` — OpenAPI source, route syntax/scope, API summaries, port behavior.
- `packages/web/src/content/docs/skills.mdx` — actual validation and discovery behavior.
- `packages/web/src/content/docs/tools.mdx` — conditional exposure and Task.
- `packages/web/src/content/docs/web.mdx` — actual port fallback.

## Validation

Completed in the audit environment:

- `git diff --check`.
- Compared every documented server endpoint row with `packages/sdk/openapi.json`; all documented method/path pairs resolve.
- Counted generated API coverage: 162 paths / 188 operations.
- Compared public yargs options for the touched commands with CLI documentation.
- Compared documented runtime variables with the runtime flag registry and direct web-search override.
- Searched canonical English docs for removed/stale claims (`Scout`, the dead Scout flag, random-port wording, HTML `/doc`, Express-style session placeholders, and denied `.env` wording).
- Reviewed built-in agent and permission rules against their source and focused tests.
- Reviewed tool and skill documentation against runtime registries, schemas, discovery code, and tests.

The full Bun-based documentation build and test suite were not executed because Bun and repository dependencies are not available in this environment. The changes are primarily Markdown; the only TypeScript change is a help-string correction.

## Residual risks and intentionally excluded scope

1. **Translated documentation mirrors:** 17 localized trees contain some corresponding stale statements. They should be updated through the project's translation workflow or by language reviewers; this audit avoids inserting unreviewed English or machine translations into them.
2. **Hand-maintained API summaries:** The Server page is now explicitly non-exhaustive. `/doc` must remain the source of truth for client generation and exact schemas.
3. **Declared but non-functional experimental fields:** `OPENCODE_EXPERIMENTAL_REFERENCES` and schema-only experimental fields without a production consumer were not advertised as working features.
4. **Internal environment variables:** process/bootstrap/test variables were excluded from the user-facing table unless they represent a supported public control.

## Preventing recurrence

- Generate or validate CLI reference tables from public yargs builders in CI.
- Add a documentation test that resolves every method/path row in `server.mdx` against `openapi.json`.
- Add schema-to-doc coverage assertions for stable top-level config keys and runtime flags.
- Add focused snapshots for built-in agent inventory and permission defaults.
- Treat translated documents as tracked derivatives of the canonical English pages and surface source-page drift in the translation workflow.
