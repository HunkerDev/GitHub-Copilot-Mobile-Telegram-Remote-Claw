import * as vscode from 'vscode';
import { Composer, Context } from 'grammy';
import { SecretsManager, getConfig } from './config/settings';
import { RemoteClawStatusBar } from './ui/statusBar';
import { showSetupWizard } from './ui/setupWizard';
import { TelegramBot } from './bot/telegramBot';
import { createAuthMiddleware, createRateLimiterMiddleware } from './bot/middleware';
import { createCopilotBridge, CopilotBridge } from './bridge/copilotBridge';
import { registerCommands } from './bot/commands';
import { TerminalBridge } from './bridge/terminalBridge';

// Module-level reference to support graceful shutdown in deactivate()
let telegramBot: TelegramBot | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // 1. Instantiate SecretsManager
    const secretsManager = new SecretsManager(context);

    // 2. Instantiate status bar and show connecting state immediately
    const statusBar = new RemoteClawStatusBar();
    statusBar.setConnecting();
    context.subscriptions.push({ dispose: () => statusBar.dispose() });

    // 3. Check whether credentials are already stored
    let [botToken, ownerId] = await Promise.all([
        secretsManager.getBotToken(),
        secretsManager.getOwnerId(),
    ]);

    // 4. First-run path — launch setup wizard, then continue activation
    if (!botToken || !ownerId) {
        await showSetupWizard(context, secretsManager);
        // Re-read secrets after wizard completes
        botToken = await secretsManager.getBotToken();
        ownerId = await secretsManager.getOwnerId();
        // If still missing (user closed wizard without finishing), bail out
        if (!botToken || !ownerId) {
            statusBar.setDisconnected();
            return;
        }
    }

    // 5. Build composed middleware: auth → rate limiter
    const config = getConfig();
    const composer = new Composer<Context>();
    composer.use(createAuthMiddleware(secretsManager));
    composer.use(createRateLimiterMiddleware(config));

    // Instantiate bot with the composed middleware
    telegramBot = new TelegramBot(botToken, composer);

    // 7. Inject status bar
    telegramBot.setStatusBar(statusBar);

    // 8. Wire lifecycle events
    telegramBot.onConnected(() => statusBar.setConnected());
    telegramBot.onDisconnected(() => statusBar.setDisconnected());
    telegramBot.onError(() => statusBar.setDisconnected());

    // 9. Register VS Code commands (stubs — full implementations in later tasks)
    const startCmd = vscode.commands.registerCommand('remclaw.start', () => {
        telegramBot?.start();
    });

    const stopCmd = vscode.commands.registerCommand('remclaw.stop', async () => {
        await telegramBot?.stop();
    });

    const resetCmd = vscode.commands.registerCommand('remclaw.reset', async () => {
        await telegramBot?.stop();
        await secretsManager.deleteAll();
        await showSetupWizard(context, secretsManager);
    });

    const reconnectCmd = vscode.commands.registerCommand('remclaw.reconnect', async () => {
        await telegramBot?.stop();
        telegramBot?.start();
    });

    const changeUserCmd = vscode.commands.registerCommand('remclaw.changeUser', async () => {
        await secretsManager.deleteOwnerId();
        await showSetupWizard(context, secretsManager);
    });

    const openSettingsCmd = vscode.commands.registerCommand('remclaw.openSettings', () => {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'telegramCopilot');
    });

    const openStatusMenuCmd = vscode.commands.registerCommand('remclaw.openStatusMenu', () => {
        void vscode.window.showQuickPick(
            [
                { label: '$(debug-start) Start bot',    id: 'start' },
                { label: '$(debug-stop) Stop bot',      id: 'stop' },
                { label: '$(refresh) Reconnect',        id: 'reconnect' },
                { label: '$(person) Change User',       id: 'changeUser' },
                { label: '$(settings-gear) Settings',   id: 'settings' },
                { label: '$(trash) Full Reset',         id: 'reset' },
            ],
            { placeHolder: '🦞 Remote Claw — Options' },
        ).then(selection => {
            if (!selection) { return; }
            void vscode.commands.executeCommand(`remclaw.${selection.id}`);
        });
    });

    // 10. Instantiate CopilotBridge for direct LM access
    const copilotBridge = new CopilotBridge();

    // 10a. Register @remoteclaw chat participant (T2.1 / T2.2)
    const chatParticipant = createCopilotBridge(async (text: string) => {
        const ownerIdStr = await secretsManager.getOwnerId();
        if (ownerIdStr && telegramBot) {
            await telegramBot.sendMessage(Number(ownerIdStr), text);
        }
    });

    // 10b. Wire Telegram command handlers (?agent, ?help, etc.)
    const terminalBridge = new TerminalBridge(config);
    const chatMonitor = registerCommands(telegramBot.getBot(), copilotBridge, config, secretsManager, context, terminalBridge);

    // 11. NotificationWatcher — not yet implemented (T5.x), skip for now

    // 12. Start the bot
    telegramBot.start();

    
    // 13. Push all disposables
    context.subscriptions.push(
        startCmd,
        stopCmd,
        resetCmd,
        reconnectCmd,
        changeUserCmd,
        openSettingsCmd,
        openStatusMenuCmd,
        chatParticipant,
        { dispose: () => chatMonitor.dispose() },
    );
}

export async function deactivate(): Promise<void> {
    await telegramBot?.stop();
}
