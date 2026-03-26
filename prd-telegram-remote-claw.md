# Product Requirements Document

---

# GitHub Copilot Mobile â€” Telegram Remote Claw

**Extension ID:** `telegram-remote-claw`
**Document Version:** 1.0
**Date:** March 23, 2026
**Status:** Draft â€” Ready for Developer Handoff

---

## Table of Contents

1. [Product Overview & Purpose](#1-product-overview--purpose)
2. [Goals & Success Metrics](#2-goals--success-metrics)
3. [User Personas & Use Cases](#3-user-personas--use-cases)
4. [Functional Requirements](#4-functional-requirements)
5. [Non-Functional Requirements](#5-non-functional-requirements)
6. [Technical Architecture & Constraints](#6-technical-architecture--constraints)
7. [API / Integration Specifications](#7-api--integration-specifications)
8. [Setup & Onboarding Flow](#8-setup--onboarding-flow)
9. [Settings & Configuration Specification](#9-settings--configuration-specification)
10. [Out of Scope](#10-out-of-scope)
11. [Risks & Mitigations](#12-risks--mitigations)
12. [MVP Phased Roadmap](#12-mvp-phased-roadmap)

---

## 1. Product Overview & Purpose

### 1.1 Summary

**GitHub Copilot Mobile â€” Telegram Remote Claw** is a VS Code extension that bridges GitHub Copilot Chat with the Telegram messaging platform. It enables a developer to remotely control key VS Code capabilities â€” including querying Copilot, executing terminal commands, capturing screenshots, reading diagnostics, and receiving build notifications â€” directly from their smartphone via a personal Telegram bot.

### 1.2 Problem Statement

Modern developers frequently step away from their workstations but need to remain connected to their development environment. Existing remote solutions (SSH, remote desktop) are heavyweight, latency-prone, and not mobile-friendly. GitHub Copilot has no official mobile interface. There is no lightweight, programmable way to interact with VS Code from a phone.

### 1.3 Solution

An embedded Telegram bot runs entirely inside VS Code via long-polling (no external server, no public URL required). The developer communicates with their own private bot from any device. The extension acts as a secure proxy between Telegram messages and VS Code's extensibility APIs.

### 1.4 Identity

| Field | Value |
|---|---|
| Display Name | GitHub Copilot Mobile â€” Telegram Remote Claw |
| Extension ID | `telegram-remote-claw` |
| Command Prefix | `remclaw.` |
| Suggested Bot Name | `@RemoteClawBot` |
| Status Bar Label | `ðŸ¦ž Remote Claw` |
| Initial Distribution | Personal use â†’ VS Code Marketplace |

---

## 2. Goals & Success Metrics

### 2.1 Primary Goals

| # | Goal |
|---|---|
| G-01 | Allow the owner to query GitHub Copilot from Telegram and receive the full response on their phone. |
| G-02 | Allow the owner to run terminal commands in VS Code remotely and view their output. |
| G-03 | Allow the owner to capture a screenshot of their desktop on demand. |
| G-04 | Automatically notify the owner of build outcomes, test results, and long-running task completions. |
| G-05 | Ensure zero unauthorized access through a layered security model. |
| G-06 | Require zero external infrastructure â€” the bot runs entirely within VS Code. |
| G-07 | Support Windows, macOS, and Linux without platform-specific code paths exposed to the user. |

### 2.2 Success Metrics

| Metric | Target |
|---|---|
| Onboarding completion time | First-launch wizard completes in under 3 minutes |
| Copilot response delivery | Response appears in Telegram within 5 seconds of Copilot finishing generation |
| Terminal command round-trip | Output delivered to Telegram within 3 seconds for commands completing under 2 seconds |
| Screenshot delivery | Screenshot received in Telegram within 4 seconds of `/screenshot` command |
| Security failures | Zero unauthorized command executions in testing |
| Extension startup impact | Cold activation adds less than 500 ms to VS Code startup |
| Marketplace rating (future) | â‰¥ 4.5 stars after first 20 reviews |

---

## 3. User Personas & Use Cases

### 3.1 Primary Persona â€” Solo Developer (Owner)

- **Name:** The Owner
- **Description:** A software developer who set up the extension on their own machine for personal use. They are the only authorized user of the bot.
- **Technical Level:** Intermediate to advanced. Comfortable with VS Code, Telegram bots concept, and developer tooling.
- **Device:** Uses a smartphone (iOS or Android) with Telegram installed when away from their desk.

### 3.2 Use Cases

| ID | Use Case | Actor | Scenario |
|---|---|---|---|
| UC-01 | Ask Copilot remotely | Owner | Developer is in a meeting and needs a quick code explanation. They open Telegram and send `/ask How does debounce work in JavaScript?` and get the full Copilot answer on their phone. |
| UC-02 | Check build status | Owner | A CI-equivalent local build was running. The developer left their desk. They receive a Telegram notification: "âœ… Build succeeded in 42s" or "âŒ Build failed â€” 3 errors." |
| UC-03 | Run a terminal command | Owner | Developer needs to check if a service is running. They send `/run ps aux | grep node` and receive the output. |
| UC-04 | Review current errors | Owner | Developer sends `/errors` and gets a formatted list of all current TypeScript/lint diagnostics for the open workspace. |
| UC-05 | Take a screenshot | Owner | Developer sends `/screenshot` and receives a photo of their desktop to verify a UI state. |
| UC-06 | Check git diff | Owner | Before committing, the developer sends `/diff` and receives a formatted diff of all staged/unstaged changes. |
| UC-07 | Get workspace status | Owner | Developer sends `/status` and receives the active file name, current git branch, and error count. |
| UC-08 | Open a file | Owner | Developer sends `/open src/app.ts` and the file opens in the VS Code editor on their machine. |
| UC-09 | Read a file remotely | Owner | Developer sends `/file src/config.ts` and receives the file content as a formatted code block. |
| UC-10 | Stop a runaway process | Owner | Developer sends `/stop` to terminate the current running terminal process. |

---

## 4. Functional Requirements

### 4.1 Telegram Bot Lifecycle

| ID | Requirement |
|---|---|
| FR-01 | The extension MUST start the Telegram bot automatically when VS Code activates, provided setup has been completed. |
| FR-02 | The bot MUST use long-polling exclusively (no webhooks). The extension manages the polling loop internally via `grammy`. |
| FR-03 | The bot MUST display its connection status in the VS Code status bar at all times while VS Code is open. |
| FR-04 | The bot MUST stop gracefully when VS Code shuts down or the extension is deactivated, releasing all polling connections. |
| FR-05 | Any message or command sent from an unauthorized Telegram user ID MUST be silently ignored â€” no reply, no error, no log entry that could reveal the bot exists. |
| FR-06 | The bot MUST reconnect automatically after network interruptions without requiring user intervention. |

### 4.2 Copilot Bridge (`/ask`)

| ID | Requirement |
|---|---|
| FR-10 | The extension MUST register a VS Code Chat Participant with the handle `@remoteclaw`. |
| FR-11 | When the owner sends `/ask <question>`, the extension MUST forward the question to GitHub Copilot using the registered chat participant. |
| FR-12 | The extension MUST buffer the full streamed response from Copilot before sending it to Telegram. |
| FR-13 | If the Copilot response exceeds 4,096 characters (Telegram message limit), the extension MUST split it into multiple sequential messages. |
| FR-14 | The extension MUST support a "silent background mode" where Copilot answers without opening or focusing the VS Code Chat panel UI. |
| FR-15 | After a Copilot response is delivered, the extension MUST append an inline keyboard with buttons: [ðŸ“¸ Screenshot] [ðŸ” Ask again]. |
| FR-16 | The "Ask again" button MUST re-submit the same question to Copilot. |
| FR-17 | If Copilot is unavailable or the request fails, the extension MUST send an error message to Telegram describing the failure. |
| FR-18 | The extension MUST inject workspace context (active file content, file path) into the Copilot request to improve response quality. |

### 4.3 Terminal Bridge (`/run`)

| ID | Requirement |
|---|---|
| FR-20 | When the owner sends `/run <command>`, the extension MUST execute the command in a VS Code pseudoterminal and capture its full output. |
| FR-21 | Terminal output MUST be sent back to Telegram as a formatted code block. |
| FR-22 | If output exceeds the configurable `terminalOutputMaxLines` setting (default: 100 lines), the output MUST be truncated and a note appended: `[Output truncated â€” N lines omitted]`. |
| FR-23 | The extension MUST classify commands as "destructive" based on a configurable denylist (e.g., `rm -rf`, `drop`, `format`, `del /f`). |
| FR-24 | When a destructive command is detected AND `confirmDestructive` is enabled, the extension MUST send a Telegram message with an inline keyboard: [âœ… Confirm] [âŒ Cancel] BEFORE executing. |
| FR-25 | If the user does not respond to the destructive command confirmation within 60 seconds, the command MUST be automatically cancelled. |
| FR-26 | The `/stop` command MUST terminate the most recently spawned terminal process. |
| FR-27 | The owner MUST be able to configure a command allowlist, a denylist, or both via settings. If both are set, the allowlist takes precedence. |
| FR-28 | If `enableTerminal` is `false` in settings, `/run` MUST reply with a message explaining that terminal access is disabled and how to enable it. |
| FR-29 | The terminal bridge MUST support multi-line commands submitted as a single Telegram message. |

### 4.4 Screenshot (`/screenshot`)

| ID | Requirement |
|---|---|
| FR-30 | When the owner sends `/screenshot`, the extension MUST capture the full desktop screen and send it as a Telegram photo message. |
| FR-31 | Screenshot capture MUST work on Windows, macOS, and Linux using the `screenshot-desktop` npm package. |
| FR-32 | The extension MAY support a configurable option `autoScreenshotAfterAgent` (default: `false`). When `true`, a screenshot is automatically sent after every Copilot response. |
| FR-33 | If `enableScreenshots` is `false` in settings, `/screenshot` MUST reply with a message explaining that screenshots are disabled. |
| FR-34 | If the screenshot capture fails (e.g., permission denied on macOS), the extension MUST send a descriptive error message to Telegram. |
| FR-35 | Screenshots MUST NOT be stored on disk beyond the temporary buffer needed to send them to Telegram. |

### 4.5 File Operations (`/file`, `/diff`)

| ID | Requirement |
|---|---|
| FR-40 | When the owner sends `/file <path>`, the extension MUST read the file at the given path relative to the workspace root and send its content as a formatted Telegram code block. |
| FR-41 | If the file does not exist or is outside the workspace, the extension MUST send an error message and NOT expose absolute system paths in the error. |
| FR-42 | If the file content exceeds 4,096 characters, the content MUST be split across multiple Telegram messages with sequence indicators (e.g., `[Part 1/3]`). |
| FR-43 | The `/diff` command MUST execute `git diff` in the workspace root and send the result as a formatted code block. |
| FR-44 | If there are no changes, `/diff` MUST reply: `No changes in working tree.` |
| FR-45 | File upload from Telegram to VS Code is explicitly NOT supported in this version (see Section 10). |

### 4.6 Status & Diagnostics (`/status`, `/errors`)

| ID | Requirement |
|---|---|
| FR-50 | The `/status` command MUST reply with: active file name and path, current git branch name, total error count, total warning count. |
| FR-51 | The `/errors` command MUST reply with a formatted list of all diagnostics (errors and warnings) from `vscode.languages.getDiagnostics()`, grouped by file. |
| FR-52 | Each diagnostic entry MUST include: file path, line number, severity, and message text. |
| FR-53 | If there are no diagnostics, `/errors` MUST reply: `No errors or warnings found.` |
| FR-54 | The `/git <args>` command MUST execute an arbitrary `git` subcommand in the workspace root and return the output. The full git command denylist rules (FR-23 through FR-25) apply. |

### 4.7 File Navigation (`/open`)

| ID | Requirement |
|---|---|
| FR-60 | The `/open <filename>` command MUST attempt to open the specified file in the VS Code editor using `vscode.workspace.findFiles()` to locate it within the workspace. |
| FR-61 | If multiple files match the filename, the extension MUST list them in Telegram and prompt the owner to select one by number. |
| FR-62 | The opened file MUST receive focus in the VS Code editor. |
| FR-63 | If no matching file is found, the extension MUST send: `File not found in workspace: <filename>`. |

### 4.8 Auto-Notifications

| ID | Requirement |
|---|---|
| FR-70 | When `notifyOnBuildComplete` is `true`, the extension MUST send a Telegram notification when a build task completes, including: outcome (success/failure), duration, and â€” if failed â€” a summary of errors. |
| FR-71 | The build failure notification MUST include an inline keyboard: [ðŸ”„ Retry build] [ðŸ“‹ Show errors] [ðŸ“‚ Open failing file]. |
| FR-72 | When `notifyOnTestComplete` is `true`, the extension MUST send a Telegram notification when a test run completes, including: pass count, fail count, and â€” if any failed â€” the names of failing tests. |
| FR-73 | When `notifyOnLongTask` is `true`, the extension MUST monitor running tasks and send a notification when any task exceeds the `longTaskThresholdSeconds` duration (default: 30 seconds). |
| FR-74 | Long-task notifications MUST include the task name and elapsed time. |
| FR-75 | All auto-notifications MUST be suppressible individually via their respective settings toggles. |

### 4.9 Inline Keyboard Actions

| ID | Requirement |
|---|---|
| FR-80 | After every Copilot response: append buttons [ðŸ“¸ Screenshot] [ðŸ” Ask again]. |
| FR-81 | After a failed build notification: append buttons [ðŸ”„ Retry build] [ðŸ“‹ Show errors] [ðŸ“‚ Open failing file]. |
| FR-82 | Before any destructive terminal command: present confirmation buttons [âœ… Confirm] [âŒ Cancel]. |
| FR-83 | All inline keyboard button callbacks MUST be handled by the bot and MUST validate the requesting user ID before acting. |
| FR-84 | After an inline keyboard button is pressed, the keyboard MUST be removed from the message (replaced with a status update text) to prevent double-execution. |

### 4.10 `/help` Command

| ID | Requirement |
|---|---|
| FR-90 | The `/help` command MUST reply with a formatted list of all available commands and their descriptions. |
| FR-91 | The `/help` output MUST reflect the current settings â€” commands disabled via settings MUST be shown as disabled in the help text. |

### 4.11 Conversation Persistence

| ID | Requirement |
|---|---|
| FR-100 | The extension MUST persist the last N conversation exchanges (default: 20, configurable via `conversationHistoryCount`) across VS Code restarts. |
| FR-101 | Conversation history MUST be stored locally on the developer's machine only â€” never in Telegram servers or any cloud storage. |
| FR-102 | Conversation history MUST be stored in the extension's global storage directory provided by the VS Code Extension API. |
| FR-103 | Conversation history MUST be cleared when the owner performs a Full Reset (FR-120). |

### 4.12 Security â€” Authentication & Access Control

| ID | Requirement |
|---|---|
| FR-110 | The extension MUST maintain a whitelist containing exactly one Telegram numeric user ID (the owner). |
| FR-111 | The owner's Telegram ID MUST be captured automatically during the first-launch wizard (auto-detect pattern, FR-130). It MUST NOT be entered manually by the user. |
| FR-112 | If `enablePIN` is `true`, the owner MUST send `/auth <pin>` once per VS Code session before any other commands are accepted. |
| FR-113 | The session PIN MUST be stored in VS Code `SecretStorage` â€” never in `settings.json`. |
| FR-114 | The bot token MUST be stored in VS Code `SecretStorage` â€” never in `settings.json` or any plaintext file. |
| FR-115 | A configurable rate limiter MUST reject commands if the owner exceeds a maximum commands-per-minute threshold. |
| FR-116 | On rate limit exceeded, the extension MUST send a single Telegram warning message and enforce a cooldown period. |

### 4.13 Reset & Account Management

| ID | Requirement |
|---|---|
| FR-120 | The status bar item MUST provide a quick-pick menu with actions: Change Authorized User, Reconnect Bot, Open Settings, Disconnect, Full Reset. |
| FR-121 | "Change Authorized User" MUST open a 60-second capture window: the first Telegram user to send any message to the bot during that window becomes the new authorized owner. |
| FR-122 | "Reconnect Bot" MUST stop the current polling loop and start a new one without requiring VS Code restart. |
| FR-123 | "Disconnect" MUST stop the bot polling loop and update the status bar to show "Disconnected" without erasing any credentials. |
| FR-124 | "Full Reset" MUST: stop bot polling, delete all entries from `SecretStorage`, clear conversation history, clear owner ID, and relaunch the first-launch setup wizard. |
| FR-125 | "Full Reset" MUST ask for confirmation before executing, with a VS Code warning dialog. |

---

## 5. Non-Functional Requirements

### 5.1 Security

| ID | Requirement |
|---|---|
| NFR-S01 | The bot token and owner ID MUST be stored exclusively in VS Code `SecretStorage` (OS-level encrypted credential store). They MUST NOT appear in `settings.json`, workspace files, or logs. |
| NFR-S02 | Any Telegram message from a user ID not matching the whitelist MUST be silently dropped. The bot MUST NOT reply, acknowledge, or log any information that could reveal its existence. |
| NFR-S03 | The PIN, when enabled, MUST be a minimum of 4 digits. No maximum is enforced by the extension, but the user is recommended to use 6+. |
| NFR-S04 | The destructive command denylist MUST be evaluated case-insensitively and MUST strip leading/trailing whitespace before comparison. |
| NFR-S05 | File path inputs from Telegram (e.g., `/file ../../../etc/passwd`) MUST be sanitized and resolved against the workspace root. Any path that resolves outside the workspace root MUST be rejected with a generic error message. Path traversal attacks MUST be prevented. |
| NFR-S06 | No sensitive data (tokens, PINs, owner IDs) MUST appear in VS Code output channels, developer console logs, or error messages sent to Telegram. |
| NFR-S07 | The bot MUST enforce a minimum rate limit of 1 command per 2 seconds per session to prevent abuse even from the owner. |
| NFR-S08 | All inline keyboard callback queries MUST re-validate the sender's Telegram user ID before executing the associated action. |

### 5.2 Performance

| ID | Requirement |
|---|---|
| NFR-P01 | Extension activation (including bot start) MUST add less than 500 ms to VS Code's startup time. |
| NFR-P02 | The long-polling loop MUST NOT cause noticeable CPU or memory spikes during idle periods. |
| NFR-P03 | Copilot responses MUST begin being forwarded to Telegram within 500 ms of stream completion. |
| NFR-P04 | Screenshot capture and Telegram delivery MUST complete within 4 seconds on an average consumer machine. |
| NFR-P05 | The extension MUST NOT block the VS Code UI thread during bot operations, Copilot requests, or screenshot captures. All I/O operations MUST be asynchronous. |

### 5.3 Reliability

| ID | Requirement |
|---|---|
| NFR-R01 | If the Telegram API is unreachable, the extension MUST retry with exponential backoff (starting at 5s, up to 5 minutes), and display the disconnected state in the status bar. |
| NFR-R02 | If a single command handler throws an unhandled error, the error MUST be caught, a generic error message sent to Telegram, and the bot MUST continue operating normally. |
| NFR-R03 | Conversation history writes MUST be atomic â€” a VS Code crash during a write MUST NOT corrupt the history file. |
| NFR-R04 | The extension MUST function correctly after VS Code reloads a window (workspace reload). |
| NFR-R05 | Long-polling connections MUST handle Telegram's 30-second timeout correctly without treating it as an error. |

### 5.4 Usability

| ID | Requirement |
|---|---|
| NFR-U01 | All Telegram error messages MUST be human-readable and actionable, not raw stack traces. |
| NFR-U02 | The setup wizard MUST complete in under 3 minutes for a user who already has a Telegram account. |
| NFR-U03 | Status bar icon MUST clearly show three states: Connected (green/active icon), Disconnected (grey icon), Error (red/warning icon). |
| NFR-U04 | All configurable settings MUST include descriptive labels and descriptions visible in the VS Code Settings UI. |

### 5.5 Maintainability

| ID | Requirement |
|---|---|
| NFR-M01 | All source files MUST be written in TypeScript with strict mode enabled. |
| NFR-M02 | The codebase MUST follow the project structure defined in Section 6.4. |
| NFR-M03 | All VS Code API calls MUST be abstracted behind module boundaries so they can be mocked in unit tests. |
| NFR-M04 | The extension MUST be bundled using webpack or esbuild for Marketplace distribution, including all npm dependencies. |

---

## 6. Technical Architecture & Constraints

### 6.1 Architecture Overview

The extension follows an **Embedded Bot** architecture. There is no external server, no webhook, and no public URL.

```
[Telegram App (phone)]
        â†•  HTTPS Long-Polling
[Telegram Bot API Servers]
        â†•  grammy (Long-Poll Client)
[VS Code Extension Process]
  â”œâ”€â”€ Bot Layer (grammy)
  â”‚     â”œâ”€â”€ Middleware (auth, rate-limit)
  â”‚     â””â”€â”€ Command Handlers
  â”œâ”€â”€ Bridge Layer
  â”‚     â”œâ”€â”€ CopilotBridge â†’ VS Code Chat / LM API
  â”‚     â””â”€â”€ TerminalBridge â†’ VS Code Terminal API
  â”œâ”€â”€ Notification Watcher â†’ VS Code Task/Test Events
  â”œâ”€â”€ UI Layer
  â”‚     â”œâ”€â”€ Setup Wizard (Webview)
  â”‚     â””â”€â”€ Status Bar Item
  â””â”€â”€ Config Layer
        â”œâ”€â”€ settings.json (non-sensitive)
        â””â”€â”€ SecretStorage (tokens, PIN, owner ID)
```

### 6.2 Technology Stack

| Layer | Technology | Justification |
|---|---|---|
| Extension Language | TypeScript (strict) | Required for VS Code extensions. Type safety, IntelliSense, maintainability. |
| Telegram Client Library | `grammy` (latest stable) | TypeScript-first, modern API, best DX, built-in long-polling support. |
| Screenshot Capture | `screenshot-desktop` npm package | Cross-platform (Win/macOS/Linux), no native bindings required. |
| Bundler | esbuild or webpack | Required for Marketplace: bundles all dependencies into a single file. |
| Bot Connection Mode | Long-polling | Works behind NAT/firewall. No public URL required. Handled by grammy. |
| Storage | VS Code `SecretStorage` (sensitive) + `globalStorageUri` (history) + `settings.json` (preferences) | Appropriate tiering: encrypted for secrets, local file for persistence, workspace settings for preferences. |

### 6.3 Constraints

| ID | Constraint |
|---|---|
| C-01 | The extension requires GitHub Copilot to be installed and authenticated in the same VS Code instance. Without it, `/ask` is unavailable. |
| C-02 | The Telegram Bot API imposes a 4,096 character limit per message. The extension must handle splitting. |
| C-03 | The Telegram Bot API imposes a 50 MB file size limit for photos and documents. Screenshots are expected to be well under this limit. |
| C-04 | Long-polling is the only supported connection mode. Webhook mode is explicitly out of scope. |
| C-05 | Terminal output capture using a pseudoterminal (PTY) may not capture output from subprocesses that write directly to the OS file descriptors. This is a known VS Code API limitation. |
| C-06 | On macOS, screen recording permission must be granted manually by the user for `screenshot-desktop` to function. The setup wizard MUST inform the user of this requirement. |
| C-07 | The extension targets VS Code API version `^1.90.0` or later, as this is required for the Chat Participant API. |
| C-08 | Only one authorized Telegram user (the owner) is supported per VS Code instance. Multi-user access is out of scope. |

### 6.4 Project Structure

```
telegram-remote-claw/
â”œâ”€â”€ src/
â”‚   â”œâ”€â”€ extension.ts              # Entry point: activate / deactivate
â”‚   â”œâ”€â”€ bot/
â”‚   â”‚   â”œâ”€â”€ telegramBot.ts        # grammy bot instance, polling lifecycle
â”‚   â”‚   â”œâ”€â”€ commands.ts           # All slash command handlers
â”‚   â”‚   â””â”€â”€ middleware.ts         # Auth, rate-limiting, session middleware
â”‚   â”œâ”€â”€ bridge/
â”‚   â”‚   â”œâ”€â”€ copilotBridge.ts      # VS Code Chat / LM API integration
â”‚   â”‚   â””â”€â”€ terminalBridge.ts     # Pseudoterminal creation and I/O capture
â”‚   â”œâ”€â”€ notifications/
â”‚   â”‚   â””â”€â”€ notificationWatcher.ts # Task/test event listeners
â”‚   â”œâ”€â”€ ui/
â”‚   â”‚   â”œâ”€â”€ setupWizard.ts        # First-launch webview wizard
â”‚   â”‚   â””â”€â”€ statusBar.ts          # Status bar item lifecycle
â”‚   â”œâ”€â”€ utils/
â”‚   â”‚   â”œâ”€â”€ screenshot.ts         # screenshot-desktop wrapper
â”‚   â”‚   â””â”€â”€ formatter.ts          # Telegram message formatting utilities
â”‚   â””â”€â”€ config/
â”‚       â””â”€â”€ settings.ts           # Settings access + SecretStorage helpers
â”œâ”€â”€ media/
â”‚   â””â”€â”€ claw-icon.png
â”œâ”€â”€ package.json
â”œâ”€â”€ tsconfig.json
â”œâ”€â”€ .vscodeignore
â””â”€â”€ README.md
```

---

## 7. API / Integration Specifications

### 7.1 VS Code Extension APIs

| API | Usage |
|---|---|
| `vscode.chat.createChatParticipant(id, handler)` | Register the `@remoteclaw` chat participant that proxies questions to Copilot. |
| `vscode.lm.sendChatRequest(model, messages, options, token)` | Send a request to the language model and receive a streamed response. |
| `vscode.window.createTerminal({ pty })` | Create a pseudoterminal to execute `/run` commands and capture I/O. |
| `context.secrets.store(key, value)` | Store bot token, owner ID, and PIN in OS-level encrypted storage. |
| `context.secrets.get(key)` | Retrieve secrets at runtime. |
| `context.secrets.delete(key)` | Delete secrets on Full Reset. |
| `vscode.workspace.getConfiguration('telegramCopilot')` | Read all extension settings. |
| `vscode.env.openExternal(uri)` | Open BotFather or external links during setup. |
| `vscode.languages.getDiagnostics()` | Retrieve all current errors/warnings for `/errors`. |
| `vscode.window.activeTextEditor` | Get currently active file for `/status` and Copilot context injection. |
| `vscode.window.createStatusBarItem()` | Create the `ðŸ¦ž Remote Claw` status bar indicator. |
| `vscode.commands.executeCommand('workbench.action.chat.open', { query })` | Open the Copilot Chat panel with a pre-filled query (optional/non-silent mode). |
| `vscode.window.showInformationMessage()` / `showWarningMessage()` | Show confirmation dialogs for Full Reset and destructive command warnings. |
| `vscode.window.createWebviewPanel()` | Host the setup wizard UI. |
| `vscode.workspace.findFiles(pattern)` | Locate files by name for `/open`. |
| `vscode.tasks.onDidEndTask` | Listen for task completion to trigger build/test notifications. |
| `vscode.extensions.getExtension('github.copilot-chat')` | Check if GitHub Copilot Chat is installed and active before using LM APIs. |

### 7.2 Telegram Bot API (via grammy)

| Operation | grammy API / Method |
|---|---|
| Start bot with long-polling | `bot.start()` |
| Handle slash commands | `bot.command('ask', handler)` |
| Send text messages | `ctx.reply(text, { parse_mode: 'Markdown' })` |
| Send photos | `ctx.replyWithPhoto(InputFile.fromBuffer(buffer))` |
| Send documents | `ctx.replyWithDocument(InputFile.fromBuffer(buffer, filename))` |
| Inline keyboard | `new InlineKeyboard().text('label', 'callback_data')` |
| Handle button callbacks | `bot.callbackQuery('callback_data', handler)` |
| Answer callback queries | `ctx.answerCallbackQuery()` |
| Edit message (remove keyboard) | `ctx.editMessageReplyMarkup({ reply_markup: undefined })` |
| Get sender user ID | `ctx.from.id` |
| Stop bot | `bot.stop()` |

### 7.3 grammy Middleware Chain

Every incoming update MUST pass through the following middleware in order:

1. **Auth Middleware** â€” Validate `ctx.from.id` against the stored owner ID. Drop silently if mismatch.
2. **Session Middleware** â€” Check if PIN is required and not yet provided for the current session. If PIN required and not authenticated, reject with `/auth <pin>` prompt (except for the `/auth` command itself).
3. **Rate Limit Middleware** â€” Track command count per rolling 60-second window. Reject with warning if over limit.
4. **Command Router** â€” Route to the appropriate command handler.
5. **Error Handler** â€” Catch unhandled errors in any handler, log internally, send generic Telegram error message.

### 7.4 Copilot Response Streaming Protocol

```
1. Owner sends: /ask <question>
2. Extension constructs messages array:
   - System: "You are a coding assistant. Context: <active file content>"
   - User: <question>
3. Calls vscode.lm.sendChatRequest(model, messages, {}, cancellationToken)
4. Iterates async stream: for await (const chunk of response.stream)
5. Appends chunks to buffer string
6. On stream end: check buffer.length
   - If <= 4096: send as single Telegram message
   - If > 4096: split at paragraph/newline boundaries, send as sequence
7. Append inline keyboard to final message
```

---

## 8. Setup & Onboarding Flow

### 8.1 First-Launch Detection

On VS Code activation, the extension checks `SecretStorage` for `remoteclaw.botToken`. If absent, the setup wizard launches automatically.

### 8.2 Setup Wizard â€” 4-Step Flow

**Step 1 â€” Create Telegram Bot**
- Display: Instructions to open Telegram, search for `@BotFather`, send `/newbot`, and copy the resulting HTTP API token.
- Input: Text field for bot token.
- Validation: Token must match the pattern `^\d+:[A-Za-z0-9_-]{35,}$`.
- On submit: Store token in `SecretStorage` under `remoteclaw.botToken`.

**Step 2 â€” Auto-Detect Owner**
- Display: "Send ANY message to your bot in Telegram within the next 60 seconds."
- Action: Extension starts the bot polling immediately.
- Capture: First message received â†’ extract `ctx.from.id` â†’ store in `SecretStorage` under `remoteclaw.ownerId`.
- Timeout: If 60 seconds pass with no message â†’ show error, allow retry.
- The user MUST NOT manually enter their Telegram ID.

**Step 3 â€” Permissions & Preferences**
- Display a form with toggle switches for:
  - Enable terminal commands (`enableTerminal`, default: `true`)
  - Enable screenshots (`enableScreenshots`, default: `true`)
  - Require session PIN (`enablePIN`, default: `false`)
  - If PIN enabled: PIN input field (min 4 digits, stored in `SecretStorage`)
  - Notify on build complete (`notifyOnBuildComplete`, default: `true`)
  - Notify on test complete (`notifyOnTestComplete`, default: `true`)
  - Notify on long tasks (`notifyOnLongTask`, default: `true`)
- On macOS: display a banner informing the user to grant Screen Recording permission in System Preferences if screenshots are enabled.

**Step 4 â€” Connection Test**
- Extension sends a test message to Telegram: `ðŸ¦ž Remote Claw is connected! Type /help to see available commands.`
- Display: "Check your Telegram â€” you should have received a message."
- Provide a "Finish Setup" button to close the wizard.
- On success: update status bar to Connected state.

---

## 9. Settings & Configuration Specification

### 9.1 `settings.json` â€” Non-Sensitive Settings

All settings are namespaced under `telegramCopilot.*`.

| Setting Key | Type | Default | Description |
|---|---|---|---|
| `telegramCopilot.instanceName` | `string` | `"VS Code"` | Friendly name for this VS Code instance, shown in notifications. |
| `telegramCopilot.enableTerminal` | `boolean` | `true` | Allow `/run` commands. |
| `telegramCopilot.enableScreenshots` | `boolean` | `true` | Allow `/screenshot` commands. |
| `telegramCopilot.confirmDestructive` | `boolean` | `true` | Require inline keyboard confirmation for destructive commands. |
| `telegramCopilot.commandAllowlist` | `string[]` | `[]` | If non-empty, only these commands are permitted via `/run`. |
| `telegramCopilot.commandDenylist` | `string[]` | `["rm -rf", "del /f", "format", "DROP TABLE", ":(){:|:&};:"]` | Commands that trigger a confirmation prompt or are blocked. |
| `telegramCopilot.notifyOnBuildComplete` | `boolean` | `true` | Send Telegram message when a VS Code task completes. |
| `telegramCopilot.notifyOnTestComplete` | `boolean` | `true` | Send Telegram message when a test run completes. |
| `telegramCopilot.notifyOnLongTask` | `boolean` | `true` | Send Telegram message when a task exceeds the threshold. |
| `telegramCopilot.longTaskThresholdSeconds` | `number` | `30` | Seconds before a running task is considered "long." Min: 5. |
| `telegramCopilot.terminalOutputMaxLines` | `number` | `100` | Maximum terminal output lines before truncation. Min: 10, Max: 500. |
| `telegramCopilot.conversationHistoryCount` | `number` | `20` | Number of Copilot exchanges to persist across restarts. Min: 0, Max: 100. |
| `telegramCopilot.messageFormat` | `enum` | `"markdown"` | Telegram message parse mode: `"markdown"` or `"html"`. |
| `telegramCopilot.autoScreenshotAfterAgent` | `boolean` | `false` | Automatically send a screenshot after every Copilot response. |
| `telegramCopilot.rateLimitPerMinute` | `number` | `20` | Maximum commands per minute from the owner. Min: 5, Max: 60. |
| `telegramCopilot.enablePIN` | `boolean` | `false` | Require `/auth <pin>` once per VS Code session. |

### 9.2 `SecretStorage` â€” Sensitive Credentials

| Key | Content | Notes |
|---|---|---|
| `remoteclaw.botToken` | Telegram Bot API token | Set during setup wizard Step 1. |
| `remoteclaw.ownerId` | Numeric Telegram user ID | Set during setup wizard Step 2. |
| `remoteclaw.pin` | Session PIN (string) | Set during setup wizard Step 3. Only present if `enablePIN` is `true`. |

---

## 10. Out of Scope

The following features are explicitly **not** included in any phase of the current roadmap:

| # | Out of Scope Item | Reason |
|---|---|---|
| OOS-01 | Webhook-based bot connection | Requires public URL/server. Violates zero-infrastructure design principle. |
| OOS-02 | File upload from Telegram to VS Code | Security risk; complex validation. May be considered post-v1. |
| OOS-03 | Multi-user / team access | Architectural complexity; security surface area increase. Single owner only. |
| OOS-04 | Audio/voice message processing | Out of scope for a developer productivity tool. |
| OOS-05 | Image analysis of screenshots via Copilot | Multimodal Copilot API not stable enough for production use. |
| OOS-06 | Remote desktop / full GUI control | Scope creep; security concerns. |
| OOS-07 | Integration with GitHub Issues / PRs | Out of scope for v1. Separate extension territory. |
| OOS-08 | Cloud sync of conversation history | Privacy concerns, infrastructure dependency. Local only. |
| OOS-09 | Custom Telegram bot themes or UI customization | Not supported by Telegram Bot API. |
| OOS-10 | VS Code Remote (SSH/Tunnel) environments | May work incidentally but is not a tested or supported scenario for v1. |
| OOS-11 | Slack, Discord, or other messaging platforms | Telegram only. Abstraction for multi-platform is a post-v1 consideration. |

---

## 11. Risks & Mitigations

| ID | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| R-01 | VS Code Chat Participant API (`vscode.chat.*`) breaking changes between versions | Medium | High | Pin minimum VS Code API version in `package.json` `engines.vscode`. Add version check on activation with clear error message. Monitor VS Code release notes. |
| R-02 | GitHub Copilot extension not installed or not authenticated | High | High | On activation, check for `github.copilot-chat` extension. If absent, display a VS Code notification and disable `/ask` gracefully, leaving all other features functional. |
| R-03 | Telegram Bot token leaked via settings.json | Low | Critical | All token storage goes exclusively through SecretStorage. Settings schema definition MUST NOT include token fields. Code review checklist item. |
| R-04 | Path traversal attack via `/file` command | Medium | High | Resolve all paths against workspace root using `path.resolve()`. Reject if resolved path does not start with workspace root. Return generic error, no path details. |
| R-05 | Destructive command executed before user responds to confirmation | Low | High | Auto-cancel confirmation after 60 seconds. Log cancellation. Never execute without explicit [âœ… Confirm] callback. |
| R-06 | `screenshot-desktop` fails on macOS due to missing Screen Recording permission | High (macOS) | Medium | Setup wizard displays explicit macOS permission instructions. On capture failure, send descriptive Telegram error. Graceful degradation â€” other features continue. |
| R-07 | grammy long-polling loop crashes silently | Medium | High | Wrap bot lifecycle in try/catch with restart logic. Update status bar on error. Send Telegram recovery notification when reconnected. |
| R-08 | Large Copilot responses causing Telegram API rate limits | Low | Medium | Implement 1-second delay between split message parts. Respect Telegram's 30 messages/second global limit. |
| R-09 | VS Code Marketplace rejecting extension due to bundled dependencies | Medium | Medium | Use `esbuild` to produce a single bundled `.js` output. Ensure `.vscodeignore` excludes `node_modules`. Test packaging with `vsce package` before submission. |
| R-10 | PIN brute-force via Telegram | Low | Medium | Rate limiter enforces max attempts. After 5 failed `/auth` attempts, lock session and send warning message to owner. |

---

## 12. MVP Phased Roadmap

### Phase 1 â€” Foundation (Bot + Status Bar + Setup)

**Goal:** Bot connects, user can be identified, status is visible.

**Deliverables:**
- `extension.ts`: activation/deactivation lifecycle with startup check
- `setupWizard.ts`: 4-step webview wizard (token input, auto-detect owner, preferences, connection test)
- `telegramBot.ts`: grammy bot instance, long-poll start/stop
- `middleware.ts`: auth middleware (user ID whitelist), rate limiter stub
- `statusBar.ts`: status bar item with Connected / Disconnected / Error states and quick-pick menu
- `settings.ts`: all settings read/write helpers; SecretStorage wrapper

**Acceptance Criteria:**
- Wizard completes successfully, bot token and owner ID are stored in SecretStorage
- Status bar shows correct state
- Stranger messages are silently dropped
- Bot reconnects automatically after a simulated network drop

---

### Phase 2 â€” Copilot Bridge (`/ask`)

**Goal:** Owner can query Copilot from Telegram.

**Deliverables:**
- `copilotBridge.ts`: registers `@remoteclaw` chat participant, streams LM response
- `commands.ts`: `/ask` handler wired to CopilotBridge
- `formatter.ts`: message splitter for >4096 char responses, markdown formatter
- Inline keyboard after response: [ðŸ“¸ Screenshot] [ðŸ” Ask again]
- `/help` command with dynamic command listing

**Acceptance Criteria:**
- `/ask How does async/await work?` returns a complete Copilot response in Telegram
- Responses >4096 chars are correctly split across multiple messages
- [ðŸ” Ask again] correctly re-submits the previous question
- If Copilot is unavailable, a clear error message is sent

---

### Phase 3 â€” Terminal Bridge (`/run`, `/stop`)

**Goal:** Owner can execute and read terminal commands remotely.

**Deliverables:**
- `terminalBridge.ts`: pseudoterminal creation, command dispatch, I/O capture
- `/run <command>` handler with output truncation
- Destructive command detection and inline keyboard confirmation flow
- `/stop` handler to terminate active process
- Command allowlist/denylist enforcement

**Acceptance Criteria:**
- `/run echo hello world` returns `hello world` in Telegram
- `/run rm -rf /` triggers confirmation keyboard, does NOT execute without [âœ… Confirm]
- Output over 100 lines is truncated with a note
- `/stop` terminates the current process

---

### Phase 4 â€” Screenshots & File Operations

**Goal:** Owner can see their screen and read file content remotely.

**Deliverables:**
- `screenshot.ts`: `screenshot-desktop` wrapper with error handling
- `/screenshot` handler
- `/file <path>` handler with path sanitization and split for large files
- `/diff` handler (git diff)
- `/git <args>` handler

**Acceptance Criteria:**
- `/screenshot` sends a photo of the current desktop within 4 seconds
- `/file src/extension.ts` returns the file content as formatted code
- `/file ../../etc/passwd` returns a generic "file not found" error (path traversal blocked)
- `/diff` returns current git diff or "No changes" message

---

### Phase 5 â€” Status, Diagnostics & Auto-Notifications

**Goal:** Owner receives proactive VS Code signals and can query workspace state.

**Deliverables:**
- `/status` handler (active file, branch, error count)
- `/errors` handler (formatted diagnostics list)
- `/open <filename>` handler with multi-match disambiguation
- `notificationWatcher.ts`: `vscode.tasks.onDidEndTask` listener for build/test/long-task events
- Inline keyboard buttons on build failure notification

**Acceptance Criteria:**
- `/status` returns correct file, branch, and error count
- `/errors` returns all current diagnostics grouped by file
- Build failure notification arrives in Telegram within 3 seconds of task completion
- [ðŸ”„ Retry build] button re-triggers the build task

---

### Phase 6 â€” Conversation Persistence & Settings UI

**Goal:** State survives VS Code restarts; settings are user-friendly.

**Deliverables:**
- Conversation history read/write to `globalStorageUri` with atomic writes
- History replay on extension activation (last N exchanges injected into context)
- Full Reset clears history from storage
- All settings visible in VS Code Settings UI with descriptions and validation
- PIN authentication flow (`/auth <pin>` middleware integration)

**Acceptance Criteria:**
- After VS Code restart, `/ask` retains context of previous N conversations
- Settings UI shows all `telegramCopilot.*` settings with correct defaults and descriptions
- Full Reset clears all history and secrets and relaunches wizard
- With PIN enabled, commands before `/auth` are rejected with a clear message

---

### Phase 7 â€” Bundle, Test & Marketplace Submission

**Goal:** Extension is production-ready and distributeable.

**Deliverables:**
- esbuild/webpack bundling configuration producing a single extension output file
- `.vscodeignore` configured to exclude `node_modules`, source maps, test files
- `README.md` with full setup guide, command reference, and security notes
- `package.json` with complete `contributes` block: commands, configuration schema, activation events
- Icon (`claw-icon.png`) sized to Marketplace requirements (128Ã—128 px)
- Manual end-to-end testing checklist executed on Windows, macOS, Linux
- `vsce package` produces a valid `.vsix` file
- Marketplace submission with metadata, screenshots, and category tags

**Acceptance Criteria:**
- `vsce package` completes with no errors or warnings
- Extension installs cleanly from `.vsix` on a fresh VS Code instance
- All Phase 1â€“6 acceptance criteria pass on all three platforms
- No secrets appear in bundled output or any packaged file

---

*End of Document*

---

**Document Owner:** Extension Developer
**Review Cycle:** Before each phase kickoff
**Last Updated:** March 23, 2026
