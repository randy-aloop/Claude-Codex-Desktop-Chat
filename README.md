# Claude-Codex Desktop Chat Pairing

Connect one Codex task to one Claude Code conversation so they can work in a supervised review loop.

> [!IMPORTANT]
> Despite the project name, the Claude side is **Claude Code**—not the Claude Desktop app and not a chat on claude.ai.

> [!WARNING]
> This project is experimental. It is a coordination helper, not a security boundary, sandbox, or permission system. Try it on a test repository before using it on important work.

## What it does

You give a job to Claude Code. Claude proposes a small instruction for Codex. After you approve it, Codex performs that unit of work and reports back. Claude reviews the result, then proposes the next instruction.

A small helper running on your computer passes the messages and keeps local history.

```text
You
 │
 │ approve the next instruction
 ▼
Claude Code reviewer
 │
 │ ruling
 ▼
Local reviewloop helper
 │
 │ instruction
 ▼
Codex worker
 │
 │ work report
 └────────────────────────────► Claude reviews again
```

Claude does not directly control or type into a Codex task. Codex must opt into the loop and call the helper itself. The helper also cannot wake a Codex task from outside the Codex app.

## Before you start

You will need:

- A working Codex installation.
- A working **Claude Code CLI** installation.
- Node.js 18 or newer.
- The exact Codex task/thread ID you want to use.
- The exact Claude Code session ID you want to use.
- A project folder for Codex to work in.
- Basic comfort opening PowerShell and editing a small JSON file.
- Git if you want the optional change checks.

Check the two required command-line tools:

```powershell
node --version
claude --version
```

The Node version must be 18 or newer.

This repository does not include a tool for discovering Codex or Claude session IDs. Where those IDs are displayed depends on the app and version you use. Do not guess them: a pairing cannot be set up without the exact IDs.

Normal Codex and Claude model usage—and therefore normal usage costs—still apply.

## Safety first

Before using the loop:

- Use a Git repository and start with a clean working tree.
- Make a backup or commit before the first run.
- Review `git status` and `git diff` yourself after every important change.
- Keep the default `reviewer_mode: "live"` while learning.
- Do not use `approval: "auto"` for work that writes files.
- Do not put passwords, API keys, tokens, or other secrets in prompts or standing rules.
- Treat pairing keys and the `.reviewloop` folder as sensitive.
- Use `loop_status` with a pairing key; a keyless status call lists local pairing information.
- Do not expose the helper to the internet or another machine.
- Give Codex and Claude only the filesystem permissions you are comfortable with them already having.

In live mode, “show the ruling to the human before submitting it” is an instruction followed by Claude Code. It is a human procedure, not a technically enforced permission gate.

`reviewer_paths` only labels changes for reporting. It does not prevent either assistant from reading or writing those paths.

## Install on Windows

### 1. Put the project in a permanent folder

Download this repository with **Code → Download ZIP**, extract it, and move the extracted folder somewhere you plan to keep it.

The installer records the absolute path to `shim.js`. Moving or deleting the folder later will break the registration.

### 2. Open PowerShell in that folder

In File Explorer, open the project folder, click the address bar, type `powershell`, and press Enter.

### 3. Run the installer

Codex Desktop users should provide the existing Codex `config.toml` and sessions-folder paths explicitly:

```powershell
node .\install.js --codex-config "C:\FULL\PATH\TO\config.toml" --sessions-dir "C:\FULL\PATH\TO\sessions"
```

Replace both placeholders with real, existing paths. Do not copy the placeholder paths literally.

If your Codex installation uses the standard `~\.codex` location, the installer can try to find it automatically:

```powershell
node .\install.js
```

The installer changes local configuration and state:

- It adds a marked `reviewloop` block to Codex `config.toml` and writes a backup.
- It asks the Claude Code CLI to add a user-level `reviewloop` tool.
- It creates or updates `~/.reviewloop/config.json`.
- It runs a local protocol self-test, which starts the helper and creates test records.

Read the output carefully. A successful setup should report:

- Codex installed or already installed.
- Claude registered through `claude mcp add`.
- A Codex sessions directory selected for the heartbeat.
- A passing protocol self-test.

A line beginning with `!` is a warning that part of the setup may not be complete. The final `Done` message does not cancel earlier warnings.

The self-test checks the local review protocol. It does not prove that the Codex and Claude applications can both use it.

### 4. Restart both applications

Completely restart Codex and Claude Code. The tools load when the applications start and appear under the internal name `reviewloop`.

### macOS and Linux

Use the same scripts with forward slashes:

```bash
node ./install.js --codex-config "/full/path/to/config.toml" --sessions-dir "/full/path/to/sessions"
```

## Create your first pairing

### 1. Create a setup file

Create a file named `reviewloop-setup.json`, for example in your Documents folder:

```json
{
  "codex_thread_id": "PASTE_EXACT_CODEX_THREAD_ID_HERE",
  "claude_thread_id": "PASTE_EXACT_CLAUDE_SESSION_ID_HERE",
  "repo": "C:\\Users\\YOU\\Documents\\MY-PROJECT",
  "stop": {
    "max_directives": 10,
    "max_minutes": 120
  },
  "reviewer_mode": "live"
}
```

Replace all placeholder values. Windows paths inside JSON use double backslashes: `\\`.

The `repo` value should be the absolute path to the project Codex will work on. If the folder is not a Git repository, you can omit `repo`, but the helper will not be able to run useful Git checks.

Do not commit this setup file to a public repository.

### 2. Run `loop_setup`

From PowerShell in the downloaded project folder:

```powershell
node .\rl.js loop_setup '@C:\Users\YOU\Documents\reviewloop-setup.json'
```

Keep the entire `@...` argument inside quotes in PowerShell, especially when the path contains spaces.

On macOS or Linux:

```bash
node ./rl.js loop_setup '@/full/path/to/reviewloop-setup.json'
```

The command returns:

- A worker key for Codex.
- A reviewer key for Claude Code.
- A `worker_prompt`.
- A `reviewer_prompt`.
- Warnings for the selected mode.

Treat the keys and returned prompts as sensitive.

### 3. Paste the generated prompts

- Paste the complete `worker_prompt` into the selected Codex task.
- Paste the complete `reviewer_prompt` into the selected Claude Code session.

Both sides will call `loop_confirm`. A submitted ID that does not match the setup returns `PAIRING FAILED`.

`PAIRING CONFIRMED` only means the ID submitted to the helper matches the setup file. The helper cannot independently prove which app window received the prompt, so check that you pasted each prompt into the intended task or session.

### 4. Give Claude the task

After both sides are ready, give the task to Claude Code. Claude may also ask which Codex model and reasoning effort you want.

The normal loop is:

1. Claude drafts the next small instruction.
2. You read and approve it in the Claude conversation.
3. Claude submits it to the helper.
4. Codex performs only that unit of work.
5. Codex submits a report and waits.
6. Claude reviews the report and proposes the next instruction.

In live mode, keep the Claude Code session open and supervising the loop.

## Check or stop a pairing

To view one pairing’s status, use one of its pairing keys:

```powershell
node .\rl.js loop_status key=PASTE_PAIRING_KEY_HERE
```

When the work is complete, a ruling with `done: true` tells the prompted workflow to stop. It does **not** remove the pair from local state.

To disconnect the pair:

```powershell
node .\rl.js loop_unlink key=PASTE_PAIRING_KEY_HERE
```

Stop limits help the assistants wind down, but they do not interrupt a command that is already running. In particular, `max_minutes` marks the pair as winding down after the time is exceeded; it is not a process timeout.

## What is stored on your computer?

By default, state is stored as ordinary plaintext in:

```text
C:\Users\YOUR-NAME\.reviewloop\
```

On macOS and Linux, this is `~/.reviewloop/`. Setting `REVIEWLOOP_HOME` changes the location.

| File | Contents |
| --- | --- |
| `config.json` | Local settings, including the Codex sessions path |
| `daemon.json` | Helper process ID, local port, and access token |
| `state.json` | Pairings, keys, tickets, handoffs, paths, and rulings |
| `ledger.jsonl` | A limited activity log |
| `standing-rules.md` | Rules saved for future loop steps |
| `daemon.log` | Helper-process messages |

The ledger is not tamper-proof and is not a complete security audit. The installer’s self-test also creates a small test pairing, ticket, and standing-rule record in this state folder.

The files can grow over time and are not automatically rotated.

## Troubleshooting

### `node` is not recognized

Install Node.js 18 or newer, then open a new PowerShell window.

Codex and Claude also need to find `node` through their own application environment. If it works in PowerShell but the tools still fail, restart the applications and verify that Node is available on the PATH used by desktop applications.

### `claude` is not recognized

Install and sign in to Claude Code. This project does not connect to Claude Desktop or claude.ai.

The installer may print a manual `.mcp.json` configuration when Claude Code registration fails. Manual configuration is an advanced fallback; do not assume the installation succeeded just because the installer reached its final message.

### The installer says no Codex `config.toml` was found

Run it again with the exact existing path:

```powershell
node .\install.js --codex-config "C:\FULL\PATH\TO\config.toml"
```

### The reviewloop tools are missing

- Restart Codex and Claude Code.
- Check whether the installer wrote to the correct Codex configuration.
- Make sure the downloaded repository folder has not moved since installation.
- Make sure `node` is available to both applications.

### The heartbeat points to the wrong folder

Open:

```text
C:\Users\YOUR-NAME\.reviewloop\config.json
```

Correct `codex_sessions_dir`, save the file, then stop and restart the helper. Re-running the installer does not overwrite an existing `codex_sessions_dir` setting.

### `PAIRING FAILED`

The prompt may have been pasted into a different task or session than the IDs declared in the setup file. Confirm both IDs, create a new pairing if needed, and paste each generated prompt into the intended place.

### The setup file cannot be found

Check the path and keep the `@file` argument quoted:

```powershell
node .\rl.js loop_setup '@C:\FULL\PATH\TO\reviewloop-setup.json'
```

### Codex or Claude remains `pending`

A Codex Desktop task cannot be awakened externally. It must still have an active listening turn or be resumed manually.

In live mode, Claude Code repeatedly waits for work. If that listening turn ends, paste the generated reviewer prompt again to re-arm it.

### Subprocess review fails

Subprocess mode requires this command to work for the selected Claude Code session:

```powershell
claude --resume PASTE_SESSION_ID_HERE -p "reply OK"
```

If it fails, the automated review will fail too.

### Stop the local helper

From the downloaded project folder:

```powershell
node .\daemon.js --stop
```

The state files remain, and the command-line client can start the helper again later.

## Uninstall completely

Do these steps before deleting the downloaded repository folder.

### 1. Stop the helper

```powershell
node .\daemon.js --stop
```

### 2. Remove the Codex and Claude registrations

```powershell
node .\install.js --uninstall --codex-config "C:\FULL\PATH\TO\config.toml"
```

The uninstaller removes the marked Codex configuration block and asks Claude Code to remove the user-level registration. It keeps backups of changed Codex configuration files.

Read the output for warnings. An unmarked or manually created registration may need to be removed manually.

### 3. Restart Codex and Claude Code

This unloads the removed registration.

### 4. Remove retained data if wanted

The uninstaller deliberately keeps `.reviewloop`.

If you no longer need its keys, task history, paths, or rules, delete only this folder using File Explorer:

```text
C:\Users\YOUR-NAME\.reviewloop\
```

Use the `REVIEWLOOP_HOME` location instead if you configured one.

### 5. Remove an optional global installation

A local-checkout installation does not require this step. If you previously ran `npm install -g .`, remove it with:

```powershell
npm uninstall -g claude-codex-desktop-chat-pairing
```

You can then delete the downloaded repository folder.

<details>
<summary><strong>Advanced: reviewer modes</strong></summary>

| Mode | How it works | Approval behavior | Main trade-off |
| --- | --- | --- | --- |
| `live` | A Claude Code session stays open and calls `await_work` repeatedly | Approval is a procedure followed in the conversation | Easier to watch, but idle polling can use model tokens |
| `subprocess` | The helper runs `claude --resume` after each Codex submission | With `approval: "human"`, proposals wait for `loop_approve` | No idle reviewer polling, but setup and failure handling are more technical |
| Subprocess with `approval: "auto"` | Proposed rulings are immediately applied | No human approval gate | Not recommended for work that writes files |

Subprocess mode is intended for experienced users. Test it on a non-sensitive repository first.

</details>

<details>
<summary><strong>Advanced: command-line client</strong></summary>

Simple values can be passed as `key=value`:

```powershell
node .\rl.js loop_status key=PASTE_PAIRING_KEY_HERE
```

For arrays, nested objects, or complete setup data, use a JSON file:

```powershell
node .\rl.js TOOL_NAME '@C:\FULL\PATH\TO\params.json'
```

The client also accepts inline JSON, but a file is usually easier and safer to quote correctly.

</details>

<details>
<summary><strong>Advanced: available tools</strong></summary>

| Tool | Purpose |
| --- | --- |
| `loop_setup` | Create a worker/reviewer pair from two IDs |
| `loop_confirm` | Confirm one side of a setup-created pair |
| `loop_status` | View pair, ticket, heartbeat, and review status |
| `loop_unlink` | Disconnect a pair |
| `submit_for_review` | Send a Codex work report to the reviewer |
| `await_ruling` | Wait for the reviewer’s next ruling |
| `await_work` | Wait for the worker’s next report |
| `submit_ruling` | Send a live-mode ruling to Codex |
| `loop_approve` | Approve, edit, or reject a subprocess proposal |
| `get_standing_rules` | Read saved rules |
| `get_checks` | Compare a handoff with selected Git information |
| `loop_register` | Create a legacy manual participant key |
| `loop_link` | Create a legacy manual pair |

The Git check is only a helper. It does not protect files, replace a human review, or guarantee that every working-tree condition has been checked.

</details>

<details>
<summary><strong>Advanced: project files</strong></summary>

| File | Purpose |
| --- | --- |
| `install.js` | Adds or removes Codex and Claude Code registrations |
| `shim.js` | The tool entry point used by both applications |
| `daemon.js` | The local pairing, ticket, state, and review process |
| `rl.js` | A small command-line client for the local helper |
| `prompts.md` | Reference prompts; normal setup generates pair-specific prompts |
| `config.json.example` | Example local configuration structure |

The project has no third-party npm runtime packages, but it still requires Node.js, Codex, and Claude Code.

</details>

## Known limits

- This is a terminal-and-JSON workflow, not a one-click desktop interface.
- It works with Claude Code, not Claude Desktop or a browser chat.
- It does not discover thread or session IDs for you.
- It cannot wake a Codex Desktop task from outside the app.
- Live-mode waiting can consume model tokens while idle.
- In live mode, human approval is a prompt convention rather than an enforced authorization check.
- Pairing keys and local state should not be treated as protection against other processes running under the same user account.
- Stop limits do not forcibly terminate commands already running.
- `done: true` completes the prompted run but does not unlink the pair.
- `reviewer_paths` classify changes; they do not enforce file ownership.
- Built-in Git checks are incomplete and do not replace `git status`, `git diff`, testing, or human review.
- Stored state and the activity ledger are plaintext and not tamper-evident.
- Model and effort settings sent to Codex are advisory; Codex may not be able to change them from inside a running task.

## License

MIT
