# Project Documentation — GitHub Copilot Mobile: Telegram Remote Claw

**Extension name:** `telegram-remote-claw`  
**Publisher:** `Jose Ospina`  
**Version:** `0.1.0`  
**VS Code engine:** `^1.90.0`  
**Generated:** March 25, 2026

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Build & Development](#build--development)
3. [Source Files Reference](#source-files-reference)
   - [src/extension.ts](#srcextensionts)
   - [src/config/settings.ts](#srcconfigsettingsts)
   - [src/bot/telegramBot.ts](#srcbottelegramBotts)
   - [src/bot/middleware.ts](#srcbotmiddlewarets)
   - [src/bot/commands.ts](#srcbotcommandsts)
   - [src/bridge/copilotBridge.ts](#srcbridgecopilotbridgets)
   - [src/bridge/terminalBridge.ts](#srcbridgeterminalbridgets)
   - [src/ui/statusBar.ts](#srcuistatusbarts)
   - [src/ui/setupWizard.ts](#srcuisetupmizardts)
   - [src/utils/formatter.ts](#srcutilsformatterts)
   - [src/utils/screenshot.ts](#srcutilsscreenshotts)
   - [src/notifications/notificationWatcher.ts](#srcnotificationsnotificationwatcherts)
4. [Settings Reference](#settings-reference)
5. [Command Reference](#command-reference)
6. [Security Model](#security-model)
7. [Known Limitations](#known-limitations)

---

## Architecture Overview

```
VS Code Extension Host
│
├── extension.ts          ← Activation entry point. Wires all subsystems.
│
├── config/
│   └── settings.ts       ← Typed settings accessor + SecretStorage wrapper
│
├── bot/
│   ├── telegramBot.ts    ← grammy Bot lifecycle (start/stop/reconnect)
│   ├── middleware.ts     ← Auth whitelist + rate limiter middleware chain
│   └── commands.ts       ← Telegram slash command handlers (/ask, /help, …)
│
├── bridge/
│   ├── copilotBridge.ts  ← @remoteclaw chat participant + direct LM agent loop
│   ├── terminalBridge.ts ← Pseudoterminal execution & output capture (pending T3.x)
│   └── chatMonitor.ts    ← Persistent differential clipboard monitor (ChatMonitor class)
│
├── ui/
│   ├── statusBar.ts      ← Status bar item (🦞 Remote Claw)
│   └── setupWizard.ts    ← 4-step first-launch webview wizard
│
├── utils/
│   ├── formatter.ts      ← Message splitter, code-block formatter, and Markdown→Telegram entity converter
│   └── screenshot.ts     ← Desktop screenshot capture (pending T4.x)
│
└── notifications/
    └── notificationWatcher.ts  ← Task event hooks for Telegram notifications (pending T5.x)
```

**Data flow for `?agent`:**

```
Telegram user → grammy Bot → Auth middleware → Rate limiter
  → commands.ts (executeAsk)
    ├── [nativeChatCapture] → ChatMonitor.start() → workbench.action.chat.open
    │                           → poll copyAll every 1s → stability detection
    │                           → extractLastAssistantResponse() → diff → sendFn()
    │                           → telegramBot.sendMessage() (with inline keyboard)
    ├── [silent mode]  → CopilotBridge.askQuestion() → vscode.lm agent loop → reply
    └── [panel mode]   → workbench.action.chat.open → @remoteclaw participant
                           → createCopilotBridge callback → telegramBot.sendMessage()
```

---

## Build & Development

| Script | Command | Description |
|---|---|---|
| Compile | `npm run compile` | TypeScript → `out/` via `tsc` |
| Build | `npm run build` | Bundle `src/extension.ts` → `dist/extension.js` via esbuild |
| Watch | `npm run watch` | TypeScript watch mode |
| Watch build | `npm run watch:build` | esbuild watch mode |
| Lint | `npm run lint` | ESLint with `@typescript-eslint` rules |
| Package | `npm run package` | Build + `vsce package` → `.vsix` |
| Test | `npm test` | VS Code extension host test runner |

**Entry point (bundled):** `dist/extension.js`  
**TypeScript output:** `out/`

**Runtime dependencies:** `grammy ^1.27.0`, `marked ^17.0.0`, `screenshot-desktop ^1.15.0`

---

## Source Files Reference

---

### src/extension.ts

Entry point for the VS Code extension. Exports `activate()` and `deactivate()`.

#### `activate(context: vscode.ExtensionContext): Promise<void>`

Called by VS Code when the extension activates (`onStartupFinished`). Orchestrates the full startup sequence:

1. Instantiates `SecretsManager` for credential access.
2. Creates the `RemoteClawStatusBar` and sets it to "Connecting".
3. Reads `botToken` and `ownerId` from `SecretStorage`.
4. If either secret is missing, opens the 4-step setup wizard via `showSetupWizard()`. If the wizard is closed without completing, sets status bar to "Disconnected" and returns early.
5. Reads the current configuration via `getConfig()` and builds a grammy `Composer<Context>` combining `createAuthMiddleware` → `createRateLimiterMiddleware`.
6. Instantiates `TelegramBot` with the token and the composed middleware.
7. Injects the status bar into the bot and wires lifecycle events: `onConnected` → `setConnected()`, `onDisconnected` → `setDisconnected()`, `onError` → `setDisconnected()`.
8. Registers all VS Code commands: `remclaw.start`, `remclaw.stop`, `remclaw.reset`, `remclaw.reconnect`, `remclaw.changeUser`, `remclaw.openSettings`, `remclaw.openStatusMenu`.
9. Instantiates `CopilotBridge` for direct LM access.
10. Registers the `@remoteclaw` VS Code Chat Participant via `createCopilotBridge()`, passing a callback that forwards responses to the Telegram owner.
11. Wires Telegram `?`-prefix command handlers via `registerCommands()`, which returns a `ChatMonitor` instance.
12. Starts the Telegram bot's long-polling loop.
13. Pushes all disposables into `context.subscriptions` (including the `ChatMonitor` via `{ dispose() }` wrapper).

#### `deactivate(): Promise<void>`

Called by VS Code on extension deactivation. Gracefully stops the Telegram bot (`telegramBot?.stop()`).

---

### src/config/settings.ts

Typed configuration accessor and secure credential storage.

#### Interface: `TelegramCopilotConfig`

Typed snapshot of all 20 `telegramCopilot.*` workspace settings:

| Field | Type | Default | Description |
|---|---|---|---|
| `instanceName` | `string` | `"VS Code"` | Friendly name for this VS Code instance |
| `enableTerminal` | `boolean` | `true` | Enable `?run` and `?stop` commands |
| `enableScreenshots` | `boolean` | `true` | Enable `?screenshot` command |
| `confirmDestructive` | `boolean` | `true` | Require confirmation for destructive commands |
| `commandAllowlist` | `string[]` | `[]` | Allowlist for terminal commands |
| `commandDenylist` | `string[]` | `[...]` | Denylist for terminal commands |
| `notifyOnBuildComplete` | `boolean` | `true` | Notify when build tasks complete |
| `notifyOnTestComplete` | `boolean` | `true` | Notify when test runs complete |
| `notifyOnLongTask` | `boolean` | `true` | Notify when tasks exceed threshold |
| `longTaskThresholdSeconds` | `number` | `30` | Seconds before a task is "long" |
| `terminalOutputMaxLines` | `number` | `100` | Max terminal output lines before truncation |
| `conversationHistoryCount` | `number` | `20` | Exchanges to persist across restarts |
| `messageFormat` | `'markdown' \| 'html'` | `'markdown'` | Telegram parse mode |
| `autoScreenshotAfterAgent` | `boolean` | `false` | Auto-screenshot after each Copilot response |
| `rateLimitPerMinute` | `number` | `20` | Max commands per 60-second window |
| `enablePIN` | `boolean` | `false` | Require PIN auth per session |
| `silentMode` | `boolean` | `false` | Answer `?agent` without opening the Chat panel |
| `nativeChatCapture` | `boolean` | `true` | Open the native VS Code Chat panel and capture the response via clipboard polling. Takes precedence over `silentMode` when both are true. |
| `nativeChatCaptureTimeoutSeconds` | `number` | `90` | Maximum seconds to wait for a native chat response before timing out |
| `nativeChatMonitorInactivityMinutes` | `number` | `10` | Minutes of no Telegram sends before the chat monitor auto-stops. Range: 1–60. |

#### `getConfig(): TelegramCopilotConfig`

Reads all `telegramCopilot.*` workspace settings via `vscode.workspace.getConfiguration()` and returns a typed `TelegramCopilotConfig` snapshot. Safe to call at any point; always returns current values.

#### `onDidChangeConfiguration(listener: (config: TelegramCopilotConfig) => void): vscode.Disposable`

Subscribes to VS Code configuration change events. Calls `listener` with a fresh `TelegramCopilotConfig` whenever any `telegramCopilot.*` key changes. Returns a disposable to add to `context.subscriptions`.

#### Class: `SecretsManager`

Wraps `vscode.SecretStorage` for the three sensitive Remote Claw credentials. Secret values are **never** passed to logs, output channels, or error messages.

**Constructor:** `constructor(context: vscode.ExtensionContext)`  
Stores a reference to `context.secrets`.

**Methods:**

| Method | Description |
|---|---|
| `storeBotToken(value: string): Promise<void>` | Stores the Telegram bot token under `remoteclaw.botToken` |
| `getBotToken(): Promise<string \| undefined>` | Retrieves the stored bot token, or `undefined` if absent |
| `deleteBotToken(): Promise<void>` | Deletes the stored bot token |
| `storeOwnerId(value: string): Promise<void>` | Stores the owner Telegram user ID under `remoteclaw.ownerId` |
| `getOwnerId(): Promise<string \| undefined>` | Retrieves the stored owner ID, or `undefined` if absent |
| `deleteOwnerId(): Promise<void>` | Deletes the stored owner ID |
| `storePin(value: string): Promise<void>` | Stores the session PIN under `remoteclaw.pin` |
| `getPin(): Promise<string \| undefined>` | Retrieves the stored PIN, or `undefined` if absent |
| `deletePin(): Promise<void>` | Deletes the stored PIN |
| `deleteAll(): Promise<void>` | Deletes all three secrets simultaneously (used by Full Reset) |

---

### src/bot/telegramBot.ts

Manages the grammy `Bot` instance lifecycle including long-polling, exponential backoff reconnection, and lifecycle event emission.

#### Class: `TelegramBot`

**Constructor:** `constructor(token: string, middleware: Middleware<Context>)`  
Creates a grammy `Bot` with the given token, attaches the supplied middleware, and installs an error handler that silently ignores Telegram's expected 30-second long-poll timeout errors.

**Constants:**
- `BACKOFF_INITIAL_MS = 5000` — Initial reconnect delay (5 seconds)
- `BACKOFF_MAX_MS = 300000` — Maximum reconnect delay (5 minutes)

**Methods:**

| Method | Description |
|---|---|
| `setStatusBar(statusBar: RemoteClawStatusBar): void` | Injects the status bar instance after construction to avoid circular dependencies |
| `start(): void` | Starts the polling loop if not already running. Resets backoff delay to initial value. Calls `startPolling()` in the background. |
| `stop(): Promise<void>` | Gracefully stops the bot and polling loop. Fires all `disconnectedCallbacks`. |
| `onConnected(cb: VoidCallback): void` | Registers a callback invoked when the bot successfully connects |
| `onDisconnected(cb: VoidCallback): void` | Registers a callback invoked when the bot disconnects |
| `onError(cb: ErrorCallback): void` | Registers a callback invoked when a non-timeout error occurs |
| `getBot(): Bot<Context>` | Returns the underlying grammy `Bot` instance (used to register commands) |
| `sendMessage(chatId: number, text: string): Promise<void>` | Sends a text message to any Telegram chat via `bot.api.sendMessage()`. Callers are responsible for splitting text longer than 4096 characters. |

**Private methods:**

| Method | Description |
|---|---|
| `startPolling(): Promise<void>` | Core polling loop with exponential backoff. On successful connect fires `connectedCallbacks` and resets delay. On failure, fires `errorCallbacks`, calls `statusBar?.setReconnecting()`, waits for the current backoff delay, then doubles the delay (cap: 5 min) before retrying. |
| `sleep(ms: number): Promise<void>` | Returns a promise that resolves after `ms` milliseconds |

---

### src/bot/middleware.ts

Plug-in middleware functions for the grammy middleware chain.

#### `createAuthMiddleware(secretsManager: SecretsManager): Middleware<Context>`

**Purpose:** Silently drops all Telegram updates from users who are not the stored owner.

**Behaviour:**
- Reads `remoteclaw.ownerId` from `SecretStorage` on every update.
- If no owner is configured, drops all updates (setup is incomplete).
- Compares `ctx.from?.id` (as string) to the stored owner ID.
- If they do not match, returns without calling `next()` — no reply is sent, the stranger's ID is never logged.
- If they match, calls `next()` to pass the update down the chain.

#### Interface: `SlidingWindow`

Internal tracking structure per user:
- `timestamps: number[]` — Unix millisecond timestamps of recent commands within the window
- `cooldownUntil: number` — Unix timestamp until which the user is in cooldown

#### `createRateLimiterMiddleware(config: TelegramCopilotConfig): Middleware<Context>`

**Purpose:** Enforces a sliding-window rate limit of `config.rateLimitPerMinute` commands per 60-second window.

**Behaviour:**
- Maintains a `Map<userId, SlidingWindow>` in closure scope.
- Checks and enforces active cooldown first; replies with remaining seconds.
- Slides the window by discarding timestamps older than 60 seconds.
- If the window count is at or above the limit, sets `cooldownUntil` and replies with a warning.
- Otherwise records the current timestamp and calls `next()`.

---

### src/bot/commands.ts

Registers all Telegram command handlers using a `?` prefix message router. All routing is
handled by a single `bot.on('message:text', ...)` listener — grammy's `bot.command()` API is
not used.

#### `registerCommands(bot, copilotBridge, config, secretsManager, context): ChatMonitor`

**Parameters:**
- `bot: Bot<Context>` — grammy Bot instance (with auth middleware already attached)
- `copilotBridge: CopilotBridge` — For direct LM access in silent mode
- `config: TelegramCopilotConfig` — Configuration snapshot
- `secretsManager: SecretsManager` — For re-validating owner ID in callback queries
- `context: vscode.ExtensionContext` — Used to read/write `globalState` for persistent flags

**Internal state:**  
`agentModeEnabled: boolean` — In-memory flag initialised from `globalState` on every call (defaults to `true` on first run); mutated by `?agent_on` / `?agent_off`.  
`lastQuestion: Map<number, string>` — Tracks the most recent `?agent` question per chat ID.

#### Message routing architecture

The single `bot.on('message:text', ...)` handler is the exclusive entry point for all
Telegram messages. Its logic in order:

1. **Trim** leading whitespace from the raw message text (mid-message `?` is left untouched).
2. **Daily help** — calls `maybeSendDailyHelp()` before anything else.
3. **`?` branch** — if the trimmed text starts with `?`:
   - `?` alone → calls `handleHelp()`.
   - `?<keyword> [args]` → looks up `keyword` in the dispatch map; replies with an unknown-command error if not found.
4. **Plain text branch** — if agent mode is ON, forwards the message to `executeAsk()`; otherwise silently ignores.

#### Auto-approve guard

 Two module-level helpers enforce the `chat.tools.terminal.ignoreDefaultAutoApproveRules` workspace setting before any Copilot call:

- **`isAutoApproveEnabled(): boolean`** — reads `chat.tools.terminal.ignoreDefaultAutoApproveRules` from workspace configuration.
- **`ensureAutoApprove(ctx): Promise<boolean>`** — if the setting is not enabled, sends an inline `Yes/No` keyboard asking the user to enable it, and returns `false` to abort the current command. Returns `true` when the setting is already enabled.

**Callback query handlers** (registered in addition to the text handler):

| Callback data | Action |
|---|---|
| `screenshot` | Re-validates owner ID and triggers `handleScreenshot()` |
| `autoApprove_yes` | Writes `chat.tools.terminal.ignoreDefaultAutoApproveRules = true` to workspace settings via `ConfigurationTarget.Workspace` |
| `autoApprove_no` | Replies with a warning that the extension requires auto-approvals |

#### Dispatch map

`dispatch: Record<string, (ctx, args) => Promise<void>>` maps each recognised keyword to its handler:

| Keyword | Handler | Notes |
|---|---|---|
| `agent` | `handleAgent()` | Calls `ensureAutoApprove()` guard first |
| `agent_on` | `handleAgentOn()` | Enables passthrough mode |
| `agent_off` | `handleAgentOff()` | Disables passthrough mode |
| `help` | `handleHelp()` | Also triggered by bare `?` |
| `screenshot` | `handleScreenshot()` | Stub (T4.1) |
| `run` | stub | T3.x |
| `stop` | stub | T3.x |
| `file` | stub | T3.x |
| `diff` | stub | T3.x |
| `git` | stub | T3.x |
| `status` | stub | T3.x |
| `errors` | stub | T3.x |
| `open` | stub | T3.x |
| `pin` | stub | future |

**Module-level helper:**

##### `extractLastAssistantResponse(fullTranscript: string): string`

Parses the full Chat transcript copied by `copyAll` and returns only the last assistant turn. Scans lines from the bottom looking for a `GitHub Copilot:` or `Assistant:` marker, then concatenates the inline text and all subsequent lines. Falls back to the full transcript if no marker is found.

**Internal helpers:**

##### `executeAsk(ctx: Context, question: string): Promise<void>`

Core `?agent` execution logic. Three modes evaluated in order:

- **Mode 1 — Native Chat Monitor** (`config.nativeChatCapture === true`): Replies with `...` as an acknowledgment, cancels any active monitor, then fire-and-forgets `monitor.start(question, sendFn, extractLastAssistantResponse)`. `sendFn` applies `convertTablesToCards()` and `splitMessage()` before each Telegram send; on Telegram Markdown parse errors it retries as plain text.
- **Mode 2 — Panel mode** (`config.nativeChatCapture === false` and `config.silentMode === false`): Executes `workbench.action.chat.open` with `@remoteclaw <question>`. The `@remoteclaw` participant handles both the VS Code panel and the Telegram response.
- **Mode 3 — Silent mode** (`config.silentMode === true`): Calls `CopilotBridge.askQuestion()` directly, applies `convertTablesToCards()` and `splitMessage()`, and replies to Telegram.

##### `handleAgentOn(ctx) / handleAgentOff(ctx): Promise<void>`

Toggle agent-passthrough mode. Each writes `remoteclaw.agentModeEnabled` to `globalState`,
updates the in-memory `agentModeEnabled` flag, and replies with a confirmation.

##### `buildHelpText(): string`

Generates the sectioned Markdown help string using the `?` prefix. Sections:
- `*Copilot*` — always shown
- `*Terminal*` — only when `config.enableTerminal` is true
- `*Workspace*` — always shown
- `*Other*` — screenshot/pin entries are conditional

##### `maybeSendDailyHelp(ctx): Promise<void>`

Reads `remoteclaw.lastHelpDate` from `globalState`. If it differs from today’s local date
(`YYYY-MM-DD`), sends the help menu and updates the stored date. Runs at the top of every
incoming message handler so the help always appears before the actual response. On the very
first run (no stored date), also sends a `"🤖 Agent mode ON"` announcement before the help so
the user knows the default mode.

##### `handleScreenshot(ctx: Context): Promise<void>`

Stub (T4.1). Currently replies with a placeholder message.

#### globalState Keys

| Key | Type | Default | Purpose |
|---|---|---|---|
| `remoteclaw.agentModeEnabled` | `boolean` | `true` | Persists agent-passthrough ON/OFF across restarts (defaults to ON on first run) |
| `remoteclaw.lastHelpDate` | `string` (`YYYY-MM-DD`) | `''` | Date the daily help was last shown (local timezone) |

#### Command Reference (`?` prefix)

| Command | Description |
|---|---|
| `?agent <question>` | Ask GitHub Copilot (full agent loop). Requires auto-approve enabled. |
| `?agent_on` | Enable auto-agent mode — all plain text → Copilot |
| `?agent_off` | Disable auto-agent mode |
| `?run <command>` | Execute a terminal command *(requires `enableTerminal`)* |
| `?stop` | Stop the running terminal command *(requires `enableTerminal`)* |
| `?file <path>` | Get the contents of a file |
| `?diff` | Show the current git diff |
| `?git <args>` | Run a git command |
| `?status` | Show VS Code status |
| `?errors` | Show current errors and diagnostics |
| `?open <file>` | Open a file in the editor |
| `?screenshot` | Take a screenshot *(requires `enableScreenshots`)* |
| `?pin` | Authenticate with PIN *(requires `enablePIN`)* |
| `?help` or `?` | Show the help menu |

---

### src/bridge/copilotBridge.ts

Bridges Telegram commands to the VS Code Language Model API.

#### Class: `CopilotBridge`

Direct LM bridge for Telegram slash-command handlers. Calls the Copilot language model programmatically without opening the VS Code Chat panel.

##### `askQuestion(question: string): Promise<string>`

**Purpose:** Answers a question using a full agentic loop with all registered VS Code tools.

**Steps:**
1. Verifies the `github.copilot-chat` extension is installed and enabled.
2. Selects the best available Copilot model by trying in order: `claude-sonnet-4.6` → `claude-sonnet-4.5` → `gpt-4o` → any `copilot` vendor model.
3. Logs the selected model name and available tool names to the console.
4. Builds the message array, prepending the active editor file context (truncated to 8 000 chars) via the private `buildContextMessage()` method.
5. Collects all registered VS Code LM tools.
6. Runs the agent loop via `runAgentLoop()` and returns the full buffered response.
7. Disposes the `CancellationTokenSource` on completion.

##### `runAgentLoop(model, messages, tools, token, maxIterations = 10): Promise<string>` _(private)_

**Purpose:** Iteratively sends messages to the model, executes any tool calls, and repeats until no more tool calls are requested or `maxIterations` is reached.

**Loop per iteration:**
1. Calls `model.sendRequest(messages, { tools }, token)`.
2. Streams the response, accumulating text parts and collecting `LanguageModelToolCallPart` instances.
3. If no tool calls: breaks the loop.
4. Appends the assistant turn (text + tool calls) to the message history.
5. Executes each tool call via `vscode.lm.invokeTool()`. On failure, injects an error message as the tool result.
6. Appends all tool results as a `User` message for the next iteration.

**Returns:** The full accumulated text response across all iterations.


---

#### `createCopilotBridge(telegramSendCallback): vscode.Disposable`

**Purpose:** Registers the `@remoteclaw` VS Code Chat Participant. Used so the user can also interact via the VS Code Chat panel while receiving responses in Telegram simultaneously.

**Parameters:**
- `telegramSendCallback: (text: string) => Promise<void>` — Async function that delivers text to the Telegram owner (called per line during streaming).

**Chat participant handler:**
1. Verifies `github.copilot-chat` is available.
2. Logs all available models, then selects the best model (same priority order as `CopilotBridge.askQuestion`: `claude-sonnet-4.6` → `claude-sonnet-4.5` → `gpt-4o` → any copilot).
3. Injects conversation history from `context.history` (previous `ChatRequestTurn` / `ChatResponseTurn` pairs) into the message array.
4. Collects all registered LM tools.
5. Runs an agent loop (up to 10 iterations):
   - Streams text parts to the VS Code Chat panel via `response.markdown()`.
   - **Streams each complete line** (ending with `\n`) to Telegram via `telegramSendCallback` as it arrives — not the full buffered response.
   - Executes tool calls with `request.toolInvocationToken` for full Copilot context.
6. On any LM error, sends a safe error string to both the Chat panel and Telegram.

**Returns:** A `vscode.Disposable` that unregisters the participant on dispose.

---

### src/bridge/chatMonitor.ts

**Purpose:** Persistent differential clipboard monitor. Runs a background polling loop after each `?agent` command when `nativeChatCapture` is enabled.

**Key exports:**
- `ChatMonitor` — class with `start(question, sendFn, extractFn)`, `cancel()`, and `dispose()` methods.

**Constructor:** `constructor(config: TelegramCopilotConfig)`  
Accepts the extension configuration snapshot. Uses `config.nativeChatMonitorInactivityMinutes` to set the inactivity auto-stop timeout.

**Behaviour:**
- Opens the VS Code Chat panel via `workbench.action.chat.open` with the question.
- Polls `workbench.action.chat.copyAll` every `1 000 ms` (`POLL_MS = 1_000`).
- Stability detection (FR-3): clipboard must contain a `GitHub Copilot:` or `Assistant:` marker AND be identical for **2 consecutive polls** before the response is considered done.
- On first stable read, extracts the last assistant response using the caller-supplied `extractFn` and sends it via `sendFn`.
- On subsequent stable reads, sends only new lines (diff) unless a new Copilot turn appeared (full resend).
- Anti-flood (FR-7): minimum 10 s between sends.
- Inactivity timeout: stops silently after `nativeChatMonitorInactivityMinutes` minutes of no sends.
- FR-10 resilient: keeps polling through chat panel closures; empty clipboard results are simply skipped.

**Private helpers:** `_onStable()` — diff/send logic; `_clearInactivityTimer()` — timer management; `_sleep(ms)` — async delay.

---

### src/bridge/terminalBridge.ts

> **Status: Pending implementation (T3.x)**

Placeholder module. Will implement pseudoterminal execution via `vscode.window.createTerminal({ pty })`, output capture, allowlist/denylist enforcement, and `/stop` support.

---

### src/ui/statusBar.ts

Manages the VS Code status bar item that shows Telegram bot connection state.

#### Class: `RemoteClawStatusBar`

**Constructor:** `constructor()`  
Creates a `vscode.StatusBarItem` aligned to the right side (priority 100), assigns `remclaw.openStatusMenu` as its click command, sets the initial state to "Connecting", and shows the item.

**Methods:**

| Method | Description |
|---|---|
| `setConnecting(): void` | Sets text to `🦞 Remote Claw: Connecting` |
| `setConnected(): void` | Sets text to `🦞 Remote Claw: Connected` |
| `setDisconnected(): void` | Sets text to `🦞 Remote Claw: Disconnected` |
| `setReconnecting(): void` | Sets text to `🦞 Remote Claw: Reconnecting` |
| `dispose(): void` | Disposes the underlying `StatusBarItem` |

---

### src/ui/setupWizard.ts

Implements the 4-step first-launch setup wizard as a VS Code `WebviewPanel`.

#### `showSetupWizard(context, secretsManager): Promise<void>`

**Purpose:** Opens the setup wizard if `botToken` or `ownerId` are not yet stored.

**Steps:**
1. Checks if both secrets already exist — returns early if so (idempotent).
2. Creates a `WebviewPanel` (`remoteClawSetup`) with scripting enabled.
3. Sets the panel HTML via `buildWizardHtml()`.
4. Sets up message handlers for all wizard commands:
   - `openBotFather` → opens `https://t.me/BotFather` in the system browser
   - `submitToken` → validates and stores the bot token, starts owner capture
   - `retryOwnerCapture` → restarts the owner-ID polling
   - `savePreferences` → saves setting toggles and sends the test message
   - `finish` → disposes the panel
5. On panel dispose, clears the 60-second capture timeout and stops the temporary polling bot.

#### Internal Functions

##### `handleSubmitToken(rawToken, panel, secretsManager, onBotReady): Promise<void>`

1. Trims the token and validates it against the regex `^\d{8,12}:[A-Za-z0-9_-]{35,45}$`.
2. Calls `bot.api.getMe()` to verify the token is valid against Telegram's API before storing it.
3. Stores the token via `secretsManager.storeBotToken()`.
4. Sends `{ command: 'goStep', step: 2 }` to advance the webview.
5. Calls `startOwnerCapture()` to begin listening for the owner's first message.

##### `handleRetryOwnerCapture(panel, secretsManager, onBotReady): Promise<void>`

Retrieves the stored token and restarts `startOwnerCapture()`. If no token is stored, sends the webview back to step 1.

##### `startOwnerCapture(token, panel, secretsManager, onBotReady): void`

Creates a temporary grammy `Bot` to capture the owner's Telegram user ID:
1. Starts a 60-second timeout; on expiry, stops the bot and notifies the webview (`ownerTimeout`).
2. Listens for the first incoming message from any user.
3. On first message: captures `ctx.from.id`, stores it via `secretsManager.storeOwnerId()`, sends a confirmation reply via Telegram, stops the bot, and notifies the webview (`ownerCaptured`).
4. On polling error: notifies the webview (`pollingError`).

##### `handleSavePreferences(prefs, panel, secretsManager): Promise<void>`

1. Writes the 6 preference toggles to VS Code global settings via `cfg.update()`.
2. Retrieves stored token and owner ID.
3. Creates a temporary bot and calls `bot.api.sendMessage()` to send a test/confirmation message to the owner.
4. On success, sends `{ command: 'goStep', step: 4 }` to advance to the completion screen.
5. On error, sends `{ command: 'testError', error: string }` to the webview.

##### `buildWizardHtml(): string`

Generates the complete HTML/CSS/JS for the 4-step wizard webview panel. Uses VS Code CSS variables for theming compatibility. Communicates with the extension host via the `acquireVsCodeApi().postMessage()` / `window.addEventListener('message', …)` pattern.

---

### src/utils/formatter.ts

Message formatting utilities for Telegram output.

#### `splitMessage(text: string, maxLen = 4096): string[]`

Splits a long string into chunks of at most `maxLen` characters. Prefers natural break points in this priority order:

1. **Paragraph boundary** (`\n\n`) — used if found in the latter 60% of the slice
2. **Single newline** — used if found after the first 20% of the slice
3. **Word boundary** (space) — fallback
4. **Hard split** — last resort when no natural boundary exists (e.g. a very long URL)

When more than one chunk is produced, each chunk is prefixed with `[Part N/M]\n`.

**Returns:** `string[]` — array of message parts ready to send to Telegram.

#### `formatCodeBlock(text: string, lang?: string, format: MessageFormat = 'markdown'): string`

Wraps `text` in a code block using the specified format:
- **`'markdown'`**: Triple-backtick fenced block with optional language tag (` ```lang\n...\n``` `)
- **`'html'`**: `<pre><code>...</code></pre>` with HTML-escaped content (`&`, `<`, `>`)

#### `escapeHtml(str: string): string` _(private)_

Escapes `&`, `<`, and `>` for safe use inside HTML content.

#### `convertTablesToCards(text: string): string`

Scans `text` for Markdown tables and converts each one to a card-style block safe for Telegram's Markdown v1 parser.

**Rules applied:**
- If line 2 of a table block is a separator row (`|---|`), line 1 is treated as the header.
- If no separator is present, all rows are treated as data (no header assumed).
- Header cells are rendered bold, joined with ` • `.
- Each data row becomes: `▸ *FirstCol* — Col2 — Col3 …`
- After conversion, **all remaining `|` characters are stripped** from the full text (catches stray pipes outside table blocks).

**Returns:** The transformed string with all tables replaced by card blocks.

#### `getUtf16Length(str: string): number`

Returns the number of UTF-16 code units in `str` (i.e. `str.length`). Telegram counts all entity `offset` and `length` values in UTF-16 code units. Exported for independent unit testing.

#### `markdownToEntitiesTelegram(markdownText: string): TelegramParseResult`

Converts a GFM Markdown string into a **plain-text string + structured array of Telegram `MessageEntity` objects**, eliminating the need for `parse_mode` and all special-character escaping.

Uses `marked.lexer()` (GFM mode) to tokenise the input and recursively walks the token tree to accumulate:
- `text` — plain text with all Markdown syntax stripped.
- `entities` — ordered array of `TelegramEntity` objects with `offset` and `length` in UTF-16 code units.

**Supported entity types:**

| Markdown syntax | `TelegramEntity._` |
|---|---|
| `**bold**` | `messageEntityBold` |
| `*italic*` | `messageEntityItalic` |
| `~~strike~~` | `messageEntityStrike` |
| `` `code` `` | `messageEntityCode` |
| ` ```lang\n...\n``` ` | `messageEntityPre` (+ `language` field) |
| `[text](url)` | `messageEntityTextUrl` (+ `url` field) |
| `> quote` | `messageEntityBlockquote` |

**Returns:** `TelegramParseResult` — `{ text: string, entities: TelegramEntity[] }`.


---

### src/utils/screenshot.ts

> **Status: Pending implementation (T4.x)**

Placeholder module. Will implement `captureScreenshot(): Promise<Buffer>` using `screenshot-desktop`. The screenshot is returned as a `Buffer` and is **never written to disk**.

---

### src/notifications/notificationWatcher.ts

> **Status: Pending implementation (T5.x)**

Placeholder module. Will implement the `NotificationWatcher` class that subscribes to `vscode.tasks.onDidStartTask` and `vscode.tasks.onDidEndTask` events and dispatches Telegram notifications for build completion, test completion, and long-running tasks.

---

## Settings Reference

All settings live under the `telegramCopilot` namespace. Configure via **File → Preferences → Settings** and search for "Telegram Copilot".

| Setting key | Type | Default | Description |
|---|---|---|---|
| `telegramCopilot.instanceName` | `string` | `"VS Code"` | Friendly name shown in Telegram notifications |
| `telegramCopilot.enableTerminal` | `boolean` | `true` | Enable `/run` and `/stop` terminal commands |
| `telegramCopilot.enableScreenshots` | `boolean` | `true` | Enable `/screenshot` command |
| `telegramCopilot.confirmDestructive` | `boolean` | `true` | Show confirmation keyboard before destructive commands |
| `telegramCopilot.commandAllowlist` | `string[]` | `[]` | If non-empty, only these commands are permitted via `/run` |
| `telegramCopilot.commandDenylist` | `string[]` | `["rm -rf", ...]` | Commands blocked or requiring confirmation via `/run` |
| `telegramCopilot.notifyOnBuildComplete` | `boolean` | `true` | Notify when a build task completes |
| `telegramCopilot.notifyOnTestComplete` | `boolean` | `true` | Notify when a test run completes |
| `telegramCopilot.notifyOnLongTask` | `boolean` | `true` | Notify when a task exceeds the threshold |
| `telegramCopilot.longTaskThresholdSeconds` | `number` | `30` | Seconds before a task is considered long (min: 5) |
| `telegramCopilot.terminalOutputMaxLines` | `number` | `100` | Max terminal output lines returned (10–500) |
| `telegramCopilot.conversationHistoryCount` | `number` | `20` | Conversation exchanges to persist across restarts (0–100) |
| `telegramCopilot.messageFormat` | `"markdown" \| "html"` | `"markdown"` | Telegram parse mode |
| `telegramCopilot.autoScreenshotAfterAgent` | `boolean` | `false` | Auto-screenshot after each Copilot response |
| `telegramCopilot.rateLimitPerMinute` | `number` | `20` | Max commands/min before rate limiting (5–60) |
| `telegramCopilot.enablePIN` | `boolean` | `false` | Require `?pin` auth once per session |
| `telegramCopilot.silentMode` | `boolean` | `false` | Answer `?agent` without opening the Chat panel (direct LM call). Overridden by `nativeChatCapture`. |
| `telegramCopilot.nativeChatCapture` | `boolean` | `true` | Open the native VS Code Chat panel and capture responses via clipboard polling. Takes precedence over `silentMode`. |
| `telegramCopilot.nativeChatCaptureTimeoutSeconds` | `number` | `90` | Maximum seconds to wait for a native chat response before timing out |
| `telegramCopilot.nativeChatMonitorInactivityMinutes` | `number` | `10` | Minutes of no new Telegram sends before the chat monitor stops automatically. Range: 1–60. |

**Secrets** (stored in VS Code `SecretStorage`, never in settings):

| Key | Description |
|---|---|
| `remoteclaw.botToken` | Telegram bot token from @BotFather |
| `remoteclaw.ownerId` | Owner's Telegram numeric user ID |
| `remoteclaw.pin` | Optional session PIN (min 4 digits) |

---

## Command Reference

### VS Code Commands (palette / status bar)

| Command ID | Title | Description |
|---|---|---|
| `remclaw.start` | Start bot | Starts the Telegram bot polling loop |
| `remclaw.stop` | Stop bot | Gracefully stops the bot |
| `remclaw.reset` | Full Reset | Stops bot, deletes all secrets, reopens wizard |
| `remclaw.reconnect` | Reconnect | Stops then immediately restarts the bot |
| `remclaw.changeUser` | Change Authorized User | Deletes owner ID and reopens wizard for re-capture |
| `remclaw.openSettings` | Open Settings | Opens VS Code settings filtered to `telegramCopilot` |
| `remclaw.openStatusMenu` | Status menu | Shows a quick-pick menu with all bot management options |

### Telegram Commands (`?` prefix)

All commands use the `?` prefix. A bare `?` shows the help menu.

| Command | Description | Controlled by setting |
|---|---|---|
| `?agent <question>` | Ask GitHub Copilot a question (full agent loop) | — |
| `?agent_on` | Enable auto-agent mode — all plain text → Copilot | — |
| `?agent_off` | Disable auto-agent mode | — |
| `?help` or `?` | Show available commands (dynamically reflects current settings) | — |
| `?run <command>` | Execute a terminal command | `enableTerminal` |
| `?stop` | Stop the currently running terminal command | `enableTerminal` |
| `?screenshot` | Capture and send a desktop screenshot | `enableScreenshots` |
| `?file <path>` | Read a workspace file and return its contents | — |
| `?diff` | Show the current `git diff` | — |
| `?git <args>` | Run a git command | — |
| `?status` | Show VS Code status (active file, branch, error count) | — |
| `?errors` | List current errors and warnings from diagnostics | — |
| `?open <filename>` | Open a file in the VS Code editor | — |
| `?pin` | Authenticate with PIN (only visible when `enablePIN` is true) | `enablePIN` |

---

## Security Model

### Access Control

- **Owner-only whitelist:** All Telegram updates are filtered by `createAuthMiddleware`. Any message from a user ID other than `remoteclaw.ownerId` is silently dropped — no reply, no logging.
- **Rate limiting:** `createRateLimiterMiddleware` enforces a sliding-window limit (`rateLimitPerMinute`) to prevent command flooding and cooldown abuse.
- **PIN authentication (optional):** When `enablePIN` is true, each VS Code session requires the owner to send `/auth <pin>` before any commands are processed (implementation in T6.3).

### Secrets Management

- Bot token, owner ID, and PIN are stored exclusively in VS Code `SecretStorage` (OS-level credential store).
- Secrets are **never** written to workspace settings, output channels, log files, or error messages.
- `SecretsManager.deleteAll()` performs a complete wipe during Full Reset.

### Terminal Security (pending T3.x)

- `commandDenylist`: substring-match blocklist for dangerous commands.
- `commandAllowlist`: takes full precedence over the denylist when non-empty.
- `confirmDestructive`: destructive commands require explicit inline keyboard confirmation with a 60-second auto-cancel.

### File Access Security (pending T4.x)

- `/file` resolves paths relative to the workspace root and validates that the resolved absolute path starts with the workspace root before reading — preventing path traversal attacks.

### Bundle Security

- The production build (`dist/extension.js`) must never contain any bot token, owner ID, or PIN strings.
- `vscode` is marked as an external module in esbuild to prevent bundling VS Code internals.
- `screenshot-desktop` is also external (native module).

---

## Known Limitations

- **Windows-only testing at MVP.** The extension has only been manually tested on Windows. macOS and Linux compatibility is untested.
- **No webhook support.** Only Telegram long-polling is implemented. Webhook mode is not supported.
- **Terminal bridge not yet implemented.** `/run`, `/stop`, `/diff`, `/git`, and destructive-command confirmation are pending T3.x.
- **Screenshot not yet implemented.** `/screenshot` and `autoScreenshotAfterAgent` are pending T4.x.
- **Notification watcher not yet implemented.** Build/test/long-task Telegram notifications are pending T5.x.
- **Conversation history persistence not yet implemented.** History does not survive VS Code restarts until T6.1–T6.2 are completed.
- **PIN authentication not yet implemented.** The `enablePIN` setting exists but the middleware guard is pending T6.3.
- **Native dependency packaging.** `screenshot-desktop` requires platform-specific native binaries that must be excluded from the esbuild bundle and included separately in the `.vsix`.
