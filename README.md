# Claude Multi-Agent Console

A local web UI that turns **your own Claude Code** subscription into a coordinated multi-agent system — orchestrator, specialist workers, teams, sessions, all driven by a chat.

Runs entirely on your machine. Uses **your** Claude Code OAuth login (so usage counts against your Pro / Max plan; **no API key required**).

> Status: pre-alpha demo. Friends-only. Expect rough edges.

---

## What you get

- **Orchestrator chat** — talk to a top-level Claude that routes work
- **Workers** — define specialists (planner / coder / reviewer / researcher / qa / custom) with their own role prompts, models, and tool permissions
- **Teams** — group workers (e.g. `coding-team` with planner + coder + reviewer) so the orchestrator can engage a whole team for one request
- **Auto-workflow** — for code requests, plan → implement → review → fix-loop runs automatically
- **Sessions & history** — multiple chat threads, each persists across restarts, switchable via tabs
- **Activity panel** — see each delegation as a card with worker name, color, progress, and result
- **Status preview** — pending / running / done columns; before delegating, the orchestrator declares its plan

A demo state ships with example teams and workers (in Korean) so you can see how it's set up.

---

## Requirements

| What                  | Why                              | How to get it                        |
| --------------------- | -------------------------------- | ------------------------------------ |
| **Node.js 20+**       | runtime for the local server     | <https://nodejs.org>                 |
| **Claude Code CLI**   | the actual Claude that runs     | <https://claude.com/code>            |
| **Claude Pro or Max** | needed to log into Claude Code   | <https://claude.ai/pricing>          |

Works on macOS, Linux, Windows (10/11).

---

## Install

```bash
git clone https://github.com/hanoong7/Claude_Multi_Agent_Console.git
cd Claude_Multi_Agent_Console
```

That's it — there are **no npm dependencies to install**. The server is pre-bundled.

---

## First-time setup

**1. Log in to Claude Code** (one time, in any terminal):

```bash
claude
```

This will open a browser for OAuth. Sign in with your Claude account. Close the terminal when done. Your login is now cached for any tool on the machine, including this app.

You can verify with:

```bash
claude auth status
```

It should print JSON with `"loggedIn": true`.

**2. Start the console**:

### macOS / Linux

```bash
./start.sh
```

### Windows

Double-click `start.bat`, or in PowerShell / cmd:

```cmd
start.bat
```

The launcher prints something like:

```
[seed] copied examples/agents.json → data/agents.json
[server] listening on :8787  cwd=.../workspace
[server] open http://localhost:8787 in your browser
[auth] OK · you@example.com · max
```

Open <http://localhost:8787> in your browser.

---

## Using it

### Try the included demo

The package ships with example teams (`coding-team`, etc.) and a few historical chat sessions. Click around to see how things are wired. To start fresh:

- Delete a session via the **✕** on its tab
- Or wipe everything: stop the server, delete `data/` and `workspace/` next to `app.js`, then start again — it'll reseed from `examples/`

### Define your own team

1. Click `+ team` (top-left) → name + purpose ("when should this team be used?")
2. Hover the team header → `+ member` → define the member:
   - **kind**: researcher / coder / reviewer / planner / qa / custom (selects a default role prompt)
   - **role**: the system prompt for that worker
   - **model**: opus / sonnet / haiku / inherit (per worker)
   - **effort**: low / medium / high / xhigh / max (reasoning effort)
   - **permission**: how aggressive about running tools (more on this below)
3. The orchestrator system prompt automatically updates to know about your team and its workflow.

### Permissions

Each worker (and the orchestrator) has a permission mode:

| mode                 | what it does                                                   |
| -------------------- | -------------------------------------------------------------- |
| `default`            | Claude Code's default. May prompt — bad for headless.          |
| `acceptEdits`        | auto-allow file edits + common fs ops (Bash for `git`, etc.)   |
| `bypassPermissions`  | ⚠ skip ALL checks. Used when you trust the workflow.           |
| `plan`               | read-only planning mode                                        |
| `dontAsk`            | deny anything not on the allowlist (locked-down CI-style)      |

For most workflows that involve writing code, use `acceptEdits` for workers; bump the orchestrator to `bypassPermissions` if it keeps getting stuck on a tool prompt.

### Workspace

By default the orchestrator and workers operate in `./workspace/` relative to `app.js`. Files they create (e.g. a generated `fizzbuzz.py`) end up there.

Want them to work in a different directory (e.g. your existing project)? Set `CLAUDE_CWD` before launching:

**macOS / Linux**

```bash
CLAUDE_CWD=/path/to/my/project ./start.sh
```

**Windows (cmd)**

```cmd
set CLAUDE_CWD=C:\path\to\my\project
start.bat
```

### Port

Default is `8787`. Change with `PORT=9000 ./start.sh` (or set `PORT` env var on Windows).

---

## What gets stored where

```
release-folder/
├── app.js              ← bundled server (read-only)
├── public/             ← UI assets (read-only)
├── examples/           ← seed data, copied to data/ on first run
├── data/               ← YOUR teams, workers, sessions, settings (auto-created)
│   ├── agents.json
│   └── sessions/
│       └── <session-uuid>.jsonl   ← chat & activity log per session
└── workspace/          ← files Claude/workers create (auto-created)
```

`data/` and `workspace/` are gitignored — safe to edit, safe to delete.

---

## Troubleshooting

**Banner: "Claude is not logged in"** — Run `claude` in a terminal once, sign in, then refresh the page.

**Banner: "Claude CLI not installed"** — Install from <https://claude.com/code>, restart your shell, retry.

**Chat shows "claude exited (1)..."** — Usually a permission or auth issue. Run `claude auth status` to verify login; switch orchestrator permission to `bypassPermissions` if a tool keeps failing.

**Workers ignore the workflow / don't delegate** — Make sure each worker's `description` actually mentions what triggers it ("Use this team for any code change..." style). Also make sure teams have at least the basic `planner / coder / reviewer` kinds for the auto-workflow to kick in.

**Port already in use** — Pass `PORT=...` to use a different port.

**Want a clean slate** — Stop the server, delete `data/` (and optionally `workspace/`), restart.

---

## Cost & privacy

- All Claude calls go from **your** machine through **your** Claude Code login to Anthropic. No middleman.
- Usage counts against your Pro/Max plan (or your API key if you have one configured for Claude Code).
- Chat history, agent definitions, and worker outputs live entirely in `data/` on your disk. Nothing is uploaded.
- The example data in `examples/` was generated during development and is included for reference. Feel free to delete it — the app re-seeds it only if `data/` is empty.

---

## Limits / known issues

- **Source code not included.** This is a pre-built bundle for demo purposes.
- Multiple browser tabs to the same server share one backend connection — works, but sessions are queued per-session, not parallel across tabs.
- The "예정 (pending)" preview depends on the orchestrator following its instructions; sometimes it skips the preview tag.
- No mobile-friendly layout.
- Resizing the left panel works but resets if you reload.

---

## License

MIT — see `LICENSE`.
