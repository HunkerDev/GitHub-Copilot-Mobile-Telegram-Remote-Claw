import * as vscode from 'vscode';
import { TelegramCopilotConfig } from '../config/settings';

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * ChatMonitor — Persistent Differential Clipboard Monitor
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * This module implements a background polling mechanism that bridges the
 * VS Code native Chat panel and Telegram. Because the VS Code Chat panel
 * does not expose a streaming API for reading assistant responses, this class
 * works around the limitation by:
 *
 *   1. Opening the Chat panel and submitting a question.
 *   2. Periodically copying the full Chat transcript to the clipboard
 *      (`workbench.action.chat.copyAll`).
 *   3. Detecting when the response has stabilised (stopped changing).
 *   4. Extracting new content and forwarding it to Telegram via a callback.
 *
 * Key design decisions & functional requirements (FR) references:
 *
 *   • FR-3  — Stability detection: the clipboard must remain identical for
 *             2 consecutive polls (≈2 s) AND contain a Copilot marker before
 *             the content is considered "done".
 *   • FR-5  — First send: when no previous content has been sent, the full
 *             extracted response is forwarded to Telegram.
 *   • FR-6  — Diff send: on subsequent stable reads, only new lines (or a
 *             full resend if a new Copilot turn appeared) are forwarded.
 *   • FR-7  — Anti-flood: a minimum 10-second gap is enforced between sends.
 *   • FR-10 — Resilience: the polling loop never stops due to empty clipboard
 *             or `copyAll` failures; it simply retries on the next cycle.
 *
 * Lifecycle:
 *   - `start(question, sendFn, extractFn)` — fire-and-forget; runs until
 *     cancelled or the inactivity timeout expires.
 *   - `cancel()` / `dispose()` — stops the polling loop and clears timers.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/** Interval in milliseconds between clipboard polls. */
const POLL_MS = 1_000;

export class ChatMonitor {
    // ── Instance state ───────────────────────────────────────────────────────

    /** Flag that signals the polling loop to exit on the next iteration. */
    private isCancelled = false;

    /** Flag that pauses clipboard polling without cancelling the loop. */
    private isPaused = false;

    /** The last content successfully sent to Telegram. Used for diffing. */
    private lastSentContent = '';

    /** Unix-ms timestamp of the last successful send (for anti-flood). */
    private lastSentAt = 0;

    /**
     * Handle for the inactivity timer. After each successful send the timer
     * is reset; if it fires before the next send, the monitor self-cancels.
     */
    private inactivityTimerId: ReturnType<typeof setTimeout> | undefined;

    /** Read-only snapshot of the extension settings at construction time. */
    private readonly config: TelegramCopilotConfig;

    // ── Constructor ──────────────────────────────────────────────────────────

    /**
     * @param config  Extension configuration snapshot. The relevant field is
     *                `nativeChatMonitorInactivityMinutes` which controls how
     *                long the monitor waits without a send before auto-stopping.
     */
    constructor(config: TelegramCopilotConfig) {
        this.config = config;
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /**
     * Starts a background polling loop that watches the VS Code Chat panel clipboard,
     * detects stable responses, and sends new content to Telegram via `sendFn`.
     *
     * Fire-and-forget: the caller should `void monitor.start(...)` and return immediately.
     *
     * @param question  The question that was sent to the Chat panel.
     * @param sendFn    Async function that delivers a text string to Telegram.
     * @param extractFn Function that extracts the last assistant response from a full transcript.
     */
    async start(
        question: string,
        sendFn: (text: string) => Promise<void>,
        extractFn: (transcript: string) => string,
    ): Promise<void> {
        // Reset all internal state so the same ChatMonitor instance can be reused.
        this.isCancelled = false;
        this.lastSentContent = '';
        this.lastSentAt = 0;
        this._clearInactivityTimer();

        console.log(`[RemoteClaw] Monitor: started — question="${question.slice(0, 80)}"`);

        // ── Step 1: Open the VS Code Chat panel ──────────────────────────────
        // The `workbench.action.chat.open` command opens the native Chat panel
        // and pre-fills the input box with `question`. Copilot will begin
        // generating a response immediately.
        try {
            await vscode.commands.executeCommand('workbench.action.chat.open', { query: question });
        } catch (err) {
            console.error('[RemoteClaw] Monitor: error opening chat panel', err);
        }

        // ── Step 2: Enter the polling loop ───────────────────────────────────
        // `prevClip` holds the clipboard text from the previous poll cycle.
        // `stableCount` tracks how many consecutive polls returned the exact
        // same clipboard content, used for stability detection (FR-3).
        let prevClip = '';
        let stableCount = 0;

        while (!this.isCancelled) {
            // Wait one polling interval before reading the clipboard.
            await this._sleep(POLL_MS);
            if (this.isCancelled) { break; }

            // If paused, skip all processing and wait for resume.
            if (this.isPaused) { continue; }

            // ── 2a. Copy the full Chat transcript to the clipboard ───────────
            // VS Code's `chat.copyAll` writes the entire conversation (all
            // user + assistant turns) to the system clipboard as plain text.
            let currentClip = '';
            try {
                await vscode.commands.executeCommand('workbench.action.chat.copyAll');
                currentClip = await vscode.env.clipboard.readText() ?? '';
            } catch (err) {
                console.error('[RemoteClaw] Monitor: error during poll', err);
                // FR-10: keep polling even if copyAll fails — the Chat panel
                // may have been temporarily closed or the command could have
                // thrown for an unrelated reason.
                continue;
            }

            // FR-10: an empty clipboard just means the Chat panel hasn't
            // produced any visible text yet. Keep waiting.
            if (!currentClip.trim()) {
                continue;
            }

            // ── 2b. Stability detection (FR-3) ──────────────────────────────
            // We only consider a response "stable" once:
            //   a) The clipboard contains a Copilot marker ("GitHub Copilot:"
            //      or "Assistant:"), confirming an assistant turn exists.
            //   b) The clipboard text has been identical for 2 consecutive
            //      polls (≈6 seconds), meaning the model stopped streaming.
            const hasMarker = currentClip.includes('GitHub Copilot:') || currentClip.includes('Assistant:');

            if (!hasMarker) {
                // No assistant response yet — reset and keep polling.
                prevClip = currentClip;
                stableCount = 0;
                continue;
            }

            if (currentClip === prevClip) {
                // Content unchanged from last poll — increment stability counter.
                stableCount++;
                if (stableCount >= 2) {
                    // Stable for 2 consecutive polls → the model has stopped.
                    console.log('[RemoteClaw] Monitor: stable-detected');

                    // Attempt to extract and send new content to Telegram.
                    await this._onStable(currentClip, sendFn, extractFn);

                    // Reset stability counter so future changes are detected.
                    stableCount = 0;
                }
            } else {
                // Content changed — response is still streaming.
                stableCount = 0;
            }

            prevClip = currentClip;
        }

        console.log('[RemoteClaw] Monitor: polling loop exited');
    }

    /**
     * Cancels the current monitor. Stops the polling loop on the next cycle
     * and clears the inactivity timer. Safe to call multiple times.
     */
    cancel(): void {
        if (!this.isCancelled) {
            this.isCancelled = true;
            this._clearInactivityTimer();
            console.log('[RemoteClaw] Monitor: cancelled');
        }
    }

    /**
     * Pauses clipboard polling. The loop keeps running but skips all copyAll
     * and processing logic until `resume()` is called. Clears the inactivity
     * timer so it does not fire while the extension is paused.
     */
    pause(): void {
        if (!this.isPaused) {
            this.isPaused = true;
            this._clearInactivityTimer();
            console.log('[RemoteClaw] Monitor: paused');
        }
    }

    /**
     * Resumes clipboard polling after a `pause()`. Restores the inactivity
     * timer so the auto-cancel deadline picks up again.
     */
    resume(): void {
        if (this.isPaused) {
            this.isPaused = false;
            this._resetInactivityTimer();
            console.log('[RemoteClaw] Monitor: resumed');
        }
    }

    /**
     * Disposes the monitor. Delegates to `cancel()`. Safe to call multiple times.
     * Exists so `ChatMonitor` conforms to VS Code's Disposable convention.
     */
    dispose(): void {
        this.cancel();
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /**
     * Called when the clipboard content is deemed stable (unchanged for 2
     * consecutive polls). Decides whether to send the full response, a diff,
     * or nothing at all to Telegram.
     *
     * @param transcript  The full clipboard text (entire Chat panel transcript).
     * @param sendFn      Callback to deliver text to Telegram.
     * @param extractFn   Extracts only the last assistant response from the
     *                    full transcript (strips user turns and old responses).
     */
    private async _onStable(
        transcript: string,
        sendFn: (text: string) => Promise<void>,
        extractFn: (transcript: string) => string,
    ): Promise<void> {
        // Extract the relevant assistant response from the raw transcript.
        let currentResponse: string;
        try {
            currentResponse = extractFn(transcript);
        } catch (err) {
            console.error('[RemoteClaw] Monitor: error in extractFn', err);
            return;
        }

        // Nothing meaningful to send — skip silently.
        if (!currentResponse.trim()) {
            return;
        }

        // ── Anti-flood guard (FR-7) ──────────────────────────────────────────
        // Enforces a minimum 10-second gap between consecutive sends to avoid
        // spamming the Telegram chat with rapid incremental updates.
        const now = Date.now();
        if (now - this.lastSentAt < 10_000) {
            return; // Too soon — skip this cycle, check again next poll
        }

        // ── First send (FR-5) ────────────────────────────────────────────────
        // If we haven't sent anything yet for this monitoring session, send the
        // full extracted response as-is.
        if (!this.lastSentContent) {
            await this._send(currentResponse, sendFn, 'sent');
            return;
        }

        // ── Diff send (FR-6) ─────────────────────────────────────────────────
        // We already sent something earlier. Determine what's new:
    

        // Case B — Same Copilot turn but with additional lines appended.
        //          Compute a simple line-level diff and send only the new lines.
        const lastLines    = this.lastSentContent.split('\n');
        const currentLines = currentResponse.split('\n');
        const newLines     = currentLines.filter(line => !lastLines.includes(line));

        if (newLines.length === 0) {
            return; // Nothing new — the content is identical
        }

        await this._send(newLines.join('\n'), sendFn, 'diff-sent');
    }

    /**
     * Delivers `text` to Telegram via `sendFn`, updates bookkeeping state
     * (`lastSentContent`, `lastSentAt`), and resets the inactivity timer.
     *
     * @param text     The text payload to send.
     * @param sendFn   Callback that actually delivers the message to Telegram.
     * @param logState Label for the console log ('sent' = full, 'diff-sent' = incremental).
     */
    private async _send(
        text: string,
        sendFn: (text: string) => Promise<void>,
        logState: 'sent' | 'diff-sent',
    ): Promise<void> {
        try {
            // Update `lastSentContent`:
            //   - If this was a full send ('sent'), replace entirely.
            //   - If this was a diff send ('diff-sent'), append the new lines
            //     to the existing content so future diffs are computed correctly.
            this.lastSentContent = text === this.lastSentContent ? text :
                logState === 'diff-sent' ? this.lastSentContent + '\n' + text : text;

            await sendFn(text);

            
            // Record the send timestamp for the anti-flood guard.
            this.lastSentAt = Date.now();
            console.log(`[RemoteClaw] Monitor: ${logState}`);

            // Every successful send resets the inactivity timer, pushing the
            // auto-cancel deadline further into the future.
            this._resetInactivityTimer();
        } catch (err) {
            console.error('[RemoteClaw] Monitor: error', err);
        }
    }

    /**
     * Resets (restarts) the inactivity timer. If no successful send occurs
     * within `nativeChatMonitorInactivityMinutes` minutes, the monitor
     * self-cancels to avoid running indefinitely in the background.
     */
    private _resetInactivityTimer(): void {
        this._clearInactivityTimer();
        const ms = this.config.nativeChatMonitorInactivityMinutes * 60_000;
        this.inactivityTimerId = setTimeout(() => {
            console.log('[RemoteClaw] Monitor: idle-timeout');
            this.isCancelled = true;
        }, ms);
    }

    /**
     * Clears the inactivity timer if one is active. Safe to call when no
     * timer is set.
     */
    private _clearInactivityTimer(): void {
        if (this.inactivityTimerId !== undefined) {
            clearTimeout(this.inactivityTimerId);
            this.inactivityTimerId = undefined;
        }
    }

    /**
     * Returns a promise that resolves after `ms` milliseconds.
     * Used as a non-blocking sleep in the polling loop.
     */
    private _sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
