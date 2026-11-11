# Pi Coding Agent — Language Model Provider (fork)

This repository is [wuwuzhazha/vscode-pi-model-chat-provider](https://github.com/wuwuzhazha/vscode-pi-model-chat-provider), a fork of [tintinweb/vscode-pi-model-chat-provider](https://github.com/tintinweb/vscode-pi-model-chat-provider) by tintinweb. The original work is MIT licensed; that copyright stays in `LICENSE`. This fork is **not** the Visual Studio Marketplace extension `tintinweb.vscode-pi-model-chat-provider`, and `npm run publish` refuses to publish.

It registers a **native** VS Code [Language Model Chat Provider](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider) (`vendor: pi`). Chat still uses VS Code's own chat UI. There is no webview and no `@chatParticipant`.

Pi itself is [Mario Zechner's](https://github.com/badlogic) [Pi coding agent](https://pi.dev). Images in `images/` are the upstream project assets.

<p align="center">
  <img src="images/banner.png" alt="Banner artwork from the upstream tintinweb extension">
</p>

## What it does

The extension starts the `pi` binary you installed:

```bash
pi --mode rpc --no-session
```

It speaks Pi's JSONL RPC on stdin/stdout. One Pi process is one conversation. Pi runs its own read, edit, and bash tools **inside that process**. Those tools are rendered as fenced text. They are not VS Code tool cards, and this model is not registered as a VS Code agent-tool model (`capabilities.toolCalling` is false).

## Pi versions

Tested in CI against a mock of the documented RPC protocol, not against a live model:

| Pi CLI | What this fork does |
| --- | --- |
| older than 0.74.0 | Refuses to start. The error tells you to upgrade. |
| 0.74.0 – 0.80.3 | Supported. A turn finishes on the first `agent_end`. That can arrive before retries, compaction, or queued follow-ups. The limitation is written to the Pi Agent output. |
| 0.80.4 – 0.84.3 | Supported. A turn finishes on `agent_settled`. `abort` does not clear the steering/follow-up queue (that command arrived in 0.84.4). |
| 0.84.4 and newer, including 1.5.x | Supported. Cancellation sends `clear_queue`, then `abort`. `prompt` responses may include `data.disposition` (Pi 1.5.0+). `handled` does not wait for `agent_settled`. |

`pi --version` on the configured binary is the source of truth. Docs checked for this change: [RPC](https://pi.dev/docs/latest/rpc), [RPC commands](https://pi.dev/docs/latest/rpc-commands), and [RPC extension UI](https://pi.dev/docs/latest/rpc-extension-ui), against Pi 1.5.2 (2026-11-10).

### Why this does not import `RpcClient`

`RpcClient` **is** exported from `@earendil-works/pi-coding-agent@0.74.0` (`dist/index.d.ts` re-exports it). It is not a docs-only name. That 0.74 client still resolves `waitForIdle()` on `agent_end`. `@earendil-works/pi-coding-agent@1.5.2` also documents a root `RpcClient`, and that package requires Node.js `>=22.19.0`. Neither package is the `pi` binary on your PATH. This extension keeps a small LF-only client and shells out to that binary. It does not bundle Pi and it does not pin a newer `pi-coding-agent`.

## Setup

1. Install Pi and log in with Pi's own flow. Pi 1.x needs Node.js 22.19 or newer. Pi 0.74.x can run on Node 20.

   ```bash
   npm install -g @earendil-works/pi-coding-agent
   pi --version
   ```

2. Install this fork locally (Install from VSIX, or the Extension Development Host) on VS Code 1.109 or newer. There is no Marketplace release of this fork.
3. Open a **trusted** folder. Restricted mode does not start Pi.
4. In chat, pick a `pi /provider/model` entry.

On Windows, leave `pi.binaryPath` as `pi` when that command works in a terminal whose PATH the Extension Host inherited. The extension finds `pi.cmd` (or the matching `.ps1` or extensionless npm script), then starts the `node.exe` next to that shim with Pi's `cli.js`. It does not run the shim in `cmd.exe`. If PowerShell only sees `pi` because a profile prepends PATH, set `pi.binaryPath` to the full path of `pi.cmd` or of the `cli.js`. Do not point it at `node.exe` alone.

API keys stay in Pi's own config and environment. This extension does not read or store them. Do not put secrets in `pi.additionalArgs`.

## Settings

| Setting | Default | Role |
| --- | --- | --- |
| `pi.binaryPath` | `pi` | Command or full path. On Windows, `pi`, `pi.cmd`, `pi.ps1`, and the extensionless npm shim are resolved to the adjacent `node.exe` plus Pi's `cli.js` and started without `cmd.exe`. The PATH used is the Extension Host PATH, not a PowerShell profile. |
| `pi.workingDirectory` | first workspace folder | Directory Pi's tools use. An explicit path may sit outside the workspace; Pi can modify it. Required when no folder is open. |
| `pi.autoRestart` | `true` | After an unexpected exit, allow another start up to `pi.maxRestartAttempts`. |
| `pi.maxRestartAttempts` | `3` | Restart budget for one process object. A failed turn also discards that session. |
| `pi.additionalArgs` | `[]` | Extra RPC arguments. `--mode`, `--session`, `--session-dir`, `--no-session`, `--resume`, `--continue`, `--fork`, and `-s` are rejected. |
| `pi.commandTimeoutMs` | `30000` | How long Pi may take to **accept** one command. Not a cap on the model run. |
| `pi.hungRequestTimeoutMs` | `0` | Inactivity timeout for a prompt. `0` means no cap. Protocol output resets it. An open Pi dialog pauses it. |
| `pi.shutdownGraceMs` | `5000` | Time to exit after stdin is closed and one SIGTERM, before SIGKILL. |
| `pi.persistSessions` | `false` | See privacy below. |
| `pi.sessionDirectory` | empty | With persistence on, empty means `<workspace>/.pi/vscode-lm-sessions`. Paths outside the workspace are rejected. |
| `pi.maxSessions` | `20` | Soft cap. A busy process is not killed to enforce it. |
| `pi.sessionIdleTimeout` | `600` | Seconds before an idle process is stopped. `0` disables idle cleanup. |
| `pi.debug` | `false` | Log RPC payloads. Those payloads include prompts and tool text. |

## Permissions

- **Workspace Trust.** If the window is not trusted, Pi is not spawned and no prompt is sent. Trusting a workspace lets Pi read and run inside its working directory under Pi's own rules. It does not approve each tool call.
- **VS Code tool approvals do not cover Pi tools.** Pi's bash, read, and edit tools execute in the Pi process. This provider does not emit `LanguageModelToolCallPart`, so VS Code will not show a native tool card or run its approval UI for them.
- **Pi dialogs do not cover VS Code tools.** Confirm is Allow, Deny, or cancel (dismiss). Select, input, and editor use Quick Pick, Input Box, and an untitled document. Closing them sends `cancelled: true`, which is not Deny. The dialog text says this is a Pi prompt. Pi can still run tools without asking, depending on Pi's own settings.
- **Host tools.** `toolCalling` is false, so VS Code should not treat the model as an agent-mode tool model. If a caller still sends tools with `toolMode` Auto, the chat gets one notice and the tools are not called. `toolMode` Required fails the request. Nothing is re-entered into VS Code as a second tool call.

## Sessions, history, and privacy

Default: `--no-session`. The transcript lives in the Pi process. It is not written to disk by this extension. Reload, cancel, crash, an edited earlier message, a different model, or a different folder starts a new process and resends the transcript as text. The preamble says it is a restore. Images are attached only on the current user message; older images are named in a limitation line, not dropped. Unsupported binaries, VS Code tool calls, and VS Code tool results are included as text plus a `[provider limitation]` line.

Concurrent requests for the same transcript run one after another on that process. Different transcripts can run together, up to the session cap.

`pi.persistSessions` opts in to Pi session JSONL **inside the trusted workspace**, plus `provider-index.json` in that directory (hashes to session paths, not a copy of the chat outside the workspace). The files contain prompts, tool output, and file contents Pi reads. They are not encrypted. Add the directory to `.gitignore` if the workspace is a git repo. A restored file is loaded with `switch_session` only when the path is still inside the session directory. This is not a perfect fork of Pi's internal tree; a failed restore falls back to the text replay.

There is no global storage of the transcript. VS Code itself still keeps the chat transcript in its own storage.

## Remote and multi-root

The extension host runs where VS Code runs the extension. For a remote window, `pi` must be installed on that remote machine, and the working directory is on that machine. This does not tunnel Pi back to your laptop.

Multi-root: Pi's cwd is `pi.workingDirectory` if set, otherwise the **first** workspace folder. Tools do not switch folders per root. The session key includes that cwd. A second folder is not a second Pi cwd unless you point `pi.workingDirectory` at it.

## Architecture

- `src/pi-process.ts` — spawn, version probe, LF framer, id correlation, settled vs `agent_end`, cancel, hung timeout, stderr tail.
- `src/session-coordinator.ts` — transcript identity, FIFO per process, restore/replay.
- `src/provider.ts` — `vscode.lm.registerLanguageModelChatProvider('pi', ...)`.
- `src/vscode-ui.ts` — Quick Pick, Input Box, modal confirm, untitled editor.
- `test/fixtures/mock-pi.mjs` — deterministic subprocess. No API keys and no model calls.

Info logs record command names and event types. Full payloads require `pi.debug`.

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run compile
npx vsce package
```

`npm test` compiles `tsconfig.test.json` and runs Node's test runner on `out-test/test`. The mock Pi is `test/fixtures/mock-pi.mjs`. Windows shim resolution is covered by mocked filesystem tests on every OS (`test/windows-launch.test.ts`) and by an actual `node.exe` spawn that runs only when the suite is on Windows (`test/windows-shim-actual.test.ts`). CI runs the suite on Ubuntu and Windows.

Launch "Run Extension" from the Extension Development Host after `npm run compile`. Output channel: **Pi Agent**.

### Manual smoke checklist

CI does not launch VS Code or a real Pi, and it does not call a model. Before trusting a Pi upgrade, with a trusted local folder and a real `pi --version`:

1. `pi --version` is at least 0.74.0, preferably 0.80.4+ (`agent_settled`) and 0.84.4+ (`clear_queue`).
2. The model picker lists `pi /provider/model` entries and the detail says Pi tools are not VS Code agent tools.
3. A short prompt returns text. The Pi Agent channel shows `agent_settled` (or `agent_end` on 0.74–0.80.3) and not a 2 minute timeout.
4. Stop the request mid-run. The process exits or settles, and the next message still gets a response (it may replay history).
5. A Pi `confirm` shows Allow, Deny, and dismiss-to-cancel. Select and input can be closed without choosing. Editor opens an untitled document; Cancel or closing it does not send the text. Nothing is saved unless you save it.
6. Restricted mode does not start Pi. Trusting the folder allows the next request to start it.
7. With `pi.persistSessions` off, no new session JSONL appears under the workspace. With it on, files appear only under the configured directory inside the workspace.
8. A second workspace root is not used as cwd unless `pi.workingDirectory` says so.
9. On a remote window, confirm `which pi` on the remote host, not the local one.

## Known gaps

- No VS Code extension-host test (`@vscode/test-electron`) in CI. Quick Pick, Input Box, and the untitled editor are mapped in unit tests; the `vscode.window` calls need the smoke checklist.
- Not run here against a current Pi binary or a billed model. The mock covers framing, correlation, `agent_end` vs `agent_settled`, `handled`, cancellation order, crash stderr, hung timeout, and `--no-session` vs `--session-dir`.
- `imageInput` is reported true for every model. Pi 0.74 model records do not say which models accept images. A text-only model can still reject an image; that error is surfaced.
- Restored transcripts are text plus current-message images, not a byte-for-byte Pi session, unless opt-in persistence reloads the session file.
- Pi tool permissions are entirely Pi's. This provider only relays extension UI. It cannot promise that a tool will ask first.
- Thinking deltas are fenced text, not a native VS Code thinking part.
- Publisher id remains `tintinweb` so a local VSIX uses the same extension id as upstream. Do not publish it.

## License

MIT. Original copyright 2026 tintinweb. See `LICENSE`.
