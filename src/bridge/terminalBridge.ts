import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec, ChildProcess } from 'child_process';
import { TelegramCopilotConfig } from '../config/settings';

export class TerminalBridge {
    private activeProcess: ChildProcess | undefined;
    private readonly config: TelegramCopilotConfig;

    constructor(config: TelegramCopilotConfig) {
        this.config = config;
    }

    // ── T3.1.2 — Command classifier ───────────────────────────────────────────

    classifyCommand(cmd: string): 'allow' | 'deny' | 'confirm' {
        const { commandAllowlist, commandDenylist, confirmDestructive } = this.config;

        // Allowlist takes absolute precedence when non-empty
        if (commandAllowlist.length > 0) {
            return commandAllowlist.some(entry => cmd.includes(entry)) ? 'allow' : 'deny';
        }

        // Denylist substring match
        if (commandDenylist.some(pattern => cmd.toLowerCase().includes(pattern.toLowerCase()))) {
            return 'deny';
        }

        // Destructive confirmation guard
        if (confirmDestructive && this._isDestructive(cmd)) {
            return 'confirm';
        }

        return 'allow';
    }

    private _isDestructive(cmd: string): boolean {
        const destructivePatterns = [
            'rm ', 'del ', 'rmdir', 'rd ', 'mv ', 'move ',
            'dd ', 'mkfs', 'fdisk', 'kill ', 'killall', 'pkill',
            'shutdown', 'reboot', 'halt',
        ];
        return destructivePatterns.some(p => cmd.toLowerCase().includes(p));
    }

    // ── T3.1.3 — Run a shell command ──────────────────────────────────────────

    runCommand(cmd: string): Promise<string> {
        return new Promise((resolve) => {
            const cwd = this._workspaceRoot();
            this.activeProcess = exec(cmd, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
                this.activeProcess = undefined;
                const combined = [stdout, stderr].filter(Boolean).join('\n');
                const result = combined || (err ? err.message : '(no output)');
                resolve(this._truncate(result));
            });
        });
    }

    // ── T3.1.4 — Stop active process ──────────────────────────────────────────

    stop(): void {
        if (this.activeProcess) {
            this.activeProcess.kill();
            this.activeProcess = undefined;
        }
    }

    // ── T3.1.5 — Read workspace file ──────────────────────────────────────────

    async readFile(filePath: string): Promise<string> {
        const root = this._workspaceRoot();
        if (!root) {
            throw new Error('No workspace folder open.');
        }

        const resolved = path.resolve(root, filePath);

        // Anti path-traversal: resolved path must start with workspace root
        if (!resolved.startsWith(root + path.sep) && resolved !== root) {
            throw new Error('Access denied: path is outside the workspace.');
        }

        if (!fs.existsSync(resolved)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const content = fs.readFileSync(resolved, 'utf8');
        return this._truncate(content);
    }

    // ── T3.1.6 — Git diff ─────────────────────────────────────────────────────

    getGitDiff(): Promise<string> {
        return new Promise((resolve) => {
            const cwd = this._workspaceRoot();
            exec('git diff', { cwd }, (err, stdout, stderr) => {
                const result = stdout || stderr || (err ? err.message : '(no diff)');
                resolve(this._truncate(result));
            });
        });
    }

    // ── T3.1.7 — Run git command ──────────────────────────────────────────────

    runGit(args: string): Promise<string> {
        return new Promise((resolve) => {
            const cwd = this._workspaceRoot();
            exec(`git ${args}`, { cwd, timeout: 15_000 }, (err, stdout, stderr) => {
                const result = stdout || stderr || (err ? err.message : '(no output)');
                resolve(this._truncate(result));
            });
        });
    }

    // ── T3.1.8 — VS Code status ───────────────────────────────────────────────

    async getStatus(): Promise<string> {
        const lines: string[] = [];

        // Active file
        const editor = vscode.window.activeTextEditor;
        lines.push(`📄 Active file: ${editor ? editor.document.fileName : '(none)'}`);

        // Git branch via git CLI
        const branch = await new Promise<string>((resolve) => {
            exec('git rev-parse --abbrev-ref HEAD', { cwd: this._workspaceRoot() }, (err, stdout) => {
                resolve(stdout.trim() || (err ? '(not a git repo)' : 'unknown'));
            });
        });
        lines.push(`🌿 Branch: ${branch}`);

        // Diagnostics summary
        const allDiagnostics = vscode.languages.getDiagnostics();
        let errors = 0;
        let warnings = 0;
        for (const [, diags] of allDiagnostics) {
            for (const d of diags) {
                if (d.severity === vscode.DiagnosticSeverity.Error) { errors++; }
                else if (d.severity === vscode.DiagnosticSeverity.Warning) { warnings++; }
            }
        }
        lines.push(`🔴 Errors: ${errors}  ⚠️ Warnings: ${warnings}`);

        return lines.join('\n');
    }

    // ── T3.1.9 — Diagnostics list ─────────────────────────────────────────────

    getErrors(): Promise<string> {
        const allDiagnostics = vscode.languages.getDiagnostics();
        const lines: string[] = [];

        for (const [uri, diags] of allDiagnostics) {
            const relevant = diags.filter(d =>
                d.severity === vscode.DiagnosticSeverity.Error ||
                d.severity === vscode.DiagnosticSeverity.Warning,
            );
            if (relevant.length === 0) { continue; }

            const fileName = path.basename(uri.fsPath);
            for (const d of relevant) {
                const icon = d.severity === vscode.DiagnosticSeverity.Error ? '🔴' : '⚠️';
                const line = d.range.start.line + 1;
                lines.push(`${icon} ${fileName}:${line} — ${d.message}`);
            }
        }

        if (lines.length === 0) {
            return Promise.resolve('✅ No errors or warnings.');
        }
        return Promise.resolve(this._truncate(lines.join('\n')));
    }

    // ── T3.1.10 — Open file in editor ────────────────────────────────────────

    async openFile(filePath: string): Promise<void> {
        const root = this._workspaceRoot();
        const resolved = root ? path.resolve(root, filePath) : filePath;
        const doc = await vscode.workspace.openTextDocument(resolved);
        await vscode.window.showTextDocument(doc);
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private _workspaceRoot(): string | undefined {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    private _truncate(text: string): string {
        const lines = text.split('\n');
        const max = this.config.terminalOutputMaxLines;
        if (lines.length <= max) { return text; }
        return lines.slice(0, max).join('\n') + `\n… (truncated, ${lines.length - max} more lines)`;
    }
}
