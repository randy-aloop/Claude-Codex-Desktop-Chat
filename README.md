# Claude-Codex Desktop Chat Pairing

Pair a **Codex thread (worker)** with a **Claude thread (reviewer)** and run a supervised work loop between them: Codex does the work, Claude reviews and instructs, a human gates every ruling, and everything lands in an audit ledger.

Zero dependencies. Node ≥ 18. Windows, macOS, Linux. The MCP server and its tools are named `reviewloop` internally — keep that name in configs.

```
┌──────────────┐  submit_for_review   ┌────────────┐   review + ruling   ┌───────────────┐
│ Codex thread │ ───────────────────► │   daemon   │ ──────────────────► │ Claude thread │
│   (worker)   │ ◄─────────────────── │  (local)   │ ◄────────────────── │  (reviewer)   │
└──────────────┘    await_ruling      └─────┬──────┘    human approves   └───────────────┘
                                      ledger, keys, tickets, checks, stop policy
```

## Why it exists

The Codex desktop app owns its threads in memory — nothing outside can safely write to them. This bridge inverts the direction: **the worker calls out** through its own MCP server, so there is never a second writer, and a thread that never opts in is structurally unreachable. Claude cannot touch a Codex thread; it can only answer one that asked.

## Contents

| File | Role |
| --- | --- |
| `shim.js` | stdio MCP server — register the same file in **both** Codex and Claude. Auto-spawns the daemon. `--selftest` runs the whole protocol with no AI. |
| `daemon.js` | single persistent local process: pairs, tickets, long-polls, ledger, standing rules, git checks, stop policy, subprocess reviews. `127.0.0.1` only, token-authed. `--stop` to stop. |
| `rl.js` | CLI client (`rl <tool> key=value…` or `rl <tool> @params.json`) — drive any tool from a shell, CI, or a session without MCP registration. |
| `install.js` | one-command installer/uninstaller for both sides. |
| `prompts.md` | reference protocol prompts (superseded by the generated ones from `loop_setup`). |

State lives in `~/.reviewloop/` (override: `REVIEWLOOP_HOME`): `state.json` (pairs/tickets, survives restarts), `ledger.jsonl` (append-only audit of every register/link/submit/ruling), `standing-rules.md`, `daemon.log`, `daemon.json` (port/pid/token), `config.json` (see below).

## Install

```
npm install -g claude-codex-desktop-chat-pairing          # or: npm i -g <file>.tgz / github:randy-aloop/Claude-Codex-Desktop-Chat
reviewloop-install
```

The installer:

- appends a marked `[mcp_servers.reviewloop]` block to Codex `config.toml` (backup written; checks `--codex-config <path>`, `$CODEX_HOME`, `~/.codex`). **Codex desktop-app users:** your config lives in the app's home, not `~/.codex` — pass `--codex-config`.
- registers with Claude via `claude mcp add --scope user` (prints the manual `.mcp.json` snippet if the CLI is absent).
- writes `config.json` with `codex_sessions_dir` for the worker heartbeat (`--sessions-dir` to override).
- runs the selftest.

**Restart Codex and Claude Code afterwards** — MCP servers load at startup. `reviewloop-install --uninstall` reverts both sides.

`config.json` keys: `codex_sessions_dir` (heartbeat), `reviewer_cmd` (subprocess-mode command template, default `["claude","--resume","{thread}","-p","{prompt}","--output-format","json"]`).

## Quickstart — fresh run

1. **Install + restart** (above).
2. **Set up the pair** from any shell:

   ```
   rl loop_setup @setup.json
   ```

   ```json
   {
     "codex_thread_id":  "<selected Codex thread id>",
     "claude_thread_id": "<selected Claude session id>",
     "repo":             "<absolute repo path>",
     "reviewer_paths":   ["docs/reviews/"],
     "stop":             { "max_directives": 10, "max_minutes": 120 },
     "reviewer_mode":    "live"
   }
   ```

   Returns pre-bound keys, **warnings for the chosen mode**, and two generated prompts.
3. **Paste** `worker_prompt` into the Codex thread and `reviewer_prompt` into the Claude thread.
4. **Pairing report:** each side runs `loop_confirm` and reports `PAIRING CONFIRMED` (thread-verified) or `PAIRING FAILED` (prompt pasted into the wrong thread). `rl loop_status key=<REV-…>` shows both confirmations plus the worker heartbeat.
5. **Start:** Codex submits a ready ticket; the reviewer asks your human for the task **plus the model and effort for Codex**; give it in the Claude thread. The loop then runs directive → work → checks → review → your approval → next directive.

## Reviewer modes

### `live` (default)

A Claude session you keep open. It blocks on `await_work`, wakes on submissions, drafts rulings, and submits only after you approve in-conversation.

> **Warning (emitted by `loop_setup`):** an idle listening session re-polls ~every 150 s ≈ 24 inferences/hour paying full thread context, per side. Park the loop with `done:true` when not supervising; re-arming is one paste.

### `subprocess`

No reviewer session at all. The daemon runs `claude --resume <claude_thread_id> -p …` the moment the worker submits; the ruling comes back as a **proposal** you approve, edit, or reject with `loop_approve`. Zero tokens between submissions; the Claude thread is never pasted into.

> **Warnings (emitted by `loop_setup`):**
> - you will not watch the reviewer think — rulings arrive as proposals;
> - requires the Claude Code CLI to reach the thread: verify once with `claude --resume <id> -p "reply OK"` — if that fails, reviews fail and the worker waits;
> - `approval:"auto"` **removes the human gate entirely** — rulings are applied with no human in the loop. Not recommended for work that writes files;
> - each review pays the reviewer thread's full context as input, growing as rulings append.

Failures are loud: a dead review subprocess surfaces to the waiting worker as `REVIEW FAILED: <reason>` on its next poll, and `loop_status` lists pending proposals and review errors.

## Tools (13)

| Tool | Who | Purpose |
| --- | --- | --- |
| `loop_setup` | human/any | create a pair from two thread IDs; returns keys, generated prompts, mode warnings |
| `loop_confirm {key, thread_id?}` | both | confirm one side; thread-ID mismatch → `PAIRING FAILED` |
| `loop_register {role, label}` | both | manual opt-in (legacy path without loop_setup) |
| `loop_link {key_a, key_b, repo?, reviewer_paths?}` | either | manual pair creation |
| `loop_status {key?}` | any | confirmations, open tickets, proposals, review errors, winding-down, worker heartbeat |
| `loop_unlink {key}` | both | end pair; keys survive for re-linking (reviewer succession) |
| `submit_for_review {key, handoff}` | worker | file a ticket; in subprocess mode also launches the review |
| `await_ruling {key, ticket, timeout_ms?}` | worker | bounded block; `pending` → call again; surfaces review state/failures |
| `await_work {key, timeout_ms?}` | reviewer | bounded block; `pending` → call again |
| `submit_ruling {key, ticket, ruling}` | reviewer | deliver a ruling (live mode / manual) |
| `loop_approve {key, ticket, decision, relay_edit?}` | human | approve / edit-then-approve / reject a subprocess proposal |
| `get_standing_rules {key}` | both | read durable rules; curate the file by hand |
| `get_checks {key, ticket}` | any | git verification — report vs reality + delta ownership; fails closed |

## The contract

**Handoff (worker → reviewer):** `stop_reason` (`completed | blocked_needs_ruling | precondition_failed | aborted`), `directive_id` (echo of the ruling being executed), `summary`, `tree {branch, head, index, tracked_delta, untracked}`, `changed_files` (checked against `git diff` — a wrong list is worse than a long one), `commands_run`, `tests` / `blockers` / `questions` (required-but-nullable), `confidence`, `context_warning: true` when the thread nears its limit.

**Ruling (reviewer → worker):** `verdict` (`approve | revise | rule | abort`), `relay` (delivered **verbatim** — it is the next instruction), `stop_when` (observable condition ending the next unit), `expected` (checkable outcomes), `do_not` (scope fences), `codex_settings {model, effort}` (advisory passthrough — Codex cannot switch its own model; it must state so if it can't apply them), `standing_rule` (appends a durable policy), `done` (true only when the whole task is finished — a good iteration is `approve` + `done:false`). The daemon stamps a monotonic `directive_id` on every ruling.

**Checks:** with `repo` set, `get_checks` compares the handoff's `changed_files` to `git diff --name-only` (report vs reality) and classifies each change against `reviewer_paths` as `reviewer_only | worker | mixed | clean` — so a reviewer-owned record edit is never mistaken for worker drift. No repo → `could_not_verify`, never a silent pass.

## Stopping (steps 6–7, user-defined)

A run ends when the **first** of these fires:

1. **Stop policy** — `stop: {max_directives, max_minutes}` at setup. Enforced by the daemon: at the budget the pair flips to winding-down; past it, any ruling without `done:true` is **rejected**.
2. **Context limit** — worker sends `context_warning: true`, or the reviewer's own context runs low → winding-down → close after the current unit.
3. **Reviewer judgement** — `verdict:"approve", done:true` when the work is complete.
4. **The human** — abort at the gate, `loop_unlink`, or an `abort` ruling, at any time.

## Token cost, honestly

- The dominant costs are **idle polling** (live mode) and **thread length** — every step pays the full context as input. Use subprocess mode, rotate worker threads per task, park with `done:true`.
- MCP tool schemas add ~2K tokens to every turn of every session where the server is registered. Scope registration per-project if that matters to you.
- A blocking tool call costs nothing while it waits; only `pending` **re-calls** spend tokens. Awaits are bounded (default 25 s, cap 160 s) below common client timeouts, with progress notifications when a `progressToken` is supplied.

## Troubleshooting

- **Tools missing in a thread** → the app wasn't restarted after install, or (desktop app) the block went to `~/.codex` instead of the app home. Re-run with `--codex-config`.
- **`PAIRING FAILED`** → the prompt was pasted into a different thread than declared in `loop_setup`. Re-paste into the right one.
- **Worker stuck `pending`, live reviewer silent** → check `loop_status` worker heartbeat and reviewer window; a listener whose turn ended must be re-armed (one paste). The worker prompt makes Codex announce `mailbox closing` when it can.
- **`REVIEW FAILED: spawn failed`** (subprocess) → the Claude CLI isn't on PATH or can't resume the thread; run the verify command from the setup warning.
- **Daemon** → `rl loop_status` respawns it on demand; `node daemon.js --stop` stops it; state survives restarts.

## Version history

- **0.5.0** — `reviewer_mode: subprocess` (`claude --resume` per submission, zero idle), `loop_approve` gate with relay edit, `approval: human|auto`, mode warnings at setup.
- **0.4.0** — one-command installer (both sides, idempotent, uninstall), daemon-enforced stop policy, npm bins.
- **0.3.0** — `loop_setup` thread-ID pairing with generated prompts, `loop_confirm` mismatch detection, `codex_settings` passthrough, `context_warning` wind-down, rollout heartbeat.
- **0.2.0** — `reviewer_paths` delta ownership classification, `directive_id` correlation, required-but-nullable handoff fields (proposed by the Codex side itself, over the loop).
- **0.1.0** — pairing keys, tickets, bounded blocking, ledger, standing rules, git report-vs-reality check.

## Known limits

- The Codex desktop app cannot be woken from outside: a worker thread must hold a listening turn (live) or be driven by pastes. True zero-idle workers need Codex CLI (`codex exec`) or a cloud/PR-based flow.
- `codex_settings` is advisory — no API exists for an agent to switch its own model mid-thread.
- Schemas are validated shallowly beyond the enforced fields; scope assertions, diff budgets, and a rollout watchdog are orchestrator-layer ideas that stack on top.
- Not a security boundary between the two models — the human gate is the control. Keep it.

## License

MIT
