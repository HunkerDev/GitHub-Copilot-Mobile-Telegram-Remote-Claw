import * as vscode from 'vscode';

// ---------- Types ----------

export type MessageFormat = 'markdown' | 'html';

export interface TelegramCopilotConfig {
    instanceName: string;
    enableTerminal: boolean;
    enableScreenshots: boolean;
    confirmDestructive: boolean;
    commandAllowlist: string[];
    commandDenylist: string[];
    notifyOnBuildComplete: boolean;
    notifyOnTestComplete: boolean;
    notifyOnLongTask: boolean;
    longTaskThresholdSeconds: number;
    terminalOutputMaxLines: number;
    conversationHistoryCount: number;
    messageFormat: MessageFormat;
    autoScreenshotAfterAgent: boolean;
    rateLimitPerMinute: number;
    enablePIN: boolean;
    /** FR-14 — when true, /ask answers without opening the VS Code Chat panel UI. */
    silentMode: boolean;
    /**
     * When true, /ask opens the native VS Code Chat panel (no @remoteclaw participant)
     * and captures the response by polling the clipboard via
     * workbench.action.chat.copyLastResponseToClipboard.
     * Takes precedence over silentMode when both are true.
     */
    nativeChatCapture: boolean;
    /** Maximum seconds to wait for the native chat response before timing out. */
    nativeChatCaptureTimeoutSeconds: number;
    /** Minutes of inactivity (no Telegram sends) before the chat monitor stops automatically. */
    nativeChatMonitorInactivityMinutes: number;
}

// ---------- Settings Accessor (T1.1) ----------

export function getConfig(): TelegramCopilotConfig {
    const cfg = vscode.workspace.getConfiguration('telegramCopilot');
    return {
        instanceName:              cfg.get<string>('instanceName', 'VS Code'),
        enableTerminal:            cfg.get<boolean>('enableTerminal', true),
        enableScreenshots:         cfg.get<boolean>('enableScreenshots', true),
        confirmDestructive:        cfg.get<boolean>('confirmDestructive', true),
        commandAllowlist:          cfg.get<string[]>('commandAllowlist', []),
        commandDenylist:           cfg.get<string[]>('commandDenylist', [
            'rm -rf', 'del /f', 'format', 'DROP TABLE', ':(){:|:&};:',
        ]),
        notifyOnBuildComplete:     cfg.get<boolean>('notifyOnBuildComplete', true),
        notifyOnTestComplete:      cfg.get<boolean>('notifyOnTestComplete', true),
        notifyOnLongTask:          cfg.get<boolean>('notifyOnLongTask', true),
        longTaskThresholdSeconds:  cfg.get<number>('longTaskThresholdSeconds', 30),
        terminalOutputMaxLines:    cfg.get<number>('terminalOutputMaxLines', 100),
        conversationHistoryCount:  cfg.get<number>('conversationHistoryCount', 20),
        messageFormat:             cfg.get<MessageFormat>('messageFormat', 'markdown'),
        autoScreenshotAfterAgent:  cfg.get<boolean>('autoScreenshotAfterAgent', false),
        rateLimitPerMinute:             cfg.get<number>('rateLimitPerMinute', 20),
        enablePIN:                        cfg.get<boolean>('enablePIN', false),
        silentMode:                       cfg.get<boolean>('silentMode', false),
        nativeChatCapture:                cfg.get<boolean>('nativeChatCapture', true),
        nativeChatCaptureTimeoutSeconds:  cfg.get<number>('nativeChatCaptureTimeoutSeconds', 90),
        nativeChatMonitorInactivityMinutes: cfg.get<number>('nativeChatMonitorInactivityMinutes', 10),
    };
}

/**
 * Subscribe to `telegramCopilot.*` setting changes.
 * The listener is called with the freshly-read config whenever any
 * `telegramCopilot.*` key changes in the workspace or user settings.
 *
 * @returns A `vscode.Disposable` — add it to `context.subscriptions`.
 */
export function onDidChangeConfiguration(
    listener: (config: TelegramCopilotConfig) => void,
): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('telegramCopilot')) {
            listener(getConfig());
        }
    });
}

// ---------- SecretStorage Keys ----------

const SECRET_KEYS = {
    botToken: 'remoteclaw.botToken',
    ownerId:  'remoteclaw.ownerId',
    pin:      'remoteclaw.pin',
} as const;

// ---------- SecretsManager (T1.2) ----------

/**
 * Wraps VS Code SecretStorage for the three sensitive Remote Claw credentials.
 * Secret values are NEVER passed to logs, output channels, or error messages.
 */
export class SecretsManager {
    private readonly secrets: vscode.SecretStorage;

    constructor(context: vscode.ExtensionContext) {
        this.secrets = context.secrets;
    }

    // --- Bot Token ---

    async storeBotToken(value: string): Promise<void> {
        await this.secrets.store(SECRET_KEYS.botToken, value);
    }

    async getBotToken(): Promise<string | undefined> {
        return this.secrets.get(SECRET_KEYS.botToken);
    }

    async deleteBotToken(): Promise<void> {
        await this.secrets.delete(SECRET_KEYS.botToken);
    }

    // --- Owner ID ---

    async storeOwnerId(value: string): Promise<void> {
        await this.secrets.store(SECRET_KEYS.ownerId, value);
    }

    async getOwnerId(): Promise<string | undefined> {
        return this.secrets.get(SECRET_KEYS.ownerId);
    }

    async deleteOwnerId(): Promise<void> {
        await this.secrets.delete(SECRET_KEYS.ownerId);
    }

    // --- PIN ---

    async storePin(value: string): Promise<void> {
        await this.secrets.store(SECRET_KEYS.pin, value);
    }

    async getPin(): Promise<string | undefined> {
        return this.secrets.get(SECRET_KEYS.pin);
    }

    async deletePin(): Promise<void> {
        await this.secrets.delete(SECRET_KEYS.pin);
    }

    // --- Bulk delete (Full Reset) ---

    async deleteAll(): Promise<void> {
        await this.secrets.delete(SECRET_KEYS.botToken);
        await this.secrets.delete(SECRET_KEYS.ownerId);
        await this.secrets.delete(SECRET_KEYS.pin);
    }
}
