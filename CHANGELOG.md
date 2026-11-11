# Change Log

All notable changes to the "vscode-pi-model-chat-provider" extension will be documented in this file.

This line and the entries below 0.3.0 describe the original tintinweb extension. 0.3.0 is the first release of the [wuwuzhazha fork](https://github.com/wuwuzhazha/vscode-pi-model-chat-provider). The license remains MIT. Copyright for the original work remains tintinweb.

## [0.3.3] - 2026-11-11

### Added
- Command **Pi: Show Model Picker Diagnostics** (`pi.showModelPickerDiagnostics`). It writes the running extension version, `vscode.version`, the vendor contribution, sanitized model ids and the metadata this extension returned, the stable `vscode.lm.selectChatModels` result, and non-secret preferences. It does not include prompt text, API keys, environment variables, or `pi.additionalArgs` values. The same registration line is written to the Pi Agent output channel when models are listed.
- The report states the limits of that API: no read-back of `isUserSelectable` or `targetChatSessionType`, no access to profile storage `chatModelVisibility`, and no access to the open chat's session resource, mode, or location.

### Changed
- Model detail no longer says the model is eligible in Ask. On VS Code 1.144.1 the mode button labeled Ask is a custom agent whose kind defaults to Agent, and the model picker then requires `toolCalling`. A Linux run of that build showed Local plus that Ask button with the Pi models registered and absent from the picker. `toolCalling` stays false.

## [0.3.2] - 2026-11-11

### Fixed
- Pi models were listed by the language-model provider but omitted from the chat model selector on VS Code 1.109, which keeps a model only when `isUserSelectable` is true. This provider now sets that flag. `toolCalling` stays false.
- On VS Code 1.144.1 (commit `261c84cb`) that flag is not enough. A non-local session that has its own models shows only models with a matching `targetChatSessionType`, which this provider does not set. Agent mode on a local session still requires `toolCalling`. There is no stable API that satisfies either rule without advertising host tool calls or pinning the model to one harness.

## [0.3.1] - 2026-11-11

### Fixed
- Windows can run `pi --version` in PowerShell while the extension reported `Pi CLI not found at "pi"`. npm installs `pi.cmd`, `pi.ps1`, and an extensionless script, and spawning the bare name without a shell fails with ENOENT. The extension now resolves that command on the Extension Host PATH, reads a recognized npm shim, and starts the adjacent `node.exe` (or `node.exe` on PATH) with Pi's `cli.js` as an argument. The same argv is used for the version probe and for RPC. `cmd.exe` is not used, and arbitrary `.cmd` text is not executed. A missing command and an unlaunchable shim produce different errors. Paths with spaces stay separate arguments.

## [0.3.0] - 2026-11-11

### Added
- Version and capability check of the user-installed `pi` binary. Missing binaries and versions older than 0.74.0 fail with an install hint. Pi 0.80.4+ is waited on `agent_settled`. Pi 0.74.0–0.80.3 still finishes on the first `agent_end`, and that limitation is logged.
- Strict LF JSONL framing. Records are split on `\n` only, so `U+2028` and `U+2029` inside JSON strings stay inside the record.
- Request/response correlation by id, including `success: false`. Command acceptance uses `pi.commandTimeoutMs`. Prompt runs have no fixed 2 minute cap. `pi.hungRequestTimeoutMs` (default 0, disabled) aborts a prompt only after that long with no protocol output. Open Pi dialogs pause the timer.
- Cancellation sends `clear_queue` on Pi 0.84.4+ and then `abort`, cancels open dialogs, and kills the process if it does not settle within `pi.shutdownGraceMs`.
- Native Pi extension UI: confirm (Allow / Deny / dismiss), select (Quick Pick), input (Input Box), and editor (untitled document). Dismissing or closing cancels. That is not the same as Deny. Notifications, status, widgets, title, and editor-prefill are shown or logged instead of being ignored.
- Workspace Trust gate. An untrusted workspace does not spawn Pi.
- Opt-in `pi.persistSessions`. Session files and the provider index stay inside the workspace. The default remains `--no-session`.
- Session identity includes the transcript, model, and working directory. Concurrent prompts for one transcript run FIFO. Edits, cancellation, and crashes start a new process and replay the transcript, with explicit limitation lines for images, host tool results, and unsupported parts.
- Unit and integration tests against a mock Pi subprocess, plus GitHub Actions CI.

### Changed
- The extension no longer depends on `@earendil-works/pi-coding-agent` or `@earendil-works/pi-agent-core`. Those packages are not the user's Pi runtime. `RpcClient` is a real root export of 0.74.0, but that client still completes on `agent_end`. Current Pi also exports `RpcClient` and requires Node.js >= 22.19. This fork speaks JSONL to the `pi` on PATH instead.
- `capabilities.toolCalling` is false. Host `toolMode: Required` fails with an explanation. Other host tool lists produce one notice and no `LanguageModelToolCallPart`. Pi tool activity stays fenced text. VS Code tool approvals do not cover Pi tools, and Pi Allow/Deny does not cover VS Code tools.
- Model picker copy no longer claims this is a VS Code agent-tool model.
- Configuration reload replaces the provider's session pool. Previously the provider kept using the disposed pool.
- Repository links in this fork point at `wuwuzhazha/vscode-pi-model-chat-provider`. The Marketplace publisher id is still `tintinweb` so a local VSIX can replace that extension id. `npm run publish` refuses to publish.
- `engines.vscode` is `^1.109.0` so it matches `@types/vscode` 1.109.0. Upstream said `^1.103.0`, but those published typings do not include `LanguageModelChatProvider`, and `vsce` will not pack when the installed types are newer than the engine.
- Without a workspace folder, Pi does not fall back to the extension host's current directory. Set `pi.workingDirectory` or open a folder.

### Security
- `pi.additionalArgs` cannot pass `--mode`, `--session`, `--session-dir`, `--no-session`, `--resume`, `--continue`, `--fork`, or `-s`.

## [0.2.1] - 2026-07-23

### Fixed
- OpenRouter (and any provider whose model IDs contain a slash, e.g.
  `openrouter:anthropic/claude-3.5-sonnet`) no longer fails with
  `Unknown model … not registered by the Pi provider`. The vendor-prefix
  stripping now removes only a literal leading `pi/` instead of splitting on
  arbitrary slashes, so the lookup key matches the one used at registration.
  Thanks to @DeluxeOwl (#4).

## [0.2.0] - 2026-05-14

### Fixed
- "Sorry, no response was returned" — fixed several root causes:
  - Messages without a literal `<user_query>` tag were silently dropped; the
    full message text is now always forwarded to Pi.
  - Response text is now fetched via the `get_last_assistant_text` RPC command
    instead of being reconstructed from streamed content blocks. This is
    model-agnostic and works regardless of how a model (codex, reasoning, etc.)
    structures its output.
- The agent no longer hangs on `extension_ui_request` dialogs. `confirm`
  requests are surfaced as a real modal Allow/Deny dialog; the rest are
  answered or treated as fire-and-forget per the RPC protocol.
- Pi agent errors (e.g. an unsupported model) are now surfaced in the chat
  instead of a bare "no response returned".
- Requesting a tool call no longer causes an infinite loop. Tool activity is
  rendered as text instead of `LanguageModelToolCallPart`, which VS Code
  treated as a call it had to fulfill — re-invoking the provider repeatedly.

### Changed
- Migrated to the renamed `@earendil-works/pi-coding-agent` package.
- Each conversation turn is sent to Pi as a single combined prompt instead of
  replaying messages individually.
- Model list is cached for 30 seconds (was cached indefinitely), so models Pi
  gains or loses appear without a window reload.
- All logging now goes to a single shared "Pi Agent" output channel; the
  always-on trace shows event types, and full event payloads are logged when
  `pi.debug` is enabled.
- Performance: the model is only re-set on the Pi process when it actually
  changes, and the status bar refresh no longer blocks turn completion.

## [0.1.0] - 2026-02-12

### Added
- Initial release
- Language Model Chat Provider integration for Pi coding agent
- Multi-turn conversation persistence with session pooling
- Support for up to 20 concurrent chat sessions
- LRU eviction and idle timeout cleanup (10 minutes)
- Status bar showing context window utilization
- Dynamic model enumeration from Pi
- Streaming responses with tool execution display
- Cancellation support (stop button)
- Automatic context (environment, workspace) injection

### Features
- Session isolation per chat thread
- Context window tracking and display
- Graceful error handling for empty/image-only messages
- Model caching for fast startup
- Persistent metadata bridge for quick model enumeration
- Debug logging configurable via settings (disabled by default)

### Configuration
- `pi.binaryPath` - Path to Pi CLI binary
- `pi.workingDirectory` - Working directory for Pi agent
- `pi.autoRestart` - Auto-restart on crash
- `pi.maxRestartAttempts` - Max restart attempts
- `pi.additionalArgs` - Additional CLI arguments
- `pi.debug` - Enable debug logging (default: false)
