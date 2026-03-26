# 🦞 GitHub Copilot Mobile — Telegram Remote Claw
## Brainstorming & Design Document

---

## 1. Identity

| Field | Value |
|---|---|
| **Display Name** | GitHub Copilot Mobile — Telegram Remote Claw |
| **Extension ID** | `telegram-remote-claw` |
| **Command prefix** | `remclaw.` |
| **Telegram bot name suggestion** | `@RemoteClawBot` |
| **Status bar label** | `🦞 Remote Claw` |
| **Distribution** | Personal use first → VS Code Marketplace later |

---

## 2. Core Concept

A VS Code extension that bridges **GitHub Copilot Chat** with **Telegram**, allowing remote control of VS Code from a phone. The user can send questions to Copilot, receive answers, run terminal commands, and get screenshots — all from Telegram.

```
[Telegram Phone] ←──────────────────────────────────→ [VS Code on PC]
                          long-polling bot
                     (no public URL needed)
```

---

## 3. Language & Stack

| Layer | Choice | Reason |
|---|---|---|
| **Extension language** | TypeScript | Required for VS Code extensions. Full typing, IntelliSense. |
| **Telegram library** | `grammy` | TypeScript-first, modern, best DX |
| **Screenshot** | `screenshot-desktop` npm package | Cross-platform (Win/Mac/Linux) |
| **Bot connection** | Long-polling | No public URL, works behind NAT/firewall, zero infrastructure |

---

## 4. Architecture — Option A: Embedded Bot (Chosen)

```
[Telegram] ←→ [Telegram Bot API (long-polling)] ←→ [VS Code Extension]
                                                           ↕
                                                  [VS Code Chat API]
                                                  [Terminal API]
                                                  [Screenshot util]
```

The extension itself hosts the bot via long-polling. No external server. Works on any machine.

### Long-Polling Explained
Instead of Telegram pushing to a public URL (webhook), the extension constantly asks Telegram "any new messages?" — holding the connection open up to 30s until a message arrives, then immediately asks again. Invisible to the user, handled automatically by `grammy`.

---

## 5. Platform Support

**Full cross-platform: Windows + macOS + Linux**

Screenshot utility (`screenshot-desktop`) is cross-platform. All other VS Code APIs and `grammy` are Node.js-based and platform-independent.

---

## 6. Core Features

### 6.1 Copilot ↔ Telegram Bridge (Proxy Pattern)

Uses the **VS Code Chat Participant API** as the approved integration point (the chat input box cannot be directly manipulated — it is an isolated sandboxed webview).

```
[Telegram message] → [Chat Participant handler] → [vscode.lm API → Real Copilot/GPT-4o]
                                                            │
                                        ┌───────────────────┴──────────────────┐
                                        ↓                                       ↓
                              [VS Code Chat Panel]                    [Telegram reply]
                              (renders as markdown)              (sent when stream ends)
```

- Registered participant: `@remoteclaw`
- Telegram → VS Code: `workbench.action.chat.open` with `query: '@remoteclaw <message>'`
- VS Code → Telegram: response stream buffered and forwarded when complete
- OR silent background mode: Copilot answers without opening the chat panel UI

### 6.2 Screenshots

- **Scope: Full screen** (everything visible on the monitor)
- Triggered by `/screenshot` Telegram command
- Sent as photo to Telegram chat
- Optional: auto-send screenshot after Copilot finishes a long response (configurable)
- Uses `screenshot-desktop` for cross-platform support

### 6.3 Terminal Bridge

- From Telegram: `/run <command>` → `terminal.sendText(command)`
- Output: **full output sent back**, truncated with a note if too long (configurable max lines)
- Capture method: pseudoterminal (`vscode.window.createTerminal({ pty: ... })`)
- Destructive commands (e.g. `rm -rf`, `drop`, `delete`) require confirmation via inline keyboard
- Command allowlist/denylist configurable by user

### 6.4 File Sending

- **Direction: VS Code → Telegram only** (no upload from Telegram to VS Code)
- `/file <path>` → sends file content as formatted code block
- `/diff` → sends current git diff

### 6.5 Auto-Notifications (VS Code → Telegram Push)

Triggers automatic Telegram messages for:
- ✅ **Build success / failure** (with error summary if failed)
- ✅ **Test suite results** (pass/fail count + failed test names)
- ✅ **Long-running tasks completed** (>30 seconds threshold, configurable)

---

## 7. Telegram Slash Commands

```
/auth <pin>       → authenticate for current session (if PIN enabled)
/ask <question>   → send question to Copilot
/run <command>    → execute command in VS Code terminal
/screenshot       → capture full screen and send photo
/file <path>      → send file content as code block
/status           → current file, branch, error count
/errors           → send current diagnostics / linter errors
/diff             → send current git diff
/git <args>       → run git command and return output
/open <filename>  → open file in editor
/stop             → stop current running terminal process
/help             → list all available commands
```

### Inline Keyboard Buttons (UX)

When Copilot responds:
```
[📸 Screenshot] [📋 Copy to clipboard] [🔁 Ask again]
```

When build fails:
```
[🔄 Retry build] [📋 Show errors] [📂 Open failing file]
```

When destructive terminal command is sent:
```
⚠️ Are you sure you want to run: `rm -rf ./dist`?
[✅ Confirm] [❌ Cancel]
```

---

## 8. Security Stack

| Layer | Implementation | Protects Against |
|---|---|---|
| **User ID whitelist** | Hardcoded numeric Telegram ID — only you pass | Everyone else (silent ignore) |
| **Session PIN** | `/auth <pin>` required once after VS Code opens | Physical phone access |
| **Command confirmation** | Inline keyboard Yes/No for destructive commands | Accidental/injected commands |
| **Command allowlist/denylist** | Configurable list of allowed commands | Arbitrary code execution |
| **SecretStorage** | Token + PIN stored in VS Code encrypted secret storage | Git leaks, settings exposure |
| **Rate limiter** | Max N commands per minute (configurable) | Brute force / spam |

### How the Whitelist Works

- The whitelist is **not dynamic** — it is set by the owner before the bot runs
- `/start` from any stranger → **silent ignore** (bot appears dead to outsiders)
- Owner's Telegram ID is captured **automatically** during first-launch wizard (no manual entry)
- Getting your ID: message `@userinfobot` on Telegram → it replies with your numeric ID

### Bot Token Security

- **Never** stored in `settings.json` (could be committed to git)
- Stored exclusively in VS Code `SecretStorage` API (OS-level encrypted)
- If compromised: rotate immediately via @BotFather (`/revoke`)

---

## 9. First-Launch Setup Wizard

A Webview panel walks the user through setup. One-time only, ~60 seconds total.

**Step 1 — Create Telegram Bot**
- Instructions to go to @BotFather → `/newbot`
- `[Open @BotFather]` button (`vscode.env.openExternal`)
- Paste token field → saved to SecretStorage

**Step 2 — Auto-detect Owner**
- Plugin starts polling with provided token
- User sends ANY message to their new bot
- Plugin captures `ctx.from.id` automatically → saves as whitelisted owner
- Timeout: 60 seconds (cancelled if no message, settings preserved)

**Step 3 — Permissions & Preferences**
- Toggle: Allow terminal commands
- Toggle: Allow screenshots
- Toggle: Require PIN for destructive commands
- PIN field (optional)
- Notification preferences (build, tests, long tasks)

**Step 4 — Connection Test**
- Plugin sends: *"🦞 Remote Claw is connected! Send /help to see available commands."*
- Setup complete

---

## 10. Conversation Persistence

**Enabled: Yes — last N messages persist across VS Code restarts**

- Stored locally (not in Telegram, not in cloud)
- N is configurable (default: last 20 exchanges)
- Allows Copilot to have context from previous session
- Cleared on full reset

---

## 11. Reset & Account Management

### Status Bar Quick Menu (click `🦞 Remote Claw: Connected`)

```
✅ Connected as @MyBot
─────────────────────────
👤 Change Authorized User
🔄 Reconnect Bot
⚙️  Open Settings
🔴 Disconnect
💣 Full Reset
```

### Change Authorized User Flow

1. Run `Remote Claw: Change Authorized User` from Command Palette
2. Plugin enters **capture mode** (60-second window)
3. New Telegram user sends any message
4. Plugin captures new ID, saves it, confirms to new account
5. Old account receives: *"⚠️ Ownership has been transferred."*
6. If 60 seconds pass with no message → nothing changes, old settings intact

### Full Reset Flow

1. Run `Remote Claw: Full Reset` from Command Palette (or status bar)
2. Confirmation dialog: *"This will disconnect your bot and erase all settings. Continue?"*
3. Bot stopped → all SecretStorage entries deleted → all settings cleared
4. Setup Wizard relaunches from Step 1

---

## 12. Settings (`settings.json` + SecretStorage)

```jsonc
// settings.json (non-sensitive only)
{
  "telegramCopilot.instanceName": "Work Laptop",
  "telegramCopilot.enableTerminal": true,
  "telegramCopilot.enableScreenshots": true,
  "telegramCopilot.confirmDestructive": true,
  "telegramCopilot.notifyOnBuildComplete": true,
  "telegramCopilot.notifyOnTestComplete": true,
  "telegramCopilot.notifyOnLongTask": true,
  "telegramCopilot.longTaskThresholdSeconds": 30,
  "telegramCopilot.terminalOutputMaxLines": 100,
  "telegramCopilot.conversationHistoryCount": 20,
  "telegramCopilot.messageFormat": "markdown",
  "telegramCopilot.autoScreenshotAfterAgent": false
}

// SecretStorage (encrypted, never in settings.json)
// - remoteclaw.botToken
// - remoteclaw.ownerId
// - remoteclaw.pin
```

---

## 13. VS Code APIs Used

| Feature | API |
|---|---|
| Chat participant | `vscode.chat.createChatParticipant()` |
| Call Copilot model | `vscode.lm.sendChatRequest()` |
| Terminal control | `vscode.window.createTerminal()` + `terminal.sendText()` |
| Secret storage | `context.secrets.store() / get() / delete()` |
| Config | `vscode.workspace.getConfiguration()` |
| Open external URL | `vscode.env.openExternal()` |
| Diagnostics/errors | `vscode.languages.getDiagnostics()` |
| Active editor | `vscode.window.activeTextEditor` |
| Status bar | `vscode.window.createStatusBarItem()` |
| Open chat panel | `vscode.commands.executeCommand('workbench.action.chat.open', { query })` |
| Notifications | `vscode.window.showInformationMessage() / showWarningMessage()` |
| Setup webview | `vscode.window.createWebviewPanel()` |

---

## 14. Project Structure

```
telegram-remote-claw/
├── src/
│   ├── extension.ts              # Activation entry point, registers everything
│   ├── bot/
│   │   ├── telegramBot.ts        # grammy bot setup + long-polling start/stop
│   │   ├── commands.ts           # /run, /screenshot, /ask, /file, /status, etc.
│   │   └── middleware.ts         # Auth guard, rate limiter, session PIN check
│   ├── bridge/
│   │   ├── copilotBridge.ts      # VS Code Chat Participant + vscode.lm proxy
│   │   └── terminalBridge.ts     # Pseudoterminal creation, output capture
│   ├── notifications/
│   │   └── notificationWatcher.ts # Build/test/long-task event listeners
│   ├── ui/
│   │   ├── setupWizard.ts        # Webview-based first-launch wizard
│   │   └── statusBar.ts          # Status bar item + quick menu
│   ├── utils/
│   │   ├── screenshot.ts         # screenshot-desktop wrapper
│   │   └── formatter.ts          # VS Code markdown ↔ Telegram MarkdownV2 conversion
│   └── config/
│       └── settings.ts           # Settings reader + SecretStorage wrapper
├── media/
│   └── claw-icon.png             # Extension icon
├── package.json                  # contributes: chatParticipants, commands, configuration
├── tsconfig.json
├── .vscodeignore
└── README.md
```

---

## 15. Key Technical Challenges

### Challenge 1 — Copilot Response Streaming to Telegram
`vscode.lm.sendChatRequest()` returns an async stream. Must buffer chunks and send to Telegram only when complete (Telegram messages can't be streamed). For very long responses, may need to split into multiple messages (Telegram 4096 char limit).

### Challenge 2 — @workspace Context Limitation
`vscode.lm.sendChatRequest()` cannot invoke `@workspace` with full codebase indexing from inside another participant (sandboxing restriction). **Workaround:** manually inject file context using `vscode.window.activeTextEditor` and `vscode.workspace.findFiles()` before sending the request.

### Challenge 3 — Terminal Output Capture
`terminal.sendText()` sends commands but VS Code has no native API to capture terminal stdout. **Solution:** use a custom pseudoterminal (`vscode.window.createTerminal({ pty })`) that intercepts all I/O, allowing full output capture and forwarding to Telegram.

### Challenge 4 — Marketplace Requirements
When publishing, `grammy` and `screenshot-desktop` must be bundled (webpack/esbuild). Extension must not require the user to install Node modules manually.

---

## 16. MVP Roadmap

| Phase | Features | Goal |
|---|---|---|
| **Phase 1** | Setup wizard, bot connection, status bar | Working bot, owner auth |
| **Phase 2** | Copilot bridge (`/ask`), response relay to Telegram | Core value feature |
| **Phase 3** | Terminal bridge (`/run`), output capture | Remote control |
| **Phase 4** | Screenshot (`/screenshot`), file sending (`/file`) | Visibility features |
| **Phase 5** | Auto-notifications, inline keyboards | Polish & UX |
| **Phase 6** | Conversation persistence, settings UI | Production ready |
| **Phase 7** | Bundle, test, Marketplace submission | Distribution |

---

*Last updated: March 23, 2026*
