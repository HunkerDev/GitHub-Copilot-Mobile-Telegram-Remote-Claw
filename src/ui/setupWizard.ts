import * as vscode from 'vscode';
import { Bot } from 'grammy';
import { SecretsManager } from '../config/settings';

// Basic bot-token format: <8-12 digits>:<35-45 alphanumeric/hyphen/underscore chars>
const BOT_TOKEN_RE = /^\d{8,12}:[A-Za-z0-9_-]{35,45}$/;

// ─── Types ───────────────────────────────────────────────────────────────────

type WizardMessage =
    | { command: 'openBotFather' }
    | { command: 'submitToken'; token: string }
    | { command: 'retryOwnerCapture' }
    | { command: 'savePreferences'; prefs: PreferencePayload }
    | { command: 'finish' };

interface PreferencePayload {
    enableTerminal: boolean;
    enableScreenshots: boolean;
    enablePIN: boolean;
    notifyOnBuildComplete: boolean;
    notifyOnTestComplete: boolean;
    notifyOnLongTask: boolean;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Opens the 4-step setup wizard as a WebviewPanel.
 * Does nothing if both botToken and ownerId secrets are already stored.
 */
export async function showSetupWizard(
    context: vscode.ExtensionContext,
    secretsManager: SecretsManager,
): Promise<void> {
    console.log('[RemoteClaw] showSetupWizard() called.');
    const [token, ownerId] = await Promise.all([
        secretsManager.getBotToken(),
        secretsManager.getOwnerId(),
    ]);
    if (token && ownerId) {
        console.log('[RemoteClaw] Secrets already present — skipping wizard.');
        return; // Already configured — skip wizard
    }
    console.log('[RemoteClaw] Opening setup wizard panel (token present:', !!token, '| ownerId present:', !!ownerId, ').');

    const panel = vscode.window.createWebviewPanel(
        'remoteClawSetup',
        '🦞 Remote Claw — Setup Wizard',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
    );

    panel.webview.html = buildWizardHtml();

    let activeBot: Bot | undefined;
    let captureTimeout: ReturnType<typeof setTimeout> | undefined;

    const onBotReady = (bot: Bot, timeout: ReturnType<typeof setTimeout>): void => {
        activeBot = bot;
        captureTimeout = timeout;
    };

    panel.webview.onDidReceiveMessage(
        async (msg: WizardMessage) => {
            if (msg.command === 'openBotFather') {
                await vscode.env.openExternal(vscode.Uri.parse('https://t.me/BotFather'));
            } else if (msg.command === 'submitToken') {
                await handleSubmitToken(msg.token, panel, secretsManager, onBotReady);
            } else if (msg.command === 'retryOwnerCapture') {
                await handleRetryOwnerCapture(panel, secretsManager, onBotReady);
            } else if (msg.command === 'savePreferences') {
                await handleSavePreferences(msg.prefs, panel, secretsManager);
            } else if (msg.command === 'finish') {
                panel.dispose();
            }
        },
        undefined,
        context.subscriptions,
    );

    panel.onDidDispose(() => {
        if (captureTimeout !== undefined) {
            clearTimeout(captureTimeout);
        }
        void activeBot?.stop().catch(() => undefined);
    }, null, context.subscriptions);
}

// ─── Step 1 → 2: Bot token submission ────────────────────────────────────────

async function handleSubmitToken(
    rawToken: string,
    panel: vscode.WebviewPanel,
    secretsManager: SecretsManager,
    onBotReady: (bot: Bot, timeout: ReturnType<typeof setTimeout>) => void,
): Promise<void> {
    const token = rawToken.trim();

    if (!BOT_TOKEN_RE.test(token)) {
        panel.webview.postMessage({
            command: 'tokenError',
            error: 'Invalid token format. Paste the token exactly as provided by @BotFather.',
        });
        return;
    }

    // Verify token is valid by calling the Telegram API before storing it
    try {
        const me = await new Bot(token).api.getMe();
        console.log('[RemoteClaw] Token valid. Bot name:', me.first_name, '| username:', me.username);
    } catch (err) {
        console.error('[RemoteClaw] Token validation failed:', err);
        panel.webview.postMessage({
            command: 'tokenError',
            error: 'Unable to connect to Telegram. Check the token and your internet connection.',
        });
        return;
    }

    await secretsManager.storeBotToken(token);
    panel.webview.postMessage({ command: 'goStep', step: 2 });
    startOwnerCapture(token, panel, secretsManager, onBotReady);
}

// ─── Step 2 retry ────────────────────────────────────────────────────────────

async function handleRetryOwnerCapture(
    panel: vscode.WebviewPanel,
    secretsManager: SecretsManager,
    onBotReady: (bot: Bot, timeout: ReturnType<typeof setTimeout>) => void,
): Promise<void> {
    const token = await secretsManager.getBotToken();
    if (!token) {
        // No stored token — send user back to step 1
        panel.webview.postMessage({ command: 'goStep', step: 1 });
        return;
    }
    panel.webview.postMessage({ command: 'restartWaiting' });
    startOwnerCapture(token, panel, secretsManager, onBotReady);
}

// ─── Temporary polling bot for owner-ID capture ──────────────────────────────

function startOwnerCapture(
    token: string,
    panel: vscode.WebviewPanel,
    secretsManager: SecretsManager,
    onBotReady: (bot: Bot, timeout: ReturnType<typeof setTimeout>) => void,
): void {
    const captureBot = new Bot(token);
    let captured = false;

    // 60-second timeout — notify webview if no message arrives
    const timeoutHandle = setTimeout(() => {
        if (!captured) {
            captured = true;
            void captureBot.stop().catch(() => undefined);
            panel.webview.postMessage({ command: 'ownerTimeout' });
        }
    }, 60_000);

    // Capture the very first message as owner identification
    captureBot.on('message', async (ctx) => {
        if (captured) { return; }
        if (!ctx.from) { return; }

        captured = true;
        clearTimeout(timeoutHandle);

        const userId = String(ctx.from.id);
        console.log('[RemoteClaw] Owner ID captured successfully.');
        await secretsManager.storeOwnerId(userId);

        try {
            await ctx.reply('✅ Your owner ID has been captured! Return to VS Code to continue setup.');
        } catch (replyErr) {
            console.warn('[RemoteClaw] Could not send confirmation reply to Telegram:', replyErr);
        }

        await captureBot.stop().catch(() => undefined);
        panel.webview.postMessage({ command: 'ownerCaptured' });
    });

    onBotReady(captureBot, timeoutHandle);

    console.log('[RemoteClaw] Starting owner-capture polling...');
    // Start polling in the background — intentionally not awaited
    void captureBot.start().catch((err: unknown) => {
        console.error('[RemoteClaw] Owner-capture polling error:', err);
        if (!captured) {
            captured = true;
            clearTimeout(timeoutHandle);
            const errMsg = err instanceof Error ? err.message : String(err);
            panel.webview.postMessage({ command: 'pollingError', error: errMsg });
        }
    });
}

// ─── Step 3 → 4: Save preferences and send test message ──────────────────────

async function handleSavePreferences(
    prefs: PreferencePayload,
    panel: vscode.WebviewPanel,
    secretsManager: SecretsManager,
): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('telegramCopilot');
    await Promise.all([
        cfg.update('enableTerminal',        prefs.enableTerminal,        vscode.ConfigurationTarget.Global),
        cfg.update('enableScreenshots',     prefs.enableScreenshots,     vscode.ConfigurationTarget.Global),
        cfg.update('enablePIN',             prefs.enablePIN,             vscode.ConfigurationTarget.Global),
        cfg.update('notifyOnBuildComplete', prefs.notifyOnBuildComplete, vscode.ConfigurationTarget.Global),
        cfg.update('notifyOnTestComplete',  prefs.notifyOnTestComplete,  vscode.ConfigurationTarget.Global),
        cfg.update('notifyOnLongTask',      prefs.notifyOnLongTask,      vscode.ConfigurationTarget.Global),
    ]);

    const [storedToken, storedOwnerId] = await Promise.all([
        secretsManager.getBotToken(),
        secretsManager.getOwnerId(),
    ]);

    if (!storedToken || !storedOwnerId) {
        panel.webview.postMessage({
            command: 'testError',
            error: 'Credentials are missing. Please restart the wizard.',
        });
        return;
    }

    // Send the confirmation message to Telegram (Step 4 action)
    console.log('[RemoteClaw] Sending connection test message to Telegram...');
    try {
        const testBot = new Bot(storedToken);
        await testBot.api.sendMessage(
            Number(storedOwnerId),
            '🦞 Remote Claw is connected!\n\nYour VS Code instance is now reachable via Telegram.\nSend /help to see all available commands.',
        );
        console.log('[RemoteClaw] Test message sent successfully.');
    } catch (err) {
        console.error('[RemoteClaw] Failed to send test message:', err);
        const errMsg = err instanceof Error ? err.message : String(err);
        panel.webview.postMessage({ command: 'testError', error: errMsg });
        return;
    }

    panel.webview.postMessage({ command: 'goStep', step: 4 });
}

// ─── Webview HTML ─────────────────────────────────────────────────────────────

function buildWizardHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Remote Claw Setup</title>
<style>
  :root {
    --bg:           var(--vscode-editor-background, #1e1e1e);
    --fg:           var(--vscode-editor-foreground, #cccccc);
    --border:       var(--vscode-panel-border, #444);
    --btn-bg:       var(--vscode-button-background, #0e639c);
    --btn-fg:       var(--vscode-button-foreground, #ffffff);
    --btn-hover:    var(--vscode-button-hoverBackground, #1177bb);
    --btn2-bg:      var(--vscode-button-secondaryBackground, #3a3d41);
    --btn2-fg:      var(--vscode-button-secondaryForeground, #cccccc);
    --btn2-hover:   var(--vscode-button-secondaryHoverBackground, #45494e);
    --input-bg:     var(--vscode-input-background, #3c3c3c);
    --input-border: var(--vscode-input-border, #3c3c3c);
    --input-fg:     var(--vscode-input-foreground, #cccccc);
    --desc:         var(--vscode-descriptionForeground, #999);
    --err-border:   var(--vscode-inputValidation-errorBorder, #f48771);
    --err-bg:       var(--vscode-inputValidation-errorBackground, rgba(244,135,113,0.1));
    --success:      var(--vscode-testing-iconPassed, #73c991);
    --active:       var(--vscode-activityBarBadge-background, #0e639c);
    --mono:         var(--vscode-editor-font-family, 'Consolas', monospace);
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
    font-size: 13px; line-height: 1.5;
    padding: 28px 32px; max-width: 620px; margin: 0 auto;
  }
  h1 { font-size: 19px; font-weight: 600; margin-bottom: 4px; }
  .subtitle { color: var(--desc); margin-bottom: 24px; font-size: 12px; }

  /* Step indicator */
  .steps { display: flex; align-items: center; margin-bottom: 28px; }
  .step-dot {
    width: 28px; height: 28px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700;
    background: var(--border); color: var(--desc);
    flex-shrink: 0; transition: background 0.2s, color 0.2s; user-select: none;
  }
  .step-dot.active { background: var(--active); color: #fff; }
  .step-dot.done   { background: var(--success); color: #111; }
  .step-line { flex: 1; height: 2px; background: var(--border); transition: background 0.2s; }
  .step-line.done { background: var(--success); }

  /* Panels */
  .step-panel { display: none; }
  .step-panel.active { display: block; }
  h2 {
    font-size: 14px; font-weight: 600;
    margin-bottom: 14px; padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  p { margin-bottom: 10px; }
  ol { margin: 0 0 14px 20px; }
  ol li { margin-bottom: 4px; }
  code {
    background: var(--input-bg); padding: 1px 5px; border-radius: 3px;
    font-family: var(--mono); font-size: 12px;
  }

  /* Buttons */
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 14px; background: var(--btn-bg); color: var(--btn-fg);
    border: none; border-radius: 2px; cursor: pointer;
    font-size: 13px; font-family: inherit; transition: background 0.15s; user-select: none;
  }
  .btn:hover:not(:disabled) { background: var(--btn-hover); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary { background: var(--btn2-bg); color: var(--btn2-fg); }
  .btn-secondary:hover:not(:disabled) { background: var(--btn2-hover); }

  /* Inputs */
  .input-group { margin: 16px 0 0; }
  label { display: block; margin-bottom: 6px; font-weight: 600; }
  input[type="password"], input[type="text"] {
    width: 100%; padding: 6px 8px;
    background: var(--input-bg); border: 1px solid var(--input-border);
    color: var(--input-fg); border-radius: 2px;
    font-size: 13px; font-family: var(--mono); outline: none;
    transition: border-color 0.15s;
  }
  input:focus { border-color: var(--active); }
  .hint { font-size: 11px; color: var(--desc); margin-top: 5px; }

  /* Error / info boxes */
  .error-box {
    background: var(--err-bg); border: 1px solid var(--err-border);
    color: var(--err-border); padding: 8px 12px; border-radius: 2px;
    margin-top: 12px; font-size: 12px; display: none;
  }
  .error-box.show { display: block; }
  .info-box {
    background: rgba(14,99,156,0.12); border: 1px solid var(--active);
    padding: 10px 14px; border-radius: 2px; margin-top: 14px; font-size: 12px;
  }

  /* Step-2 waiting */
  .waiting {
    display: flex; align-items: center; gap: 12px;
    padding: 16px; border-radius: 3px; background: var(--input-bg); margin: 16px 0;
  }
  .spinner {
    width: 20px; height: 20px; flex-shrink: 0;
    border: 3px solid var(--border); border-top-color: var(--active);
    border-radius: 50%; animation: spin 0.75s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Step-3 toggles */
  .toggle-list { margin: 14px 0; }
  .toggle-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 0; border-bottom: 1px solid var(--border);
  }
  .toggle-row:last-child { border-bottom: none; }
  .toggle-info { flex: 1; padding-right: 16px; }
  .toggle-label { font-weight: 600; }
  .toggle-desc { font-size: 11px; color: var(--desc); margin-top: 2px; }
  .toggle { position: relative; width: 38px; height: 20px; flex-shrink: 0; }
  .toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
  .toggle-slider {
    position: absolute; inset: 0; background: var(--border);
    border-radius: 20px; cursor: pointer; transition: background 0.2s;
  }
  .toggle-slider::before {
    content: ''; position: absolute;
    width: 14px; height: 14px; left: 3px; top: 3px;
    background: #fff; border-radius: 50%; transition: transform 0.2s;
  }
  .toggle input:checked + .toggle-slider { background: var(--active); }
  .toggle input:checked + .toggle-slider::before { transform: translateX(18px); }

  /* Step-4 success */
  .success-box { text-align: center; padding: 32px 20px; }
  .success-icon { font-size: 52px; margin-bottom: 14px; }
  .success-title { font-size: 17px; font-weight: 600; margin-bottom: 8px; }
  .success-desc { color: var(--desc); margin-bottom: 24px; font-size: 13px; }

  .row { display: flex; gap: 10px; margin-top: 20px; }
</style>
</head>
<body>

<h1>🦞 Remote Claw — Setup Wizard</h1>
<p class="subtitle">Configure your personal Telegram bot in 4 quick steps.</p>

<div class="steps">
  <div class="step-dot active" id="dot1">1</div>
  <div class="step-line"       id="line1"></div>
  <div class="step-dot"        id="dot2">2</div>
  <div class="step-line"       id="line2"></div>
  <div class="step-dot"        id="dot3">3</div>
  <div class="step-line"       id="line3"></div>
  <div class="step-dot"        id="dot4">4</div>
</div>

<!-- Step 1: Bot Token -->
<div class="step-panel active" id="stepPanel1">
  <h2>Step 1 — Create Your Telegram Bot</h2>
  <p>You need a personal bot token from <strong>@BotFather</strong> on Telegram. It is free and takes about 30 seconds.</p>
  <ol>
    <li>Open @BotFather on Telegram and send <code>/newbot</code></li>
    <li>Choose a name and a username for your bot (username must end in <code>bot</code>)</li>
    <li>Copy the API token BotFather gives you</li>
    <li>Paste it in the field below</li>
  </ol>
  <button class="btn btn-secondary" id="btnBotFather">&#128241; Open @BotFather in Telegram</button>
  <div class="input-group">
    <label for="tokenInput">Bot Token</label>
    <input type="password" id="tokenInput"
           placeholder="123456789:ABCDefghIJKlmnoPQRstuvWXYz-1234567"
           autocomplete="off" spellcheck="false" />
    <p class="hint">Stored in VS Code encrypted secret storage — never written to any file or settings.json.</p>
  </div>
  <div class="error-box" id="tokenError"></div>
  <div class="row">
    <button class="btn" id="btnSubmitToken">Verify &amp; Continue &#8594;</button>
  </div>
</div>

<!-- Step 2: Owner ID Capture -->
<div class="step-panel" id="stepPanel2">
  <h2>Step 2 — Verify Your Identity</h2>
  <p>Remote Claw will now capture your Telegram user ID so that only <em>your</em> account can issue commands.</p>
  <p><strong>Open your new bot in Telegram and send any message</strong> (e.g. "hello"). The wizard will detect it automatically.</p>
  <div class="waiting" id="waitingBox">
    <div class="spinner" id="captureSpinner"></div>
    <span id="waitingText">Waiting for your message&#8230;</span>
  </div>
  <div class="error-box" id="ownerError"></div>
  <div class="info-box">
    <strong>Why is this needed?</strong><br>
    Your numeric Telegram user ID is the security key. Only messages from your account will be accepted by Remote Claw.
  </div>
</div>

<!-- Step 3: Preferences -->
<div class="step-panel" id="stepPanel3">
  <h2>Step 3 — Configure Preferences</h2>
  <p>Set your initial preferences. All can be changed later in <strong>VS Code Settings &#8594; Telegram Copilot</strong>.</p>
  <div class="toggle-list">
    <div class="toggle-row">
      <div class="toggle-info">
        <div class="toggle-label">Enable Terminal Commands</div>
        <div class="toggle-desc">Allows /run to execute shell commands remotely.</div>
      </div>
      <label class="toggle"><input type="checkbox" id="prefTerminal" checked><span class="toggle-slider"></span></label>
    </div>
    <div class="toggle-row">
      <div class="toggle-info">
        <div class="toggle-label">Enable Screenshots</div>
        <div class="toggle-desc">Allows /screenshot to capture and send your desktop image.</div>
      </div>
      <label class="toggle"><input type="checkbox" id="prefScreenshots" checked><span class="toggle-slider"></span></label>
    </div>
    <div class="toggle-row">
      <div class="toggle-info">
        <div class="toggle-label">Enable PIN Protection</div>
        <div class="toggle-desc">Requires a PIN via /auth before commands are accepted each session.</div>
      </div>
      <label class="toggle"><input type="checkbox" id="prefPIN"><span class="toggle-slider"></span></label>
    </div>
    <div class="toggle-row">
      <div class="toggle-info">
        <div class="toggle-label">Notify on Build Complete</div>
        <div class="toggle-desc">Sends a Telegram message when a VS Code build task finishes.</div>
      </div>
      <label class="toggle"><input type="checkbox" id="prefNotifyBuild" checked><span class="toggle-slider"></span></label>
    </div>
    <div class="toggle-row">
      <div class="toggle-info">
        <div class="toggle-label">Notify on Test Complete</div>
        <div class="toggle-desc">Sends a Telegram message when a test run completes.</div>
      </div>
      <label class="toggle"><input type="checkbox" id="prefNotifyTest" checked><span class="toggle-slider"></span></label>
    </div>
    <div class="toggle-row">
      <div class="toggle-info">
        <div class="toggle-label">Notify on Long-Running Tasks</div>
        <div class="toggle-desc">Alerts you when any running task exceeds 30 seconds.</div>
      </div>
      <label class="toggle"><input type="checkbox" id="prefNotifyLong" checked><span class="toggle-slider"></span></label>
    </div>
  </div>
  <div class="error-box" id="prefsError"></div>
  <div class="row">
    <button class="btn" id="btnSavePrefs">Save &amp; Send Test Message &#8594;</button>
  </div>
</div>

<!-- Step 4: Done -->
<div class="step-panel" id="stepPanel4">
  <h2>Step 4 — Setup Complete</h2>
  <div class="success-box">
    <div class="success-icon">&#129326;</div>
    <div class="success-title">Remote Claw is Connected!</div>
    <div class="success-desc">
      Check Telegram &#8212; your bot just sent you a confirmation message.<br>
      Your VS Code is now accessible from your phone.
    </div>
    <button class="btn" id="btnFinish">Close Setup Wizard</button>
  </div>
</div>

<script>
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();

  function showStep(n) {
    for (var i = 1; i <= 4; i++) {
      var panel = document.getElementById('stepPanel' + i);
      var dot   = document.getElementById('dot' + i);
      if (panel) { panel.classList.toggle('active', i === n); }
      if (dot) {
        dot.classList.remove('active', 'done');
        if (i < n)        { dot.classList.add('done');   }
        else if (i === n) { dot.classList.add('active'); }
      }
    }
    for (var j = 1; j <= 3; j++) {
      var line = document.getElementById('line' + j);
      if (line) { line.classList.toggle('done', j < n); }
    }
  }

  function showError(id, msg) {
    var el = document.getElementById(id);
    if (el) { el.textContent = msg; el.classList.add('show'); }
  }
  function hideError(id) {
    var el = document.getElementById(id);
    if (el) { el.textContent = ''; el.classList.remove('show'); }
  }
  function setBtn(id, text, disabled) {
    var el = document.getElementById(id);
    if (el) { el.textContent = text; el.disabled = disabled; }
  }

  /* Step 1 */
  document.getElementById('btnBotFather').addEventListener('click', function () {
    vscode.postMessage({ command: 'openBotFather' });
  });
  document.getElementById('btnSubmitToken').addEventListener('click', function () {
    var input = document.getElementById('tokenInput');
    var token = input ? input.value.trim() : '';
    if (!token) { showError('tokenError', 'Please paste your bot token above.'); return; }
    hideError('tokenError');
    setBtn('btnSubmitToken', 'Verifying\u2026', true);
    vscode.postMessage({ command: 'submitToken', token: token });
  });
  document.getElementById('tokenInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { document.getElementById('btnSubmitToken').click(); }
  });

  /* Step 3 */
  document.getElementById('btnSavePrefs').addEventListener('click', function () {
    function chk(id) { var el = document.getElementById(id); return el ? el.checked : false; }
    var prefs = {
      enableTerminal:        chk('prefTerminal'),
      enableScreenshots:     chk('prefScreenshots'),
      enablePIN:             chk('prefPIN'),
      notifyOnBuildComplete: chk('prefNotifyBuild'),
      notifyOnTestComplete:  chk('prefNotifyTest'),
      notifyOnLongTask:      chk('prefNotifyLong'),
    };
    hideError('prefsError');
    setBtn('btnSavePrefs', 'Sending test message\u2026', true);
    vscode.postMessage({ command: 'savePreferences', prefs: prefs });
  });

  /* Step 4 */
  document.getElementById('btnFinish').addEventListener('click', function () {
    vscode.postMessage({ command: 'finish' });
  });

  /* Messages from extension host */
  window.addEventListener('message', function (event) {
    var msg = event.data;
    switch (msg.command) {
      case 'goStep':
        showStep(msg.step);
        setBtn('btnSubmitToken', 'Verify & Continue \u2192', false);
        setBtn('btnSavePrefs',   'Save & Send Test Message \u2192', false);
        break;

      case 'tokenError':
        showError('tokenError', msg.error);
        setBtn('btnSubmitToken', 'Verify & Continue \u2192', false);
        break;

      case 'ownerCaptured': {
        var sp = document.getElementById('captureSpinner');
        var wt = document.getElementById('waitingText');
        if (sp) { sp.style.display = 'none'; }
        if (wt) { wt.textContent = '\u2705 Identity confirmed! Proceeding to preferences\u2026'; }
        setTimeout(function () { showStep(3); }, 1200);
        break;
      }

      case 'ownerTimeout': {
        var sp2 = document.getElementById('captureSpinner');
        if (sp2) { sp2.style.display = 'none'; }
        showError('ownerError',
          '\u23f1 No message received within 60 seconds. ' +
          'Open your bot in Telegram, send any message, then click Retry.');
        var errBox = document.getElementById('ownerError');
        if (errBox && !errBox.querySelector('.retry-btn')) {
          var retryBtn = document.createElement('button');
          retryBtn.className = 'btn btn-secondary retry-btn';
          retryBtn.style.marginTop = '8px';
          retryBtn.style.display = 'block';
          retryBtn.textContent = '\ud83d\udd04 Retry';
          retryBtn.addEventListener('click', function () {
            hideError('ownerError');
            var existing = errBox.querySelector('.retry-btn');
            if (existing) { existing.remove(); }
            var sp3 = document.getElementById('captureSpinner');
            if (sp3) { sp3.style.display = ''; }
            var wt2 = document.getElementById('waitingText');
            if (wt2) { wt2.textContent = 'Waiting for your message\u2026'; }
            vscode.postMessage({ command: 'retryOwnerCapture' });
          });
          errBox.appendChild(retryBtn);
        }
        break;
      }

      case 'restartWaiting': {
        var sp4 = document.getElementById('captureSpinner');
        if (sp4) { sp4.style.display = ''; }
        var wt3 = document.getElementById('waitingText');
        if (wt3) { wt3.textContent = 'Waiting for your message\u2026'; }
        hideError('ownerError');
        break;
      }

      case 'pollingError': {
        var sp5 = document.getElementById('captureSpinner');
        if (sp5) { sp5.style.display = 'none'; }
        showError('ownerError', 'Polling error: ' + msg.error +
          '. Please go back to Step 1 and verify the bot token.');
        break;
      }

      case 'testError':
        showError('prefsError', 'Failed to send test message: ' + msg.error);
        setBtn('btnSavePrefs', 'Save & Send Test Message \u2192', false);
        break;
    }
  });
})();
</script>
</body>
</html>`;
}
