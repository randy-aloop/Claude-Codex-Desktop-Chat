# reviewloop

A local MCP bridge that pairs one **Codex thread (worker)** with one **Claude thread (reviewer)** using opt-in keys, then carries a review loop between them: `submit_for_review → await_work → submit_ruling → await_ruling`.

Born from a practical problem: the Codex desktop app owns its threads in memory, so nothing outside may safely write to them. reviewloop inverts the direction — the worker calls out through its own MCP server, so there is never a second writer, and a thread that never registers is structurally unreachable.

Zero dependencies. Node ≥ 18. Works on Windows (no unix sockets, no Bun).

| File | Role |
| --- | --- |
| `shim.js` | stdio MCP server — register this same file in **both** Codex and Claude. Auto-spawns the daemon. |
| `daemon.js` | one persistent local process owning pair/ticket state, long-polls, ledger, standing rules. `127.0.0.1` only, token-authed. |
| `rl.js` | CLI client for the daemon — lets any process (a shell, a CI job, a Claude session without MCP registration) act as a participant. |
| `prompts.md` | paste-ready worker and reviewer prompts encoding the protocol. |

State lives in `~/.reviewloop/` (override with `REVIEWLOOP_HOME`): `state.json`, `ledger.jsonl` (append-only audit), `standing-rules.md`, `daemon.log`, `daemon.json` (port/pid/token).

## Verify first (no AI involved)

```
node shim.js --selftest
```

Runs the entire flow — register both roles, link, submit→await_work, rule→await_ruling, pending path, standing rules, unlink — and prints PASS.

## Install — Codex side

Add to your Codex home's `config.toml` (back it up first):

```toml
[mcp_servers.reviewloop]
command = 'node'
args = ['<absolute-path-to>/reviewloop/shim.js']
tool_timeout_sec = 180
```

Restart Codex. `tool_timeout_sec` must exceed the await block window (default 25 s, hard cap 160 s).

## Install — Claude side

Claude Code CLI:

```
claude mcp add reviewloop -- node "<absolute-path-to>/reviewloop/shim.js"
```

Or `.mcp.json`:

```json
{
  "mcpServers": {
    "reviewloop": {
      "type": "stdio",
      "command": "node",
      "args": ["<absolute-path-to>/reviewloop/shim.js"]
    }
  }
}
```

No MCP registration on the Claude side? `rl.js` gives the same access from any shell the session can reach:

```
node rl.js loop_register role=reviewer label=myrun
node rl.js await_work key=REV-XXXX timeout_ms=150000
node rl.js submit_ruling @ruling.json
```

## First pairing

1. **Codex thread**: "Call loop_register with role worker, label myrun. Report the key, then wait."
2. **Claude thread**: register as reviewer with the same label, then `loop_link` both keys (`loop_status` suggests the match). Pass `repo` at link time to enable git checks.
3. Hand the worker its first task (see `prompts.md` for the full protocol prompts).

## Tools

| Tool | Who | Purpose |
| --- | --- | --- |
| `loop_register {role, label}` | both | opt in; returns key (`WRK-…` / `REV-…`) |
| `loop_link {key_a, key_b, repo?}` | either | create the pair; `repo` enables git checks |
| `loop_status {key?}` | both | state, open tickets, suggested links |
| `loop_unlink {key}` | both | end pair; keys survive for re-linking (reviewer succession) |
| `submit_for_review {key, handoff}` | worker | file a ticket, returns immediately |
| `await_ruling {key, ticket, timeout_ms?}` | worker | bounded block; `pending` → call again |
| `await_work {key, timeout_ms?}` | reviewer | bounded block; `pending` → call again |
| `submit_ruling {key, ticket, ruling}` | reviewer | verdict `approve\|revise\|rule\|abort`, `relay` (verbatim), `stop_when`, `expected`, `do_not[]`, `standing_rule?`, `done` |
| `get_standing_rules {key}` | both | read durable rules (`standing_rule` appends; curate by hand) |
| `get_checks {key, ticket}` | both | git diff vs `handoff.changed_files` — report vs reality; fails closed |

## Conversation mode (standing mailbox)

For free-form exchanges rather than work units: the worker submits a "mailbox open" ticket and polls `await_ruling`; the reviewer holds the ticket open and rules it only when there is a message to send. The reply comes back as the next ticket, which becomes the new mailbox. One arming prompt, then messages flow in both directions with no human relay. `done: true` parks it. Costs the worker a small amount of context per poll (~24 polls/hour at the 150 s window).

## Design notes

- **Consent is structural.** A thread that never registers is invisible; there is no code path to touch a thread that didn't opt in.
- **Bounded blocking.** Await tools return `status:"pending"` instead of holding past client timeouts (some MCP clients kill calls at ~60 s regardless of server progress). Progress notifications are emitted when the client supplies a `progressToken`.
- **Fail closed.** `get_checks` reports `could_not_verify` rather than passing silently; unpaired submits error immediately.
- **Human gate.** The reviewer shows every ruling to its human before `submit_ruling` — the protocol's real safety layer.
- **Ledger.** Every register/link/submit/ruling/unlink appends to `ledger.jsonl`.
- **Daemon lifecycle.** First shim spawns it; a newer daemon supersedes an older via the portfile. `node daemon.js --stop` to stop.

## Known limits (v0.1)

- Handoff/ruling schemas validated shallowly (verdict enum + relay required; the rest warnings).
- `get_checks` implements report-vs-reality only; scope assertions, diff budgets, invariants are planned.
- No git checkpointing or rollout watchdog — orchestrator-layer, stacks on top.
- Worker feedback queued for v0.2 (proposed by the Codex side itself, over the loop): `directive_id` for correlation, required-but-nullable `tests`/`blockers`/`questions`, state-changing vs read-only command split.

## License

MIT
