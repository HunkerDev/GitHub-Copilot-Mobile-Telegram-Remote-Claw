import * as vscode from 'vscode';
import { Bot, Context, InlineKeyboard, InputFile } from 'grammy';
import { CopilotBridge } from '../bridge/copilotBridge';
import { SecretsManager, TelegramCopilotConfig } from '../config/settings';
import {
    convertTablesToCards,
    markdownToEntitiesTelegram,
    splitTelegramEntities,
    type TelegramEntity,
} from '../utils/formatter';
import { ChatMonitor } from '../bridge/chatMonitor';
import { captureScreenshot } from '../utils/screenshot';
import { TerminalBridge } from '../bridge/terminalBridge';

// ── Entity type mapping: our names → Telegram Bot HTTP API names ──────────────
const TELEGRAM_ENTITY_TYPE: Record<TelegramEntity['_'], string> = {
    messageEntityBold:       'bold',
    messageEntityItalic:     'italic',
    messageEntityStrike:     'strikethrough',
    messageEntityCode:       'code',
    messageEntityPre:        'pre',
    messageEntityTextUrl:    'text_link',
    messageEntityBlockquote: 'blockquote',
};

/** Converts our TelegramEntity[] to the shape grammy / Telegram Bot API expects. */
function toGrammyEntities(entities: TelegramEntity[]): object[] {
    return entities.map(e => {
        const out: Record<string, unknown> = {
            type:   TELEGRAM_ENTITY_TYPE[e._],
            offset: e.offset,
            length: e.length,
        };
        if (e.url      !== undefined) { out.url      = e.url; }
        if (e.language !== undefined) { out.language = e.language; }
        return out;
    });
}

// ── Auto-approve guard ─────────────────────────────────────────────────────────

/**
 * Returns true if chat.tools.autoApprove is enabled for the current workspace.
 */
function isAutoApproveEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>('chat.tools.terminal.ignoreDefaultAutoApproveRules', false);
}

/**
 * Checks auto-approve setting. If not enabled, sends a Yes/No prompt to the user
 * and returns false (caller must stop processing). Returns true if all good.
 */
async function ensureAutoApprove(ctx: Context): Promise<boolean> {
    if (isAutoApproveEnabled()) {
        return true;
    }

    const keyboard = new InlineKeyboard()
        .text('✅ Yes, enable it', 'autoApprove_yes')
        .text('❌ No', 'autoApprove_no');

    await ctx.reply(
        '⚠️ To avoid chat restrictions and ensure this extension works properly, you need to enable all commands in the current workspace. ' +
        'GitHub Copilot does not support approvals through its API, so this must be configured manually for it to function correctly. ' +
        'Would you like to enable it now?',
        { reply_markup: keyboard },
    );
    return false;
}

// ── T4.2 — Screenshot handler ─────────────────────────────────────────────────
async function handleScreenshot(ctx: Context, cfg: TelegramCopilotConfig): Promise<void> {
    try {
        const buffer = await captureScreenshot();
        const caption = `📸 ${cfg.instanceName} — ${new Date().toLocaleString()}`;
        await ctx.replyWithPhoto(new InputFile(buffer, 'screenshot.png'), { caption });
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`❌ Screenshot failed: ${errMsg}`);
    }
}

/**
 * Registers all Telegram command handlers on the grammy Bot using the `?` prefix router.
 *
 * @param bot             grammy Bot instance (already has auth middleware attached).
 * @param copilotBridge   CopilotBridge instance for direct LM access.
 * @param config          Current extension configuration snapshot.
 * @param secretsManager  SecretsManager used to re-validate ownerId in callbacks.
 * @param context         VS Code extension context — used for globalState persistence.
 */
export function registerCommands(
    bot: Bot<Context>,
    copilotBridge: CopilotBridge,
    config: TelegramCopilotConfig,
    secretsManager: SecretsManager,
    context: vscode.ExtensionContext,
    terminalBridge: TerminalBridge,
): ChatMonitor {
    // ── Persistent state (survives VS Code restarts via globalState) ──────────
    // agentModeEnabled: when true, all plain-text messages are forwarded to Copilot.
    // Defaults to true on first run so the user is immediately in agent mode.
    let agentModeEnabled: boolean = context.globalState.get<boolean>('remoteclaw.agentModeEnabled', true);

    // Stores the last ?agent question per chat (used internally).
    const lastQuestion = new Map<number, string>();

    // ── ChatMonitor — persistent differential clipboard monitor ───────────────
    const monitor = new ChatMonitor(config);

    /**
     * `copyAll` tends to copy the entire conversation. We only want the last answer.
     * The format is: "GitHub Copilot: <response text continues on same line>"
     */
    function extractLastAssistantResponse(fullTranscript: string): string {
        const lines = fullTranscript.split('\n');
        
        // Find the last line containing the bot marker
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            
            // Check for "GitHub Copilot:" or "Assistant:"
            const copilotMatch = line.match(/^GitHub Copilot:\s*(.*)$/);
            const assistantMatch = line.match(/^Assistant:\s*(.*)$/);
            
            if (copilotMatch || assistantMatch) {
                // Extract text after the marker on the same line
                const firstLine = (copilotMatch?.[1] || assistantMatch?.[1] || '').trim();
                
                // Collect all remaining lines after this one
                const remainingLines = lines.slice(i + 1);
                
                // Combine: first line content + all remaining lines
                const fullResponse = [firstLine, ...remainingLines]
                    .filter(l => l.trim()) // Remove empty lines
                    .join('\n')
                    .trim();
                
                return fullResponse;
            }
        }
        
        // Fallback: just return the whole thing if we can't find the barrier
        return fullTranscript.trim();
    }

    // ── Shared helper: execute the Copilot ask flow ────────────────────────────
    async function executeAsk(ctx: Context, question: string): Promise<void> {
        // ── Mode 1: Native Chat Monitor (differential streaming) ──────────────
        if (config.nativeChatCapture) {
            await ctx.reply('...');

            // Build sendFn: converts Markdown → plain text + entities, splits
            // at the 4096-character limit, and sends each chunk via Bot API entities
            // (no parse_mode — zero escaping errors).
            const sendFn = async (text: string): Promise<void> => {
                const { text: plainText, entities } =
                    markdownToEntitiesTelegram(convertTablesToCards(text));
                const chunks = splitTelegramEntities(plainText, entities, 4096);
                for (const chunk of chunks) {
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        await ctx.reply(chunk.text, { entities: toGrammyEntities(chunk.entities) as any });
                    } catch {
                        await ctx.reply(chunk.text);
                    }
                }
            };

            // Wrap sendFn to auto-screenshot after each Copilot response if enabled
            const finalSendFn = config.autoScreenshotAfterAgent
                ? async (text: string): Promise<void> => {
                    await sendFn(text);
                    try {
                        const buffer = await captureScreenshot();
                        const caption = `📸 ${config.instanceName} — ${new Date().toLocaleString()}`;
                        await ctx.replyWithPhoto(new InputFile(buffer, 'screenshot.png'), { caption });
                    } catch { /* never interrupt the main flow */ }
                }
                : sendFn;

            // Cancel any previous monitor and start a new one (fire-and-forget)
            monitor.cancel();
            void monitor.start(question, finalSendFn, extractLastAssistantResponse);
            return;
        }

        // ── Mode 2: @remoteclaw participant (panel mode) ───────────────────────
        if (!config.silentMode) {
            // Open chat with @remoteclaw so the participant handles BOTH the panel AND
            // the Telegram response via telegramSendCallback. Do NOT also call
            // askQuestion() — that would send a separate, conflicting response.
            void vscode.commands.executeCommand('workbench.action.chat.open', {
                query: `@remoteclaw ${question}`,
            });
            return;
        }

        // ── Mode 3: Silent mode — no UI, call LM directly ─────────────────────
        let response: string;
        try {
            response = await copilotBridge.askQuestion(question);
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await ctx.reply(`❌ Copilot error: ${errMsg}`);
            return;
        }

        if (!response.trim()) {
            await ctx.reply('⚠️ Copilot returned an empty response.');
            return;
        }

        const { text: plainText, entities } =
            markdownToEntitiesTelegram(convertTablesToCards(response));
        const chunks = splitTelegramEntities(plainText, entities, 4096);
        for (const chunk of chunks) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await ctx.reply(chunk.text, { entities: toGrammyEntities(chunk.entities) as any });
            } catch {
                await ctx.reply(chunk.text);
            }
        }

        if (config.autoScreenshotAfterAgent) {
            try {
                const buffer = await captureScreenshot();
                const caption = `📸 ${config.instanceName} — ${new Date().toLocaleString()}`;
                await ctx.replyWithPhoto(new InputFile(buffer, 'screenshot.png'), { caption });
            } catch { /* never interrupt the main flow */ }
        }
    }

    // ── /agent <question> handler (reused by router and agent passthrough) ─────
    async function handleAgent(ctx: Context, args: string): Promise<void> {
        if (!await ensureAutoApprove(ctx)) { return; }

        const question = args.trim();
        if (!question) {
            await ctx.reply('Usage: ?agent <your question>');
            return;
        }

        lastQuestion.set(ctx.chat?.id ?? 0, question);
        await executeAsk(ctx, question);
    }

    // ── ?agent_on handler — enables agent-passthrough mode ────────────────────
    async function handleAgentOn(ctx: Context): Promise<void> {
        await context.globalState.update('remoteclaw.agentModeEnabled', true);
        agentModeEnabled = true;
        await ctx.reply('🤖 Agent mode ON — all your messages will be sent to Copilot.\nType ?agent_off to disable.');
    }

    // ── ?agent_off handler — disables agent-passthrough mode ──────────────────
    async function handleAgentOff(ctx: Context): Promise<void> {
        await context.globalState.update('remoteclaw.agentModeEnabled', false);
        agentModeEnabled = false;
        await ctx.reply('✅ Agent mode OFF — returning to manual command mode.');
    }

    // ── buildHelpText — generates the sectioned ? help menu ───────────────────
    function buildHelpText(): string {
        const lines: string[] = [
            `🦞 *Remote Claw — Available Commands*`,
            '',
            '*Copilot*',
            '?agent <question> — Ask GitHub Copilot (agent loop)',
            '?agent\\_on — Enable auto-agent mode (all text → Copilot)',
            '?agent\\_off — Disable auto-agent mode',
        ];

        if (config.enableTerminal) {
            lines.push('');
            lines.push('*Terminal*');
            lines.push('?run <command> — Execute a terminal command');
            lines.push('?stop — Stop the running command');
        }

        lines.push('');
        lines.push('*Workspace*');
        lines.push('?file <path> — Get the contents of a file');
        lines.push('?diff — Show the current git diff');
        lines.push('?git <args> — Run a git command');
        lines.push('?errors — Show current errors and diagnostics');
        lines.push('?open <file> — Open a file in the editor');
        lines.push('?status — Show VS Code status');

        const otherLines: string[] = [];
        if (config.enableScreenshots) {
            otherLines.push('?screenshot — Take a screenshot');
        }
        otherLines.push('?help (or ?) — Show this menu');
        if (config.enablePIN) {
            otherLines.push('?pin — Authenticate with PIN');
        }

        lines.push('');
        lines.push('*Other*');
        lines.push(...otherLines);

        return lines.join('\n');
    }

    // ── ?help handler ─────────────────────────────────────────────────────────
    async function handleHelp(ctx: Context): Promise<void> {
        await ctx.reply(buildHelpText(), { parse_mode: 'Markdown' });
    }

    // ── maybeSendDailyHelp — shows help once per calendar day ─────────────────
    function getTodayDate(): string {
        return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local timezone
    }

    async function maybeSendDailyHelp(ctx: Context): Promise<void> {
        const lastDate = context.globalState.get<string>('remoteclaw.lastHelpDate', '');
        const today = getTodayDate();
        if (lastDate !== today) {
            // On the very first run (no stored date), announce agent mode is ON
            // before the help menu so the user knows what state they are in.
            if (!lastDate) {
                await ctx.reply('🤖 Agent mode ON — all your messages will be sent to Copilot.\nType ?agent_off to disable.');
            }
            await ctx.reply(buildHelpText(), { parse_mode: 'Markdown' });
            await context.globalState.update('remoteclaw.lastHelpDate', today);
        }
    }

    // ── T3.2 — Terminal command handlers ──────────────────────────────────────

    async function handleRun(ctx: Context, args: string): Promise<void> {
        if (!config.enableTerminal) {
            await ctx.reply('⛔ Terminal commands are disabled in settings.');
            return;
        }
        const cmd = args.trim();
        if (!cmd) {
            await ctx.reply('Usage: ?run <command>');
            return;
        }

        const verdict = terminalBridge.classifyCommand(cmd);

        if (verdict === 'deny') {
            await ctx.reply(`🚫 Command blocked by security policy: \`${cmd}\``);
            return;
        }

        if (verdict === 'confirm') {
            const keyboard = new InlineKeyboard()
                .text('✅ Yes, run it', `run_confirm:${cmd}`)
                .text('❌ Cancel', 'run_cancel');
            await ctx.reply(`⚠️ Potentially destructive command:\n\`${cmd}\`\n\nRun it?`, { reply_markup: keyboard });
            return;
        }

        await ctx.reply(`⚙️ Running: \`${cmd}\`\`\`\``);
        const output = await terminalBridge.runCommand(cmd);
        await ctx.reply(`\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
    }

    async function handleStop(ctx: Context): Promise<void> {
        terminalBridge.stop();
        await ctx.reply('⏹ Process stopped.');
    }

    async function handleFile(ctx: Context, args: string): Promise<void> {
        const filePath = args.trim();
        if (!filePath) {
            await ctx.reply('Usage: ?file <path>');
            return;
        }
        try {
            const content = await terminalBridge.readFile(filePath);
            await ctx.reply(`\`\`\`\n${content}\n\`\`\``, { parse_mode: 'Markdown' });
        } catch (err) {
            await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    async function handleDiff(ctx: Context): Promise<void> {
        const diff = await terminalBridge.getGitDiff();
        await ctx.reply(`\`\`\`diff\n${diff}\n\`\`\``, { parse_mode: 'Markdown' });
    }

    async function handleGit(ctx: Context, args: string): Promise<void> {
        if (!args.trim()) {
            await ctx.reply('Usage: ?git <args>  e.g. ?git status');
            return;
        }
        const output = await terminalBridge.runGit(args);
        await ctx.reply(`\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
    }

    async function handleStatus(ctx: Context): Promise<void> {
        const status = await terminalBridge.getStatus();
        await ctx.reply(status);
    }

    async function handleErrors(ctx: Context): Promise<void> {
        const errors = await terminalBridge.getErrors();
        await ctx.reply(errors);
    }

    async function handleOpen(ctx: Context, args: string): Promise<void> {
        const filePath = args.trim();
        if (!filePath) {
            await ctx.reply('Usage: ?open <path>');
            return;
        }
        try {
            await terminalBridge.openFile(filePath);
            await ctx.reply(`📂 Opened: ${filePath}`);
        } catch (err) {
            await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // ── T3.2.10 — Destructive command confirmation callbacks ──────────────────

    bot.callbackQuery(/^run_confirm:(.+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const cmd = ctx.match[1];
        await ctx.reply(`⚙️ Running: \`${cmd}\``);
        const output = await terminalBridge.runCommand(cmd);
        await ctx.reply(`\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
    });

    bot.callbackQuery('run_cancel', async (ctx) => {
        await ctx.answerCallbackQuery({ text: 'Cancelled.' });
        await ctx.reply('❌ Command cancelled.');
    });

    // ── T2.6 Callback: 📸 Screenshot ──────────────────────────────────────────
    bot.callbackQuery('screenshot', async (ctx) => {
        const senderId = ctx.from?.id?.toString();
        const ownerId = await secretsManager.getOwnerId();
        if (!ownerId || senderId !== ownerId) {
            await ctx.answerCallbackQuery({ text: '⛔ Unauthorized' });
            return;
        }
        await ctx.answerCallbackQuery();
        await handleScreenshot(ctx, config);
    });

    // ── Auto-approve callbacks ─────────────────────────────────────────────────
    bot.callbackQuery('autoApprove_yes', async (ctx) => {
        await ctx.answerCallbackQuery();
        try {
            await vscode.workspace.getConfiguration().update(
                'chat.tools.terminal.ignoreDefaultAutoApproveRules',
                true,
                vscode.ConfigurationTarget.Workspace,
            );
            console.log('[RemoteClaw] chat.tools.terminal.ignoreDefaultAutoApproveRules written to workspace settings.');
            await ctx.reply('✅ Terminal auto-approve enabled for this workspace (.vscode/settings.json). You can now send commands.');
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[RemoteClaw] Failed to write workspace setting:', errMsg);
            await ctx.reply(`❌ Failed (workspace-scoped write rejected): ${errMsg}`);
        }
    });

    bot.callbackQuery('autoApprove_no', async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.reply(
            '🚫 This extension cannot function properly unless auto-approvals are enabled. ' +
            'If you\'d like to enable them, please send another message.',
        );
    });

    // ── Dispatch map: keyword → handler ───────────────────────────────────────
    // All commands reachable via the ? prefix are registered here.
    type HandlerFn = (ctx: Context, args: string) => Promise<void>;

    const dispatch: Record<string, HandlerFn> = {
        'agent':     (ctx, args) => handleAgent(ctx, args),
        'agent_on':  (ctx)       => handleAgentOn(ctx),
        'agent_off': (ctx)       => handleAgentOff(ctx),
        'help':      (ctx)       => handleHelp(ctx),
        'screenshot':(ctx)       => handleScreenshot(ctx, config),
        'run':    (ctx, args) => handleRun(ctx, args),
        'stop':   (ctx)       => handleStop(ctx),
        'file':   (ctx, args) => handleFile(ctx, args),
        'diff':   (ctx)       => handleDiff(ctx),
        'git':    (ctx, args) => handleGit(ctx, args),
        'status': (ctx)       => handleStatus(ctx),
        'errors': (ctx)       => handleErrors(ctx),
        'open':   (ctx, args) => handleOpen(ctx, args),
        'pin':    async (ctx) => { await ctx.reply('🔐 /pin not yet implemented.'); },
    };

    // ── Single message:text entry point — the ? prefix router ─────────────────
    bot.on('message:text', async (ctx) => {
        // Step 1: trim leading whitespace (FR-1)
        const raw = ctx.message.text ?? '';
        const text = raw.trimStart();

        // Step 2: show help on first message of each calendar day (FR-4)
        await maybeSendDailyHelp(ctx);

        // Step 3: ? prefix branch
        if (text.startsWith('?')) {
            // ? alone → help (FR-2)
            if (text === '?') {
                await handleHelp(ctx);
                return;
            }

            // Parse: ?<keyword> <args>
            const withoutPrefix = text.slice(1);                       // e.g. "agent hello world"
            const spaceIdx = withoutPrefix.indexOf(' ');
            const keyword = (spaceIdx === -1
                ? withoutPrefix
                : withoutPrefix.slice(0, spaceIdx)
            ).toLowerCase();
            const args = spaceIdx === -1 ? '' : withoutPrefix.slice(spaceIdx + 1);

            const handler = dispatch[keyword];
            if (handler) {
                await handler(ctx, args);
            } else {
                // Unknown ? command (FR-3)
                await ctx.reply('❓ Unknown command. Type ? for help.');
            }
            return;
        }

        // Step 4: plain text — agent passthrough (FR-8)
        if (agentModeEnabled) {
            await executeAsk(ctx, text);
        }
        // If agent mode is OFF and no ? prefix → silently ignore
    });

    return monitor;
}
