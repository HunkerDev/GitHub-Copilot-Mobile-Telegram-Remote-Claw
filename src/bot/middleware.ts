import { Context, Middleware, NextFunction } from 'grammy';
import { SecretsManager, TelegramCopilotConfig } from '../config/settings';

// ---------- T1.6 — Auth Middleware ----------

/**
 * Silently drops updates from any user whose Telegram ID does not match
 * the stored `remoteclaw.ownerId`.  No reply is sent; the stranger's ID
 * is never logged.
 */
export function createAuthMiddleware(secretsManager: SecretsManager): Middleware<Context> {
    return async (ctx: Context, next: NextFunction): Promise<void> => {
        const ownerId = await secretsManager.getOwnerId();
        if (!ownerId) {
            // No owner configured — drop everything until setup is complete
            return;
        }
        const senderId = ctx.from?.id?.toString();
        if (senderId !== ownerId) {
            return; // Silently drop — no reply, no logging of the stranger's ID
        }
        await next();
    };
}

// ---------- T1.7 — Rate Limiter Middleware ----------

interface SlidingWindow {
    timestamps: number[];
    cooldownUntil: number;
}

/**
 * Sliding-window rate limiter.  Rejects commands over
 * `config.rateLimitPerMinute` within any 60-second window.
 * On rejection a warning is sent and a cooldown is enforced.
 */
export function createRateLimiterMiddleware(config: TelegramCopilotConfig): Middleware<Context> {
    const windows = new Map<number, SlidingWindow>();

    return async (ctx: Context, next: NextFunction): Promise<void> => {
        const userId = ctx.from?.id;
        if (userId === undefined) {
            await next();
            return;
        }

        const now = Date.now();

        let win = windows.get(userId);
        if (!win) {
            win = { timestamps: [], cooldownUntil: 0 };
            windows.set(userId, win);
        }

        // Enforce active cooldown first
        if (now < win.cooldownUntil) {
            const remainingSec = Math.ceil((win.cooldownUntil - now) / 1_000);
            await ctx.reply(
                `⚠️ Rate limit exceeded. Please wait ${remainingSec}s before sending more commands.`
            );
            return;
        }

        // Slide the window — discard timestamps older than 60 seconds
        const windowStart = now - 60_000;
        win.timestamps = win.timestamps.filter(t => t > windowStart);

        // Check against the per-minute limit
        if (win.timestamps.length >= config.rateLimitPerMinute) {
            // Cooldown runs until the oldest timestamp in the window expires
            win.cooldownUntil = win.timestamps[0] + 60_000;
            const remainingSec = Math.ceil((win.cooldownUntil - now) / 1_000);
            await ctx.reply(
                `⚠️ Rate limit exceeded (${config.rateLimitPerMinute} commands/min). ` +
                `Please wait ${remainingSec}s.`
            );
            return;
        }

        win.timestamps.push(now);
        await next();
    };
}
