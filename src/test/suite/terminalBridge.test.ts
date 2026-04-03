/**
 * TerminalBridge Unit Tests
 *
 * Tests the pure-logic functions of TerminalBridge without any VS Code API
 * dependency, following the same mirror pattern as chatMonitor.test.ts.
 *
 * Covered:
 *  - classifyCommand(): denylist, allowlist precedence, clean commands
 *  - output truncation
 *  - readFile() path-traversal guard
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';

// ── Mirror: classifyCommand logic ─────────────────────────────────────────────

type CommandVerdict = 'allow' | 'deny' | 'confirm';

interface ClassifyConfig {
    commandAllowlist: string[];
    commandDenylist: string[];
    confirmDestructive: boolean;
}

const DESTRUCTIVE_PATTERNS = [
    'rm ', 'del ', 'rmdir', 'rd ', 'mv ', 'move ',
    'dd ', 'mkfs', 'fdisk', 'kill ', 'killall', 'pkill',
    'shutdown', 'reboot', 'halt',
];

function classifyCommand(cmd: string, cfg: ClassifyConfig): CommandVerdict {
    const { commandAllowlist, commandDenylist, confirmDestructive } = cfg;

    if (commandAllowlist.length > 0) {
        return commandAllowlist.some(e => cmd.includes(e)) ? 'allow' : 'deny';
    }

    if (commandDenylist.some(p => cmd.toLowerCase().includes(p.toLowerCase()))) {
        return 'deny';
    }

    if (confirmDestructive && DESTRUCTIVE_PATTERNS.some(p => cmd.toLowerCase().includes(p))) {
        return 'confirm';
    }

    return 'allow';
}

// ── Mirror: truncate logic ────────────────────────────────────────────────────

function truncate(text: string, maxLines: number): string {
    const lines = text.split('\n');
    if (lines.length <= maxLines) { return text; }
    return lines.slice(0, maxLines).join('\n') + `\n… (truncated, ${lines.length - maxLines} more lines)`;
}

// ── Mirror: readFile path-traversal guard ─────────────────────────────────────

function validateFilePath(workspaceRoot: string, filePath: string): void {
    const resolved = path.resolve(workspaceRoot, filePath);
    if (!resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot) {
        throw new Error('Access denied: path is outside the workspace.');
    }
}

// ── Helper config ─────────────────────────────────────────────────────────────

const DEFAULT_DENYLIST = ['rm -rf', 'del /f', 'format', 'DROP TABLE', ':(){:|:&};:'];

function cfg(overrides: Partial<ClassifyConfig> = {}): ClassifyConfig {
    return {
        commandAllowlist: [],
        commandDenylist: DEFAULT_DENYLIST,
        confirmDestructive: true,
        ...overrides,
    };
}

// ── Tests: classifyCommand ────────────────────────────────────────────────────

suite('TerminalBridge — classifyCommand()', () => {

    test('T3.4.1 — denylist substring match → deny (all 5 default patterns)', () => {
        assert.strictEqual(classifyCommand('rm -rf /',          cfg()), 'deny');
        assert.strictEqual(classifyCommand('del /f /s C:\\',    cfg()), 'deny');
        assert.strictEqual(classifyCommand('format C:',         cfg()), 'deny');
        assert.strictEqual(classifyCommand('DROP TABLE users',  cfg()), 'deny');
        assert.strictEqual(classifyCommand(':(){:|:&};:',       cfg()), 'deny');
    });

    test('T3.4.2 — allowlist matches → allow (overrides denylist)', () => {
        const c = cfg({ commandAllowlist: ['rm -rf /tmp'] });
        assert.strictEqual(classifyCommand('rm -rf /tmp', c), 'allow');
    });

    test('T3.4.2b — allowlist non-empty, command not in list → deny', () => {
        const c = cfg({ commandAllowlist: ['npm test'] });
        assert.strictEqual(classifyCommand('ls -la',    c), 'deny');
        assert.strictEqual(classifyCommand('rm -rf /',  c), 'deny');
    });

    test('T3.4.3 — empty allowlist + clean command → allow', () => {
        const c = cfg({ confirmDestructive: false });
        assert.strictEqual(classifyCommand('npm test',   c), 'allow');
        assert.strictEqual(classifyCommand('ls -la',     c), 'allow');
        assert.strictEqual(classifyCommand('git status', c), 'allow');
    });

    test('destructive + confirmDestructive true → confirm', () => {
        assert.strictEqual(classifyCommand('rm /tmp/file.txt', cfg()), 'confirm');
        assert.strictEqual(classifyCommand('kill 1234',        cfg()), 'confirm');
    });

    test('destructive + confirmDestructive false → allow', () => {
        const c = cfg({ confirmDestructive: false });
        assert.strictEqual(classifyCommand('rm /tmp/file.txt', c), 'allow');
    });

    test('denylist is case-insensitive', () => {
        assert.strictEqual(classifyCommand('RM -RF /',       cfg()), 'deny');
        assert.strictEqual(classifyCommand('Drop Table foo', cfg()), 'deny');
    });
});

// ── Tests: truncation ─────────────────────────────────────────────────────────

suite('TerminalBridge — output truncation', () => {

    test('T3.4.4 — output exceeding maxLines is truncated', () => {
        const input = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
        const result = truncate(input, 3);
        const lines = result.split('\n');
        assert.ok(lines.length <= 4, `Expected ≤4 lines, got ${lines.length}`);
        assert.ok(result.includes('truncated'), 'Must contain truncation notice');
        assert.ok(result.includes('7 more lines'), 'Must report correct remaining count');
    });

    test('output within limit is returned unchanged', () => {
        const input = 'line1\nline2\nline3';
        assert.strictEqual(truncate(input, 5), input);
        assert.ok(!truncate(input, 5).includes('truncated'));
    });

    test('runCommand truncates real output', async () => {
        const cmd = os.platform() === 'win32'
            ? 'echo 1 && echo 2 && echo 3 && echo 4 && echo 5'
            : 'printf "1\n2\n3\n4\n5\n"';

        const output = await new Promise<string>((resolve) => {
            exec(cmd, (err, stdout, stderr) => {
                const raw = stdout || stderr || (err?.message ?? '');
                resolve(truncate(raw, 3));
            });
        });
        assert.ok(output.includes('truncated'), 'Real 5-line output truncated to 3 should note truncation');
    });
});

// ── Tests: readFile path-traversal ───────────────────────────────────────────

suite('TerminalBridge — readFile() path guard', () => {

    test('T3.4.5 — path traversal outside workspace throws', () => {
        const root = os.tmpdir();
        assert.throws(
            () => validateFilePath(root, '../../etc/passwd'),
            /outside the workspace/,
        );
    });

    test('path inside workspace does not throw', () => {
        const root = os.tmpdir();
        assert.doesNotThrow(() => validateFilePath(root, 'somefile.txt'));
    });

    test('reading a real file in workspace works', async () => {
        const root = os.tmpdir();
        const testFile = path.join(root, `tb-test-${Date.now()}.txt`);
        fs.writeFileSync(testFile, 'hello from test');

        // Simulate readFile (without vscode dependency)
        const filePath = path.basename(testFile);
        validateFilePath(root, filePath); // should not throw
        const content = fs.readFileSync(path.resolve(root, filePath), 'utf8');
        assert.strictEqual(content, 'hello from test');

        fs.unlinkSync(testFile);
    });
});
