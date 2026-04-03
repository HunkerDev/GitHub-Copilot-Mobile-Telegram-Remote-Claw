import { Bot, BotError, Context, Middleware } from 'grammy';
import { RemoteClawStatusBar } from '../ui/statusBar';

type VoidCallback = () => void;
type ErrorCallback = (err: Error) => void;

const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS     = 300_000; // 5 minutes

export class TelegramBot {
    private readonly bot: Bot<Context>;
    private readonly connectedCallbacks: VoidCallback[] = [];
    private readonly disconnectedCallbacks: VoidCallback[] = [];
    private readonly errorCallbacks: ErrorCallback[] = [];
    private running = false;
    private statusBar: RemoteClawStatusBar | undefined;
    private backoffDelay = BACKOFF_INITIAL_MS;
    paused = false;

    constructor(token: string, middleware: Middleware<Context>) {
        this.bot = new Bot<Context>(token);
        this.bot.use(middleware);

        this.bot.catch((err: BotError<Context>) => {
            const inner = err.error;
            // Grammy's 30-second long-poll timeout is expected — ignore it
            if (inner instanceof Error && inner.message.toLowerCase().includes('timeout')) {
                return;
            }
            const error = inner instanceof Error ? inner : new Error(String(inner));
            this.errorCallbacks.forEach(cb => cb(error));
        });
    }

    /** Inject the status bar after construction (avoids circular dependency). */
    setStatusBar(statusBar: RemoteClawStatusBar): void {
        this.statusBar = statusBar;
    }

    start(): void {
        if (this.running) {
            return;
        }
        this.running = true;
        this.backoffDelay = BACKOFF_INITIAL_MS;
        void this.startPolling();
    }

    /**
     * Drives the polling loop with exponential backoff on failure.
     * Delay sequence: 5 s → 10 s → 20 s → … → 300 s (capped).
     * Resets to 5 s after every successful (re)connect.
     */
    private async startPolling(): Promise<void> {
        while (this.running) {
            try {
                await this.bot.start({
                    onStart: (_botInfo) => {
                        // Successful connect — reset backoff
                        this.backoffDelay = BACKOFF_INITIAL_MS;
                        this.connectedCallbacks.forEach(cb => cb());
                    },
                });
                // Resolved normally — bot.stop() was called intentionally
                return;
            } catch (err: unknown) {
                if (!this.running) {
                    return; // stop() was called while we were in start()
                }

                const error = err instanceof Error ? err : new Error(String(err));
                this.errorCallbacks.forEach(cb => cb(error));

                this.statusBar?.setReconnecting();

                await this.sleep(this.backoffDelay);

                if (!this.running) {
                    return; // stop() arrived during the sleep
                }

                // Double the delay, capped at BACKOFF_MAX_MS
                this.backoffDelay = Math.min(this.backoffDelay * 2, BACKOFF_MAX_MS);
            }
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async stop(): Promise<void> {
        if (!this.running) {
            return;
        }
        this.running = false;
        await this.bot.stop();
        this.disconnectedCallbacks.forEach(cb => cb());
    }

    pause(): void {
        this.paused = true;
    }

    resume(): void {
        this.paused = false;
    }

    onConnected(cb: VoidCallback): void {
        this.connectedCallbacks.push(cb);
    }

    onDisconnected(cb: VoidCallback): void {
        this.disconnectedCallbacks.push(cb);
    }

    onError(cb: ErrorCallback): void {
        this.errorCallbacks.push(cb);
    }

    getBot(): Bot<Context> {
        return this.bot;
    }

    /**
     * Send a text message to any Telegram chat (typically the owner's chat ID).
     * Telegram allows up to 4096 chars per message; callers are responsible for
     * splitting longer texts (see formatter.ts, T2.4).
     */
    async sendMessage(chatId: number, text: string): Promise<void> {
        await this.bot.api.sendMessage(chatId, text);
    }
}

