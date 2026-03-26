/**
 * ChatMonitor Algorithm Tests
 *
 * These tests exercise the core algorithm logic in pure TypeScript with no
 * VS Code API dependency. All functions are local mirrors of the logic inside
 * ChatMonitor — tested directly via a single simulated `runMonitorAlgorithm()`
 * function that drives the full pipeline with fake clipboard snapshots.
 */
import * as assert from 'assert';

// ── Mirror of ChatMonitor pure-logic functions ────────────────────────────────

/** Mirrors ChatMonitor._extractLastAssistantResponse / extractFn */
function extractLastAssistantResponse(transcript: string): string {
    const lines = transcript.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const copilotMatch = lines[i].match(/^GitHub Copilot:\s*(.*)$/);
        const assistantMatch = lines[i].match(/^Assistant:\s*(.*)$/);
        if (copilotMatch || assistantMatch) {
            const firstLine = (copilotMatch?.[1] || assistantMatch?.[1] || '').trim();
            const rest = lines.slice(i + 1).filter(l => l.trim()).join('\n');
            return [firstLine, rest].filter(Boolean).join('\n').trim();
        }
    }
    return transcript.trim();
}

/** Mirrors ChatMonitor stability detection state machine */
function runStabilityDetector(polls: string[]): number[] {
    // Returns the indices of polls where stability (2× same) was detected
    let prev = '';
    let stableCount = 0;
    const stableAt: number[] = [];
    for (let i = 0; i < polls.length; i++) {
        const clip = polls[i];
        const hasMarker = clip.includes('GitHub Copilot:') || clip.includes('Assistant:');
        if (!hasMarker || !clip.trim()) { prev = clip; stableCount = 0; continue; }
        if (clip === prev) {
            stableCount++;
            if (stableCount >= 2) { stableAt.push(i); stableCount = 0; }
        } else {
            stableCount = 1; // first occurrence starts the count
        }
        prev = clip;
    }
    return stableAt;
}

/** Mirrors ChatMonitor diff algorithm (FR-6) */
function computeDiff(lastSentContent: string, currentResponse: string): string[] {
    const lastLines    = lastSentContent.split('\n');
    const currentLines = currentResponse.split('\n');
    return currentLines.filter(line => !lastLines.includes(line));
}

/** Mirrors ChatMonitor marker count check */
function isNewCopilotResponse(lastSentContent: string, currentResponse: string): boolean {
    const countLast    = (lastSentContent.match(/^GitHub Copilot:/gm) ?? []).length;
    const countCurrent = (currentResponse.match(/^GitHub Copilot:/gm) ?? []).length;
    return countCurrent > countLast;
}

/** Mirrors ChatMonitor anti-flood guard (FR-7) */
function isAntiFloodBlocked(lastSentAt: number, now: number, minIntervalMs = 10_000): boolean {
    return (now - lastSentAt) < minIntervalMs;
}

// ── Simulated full pipeline: runMonitorAlgorithm ─────────────────────────────
/**
 * Drives the complete ChatMonitor decision pipeline against a sequence of
 * fake clipboard snapshots. Returns the list of messages that would be sent
 * to Telegram. No VS Code APIs, no timers — pure algorithm simulation.
 */
function runMonitorAlgorithm(
    clipboardSnapshots: string[],
    antiFloodMs = 10_000,
): string[] {
    const sent: string[] = [];
    let lastSentContent = '';
    let lastSentAt = 0;
    let simulatedNow = 0;

    const stableIndices = new Set(runStabilityDetector(clipboardSnapshots));

    for (let i = 0; i < clipboardSnapshots.length; i++) {
        simulatedNow += antiFloodMs + 1; // advance clock past anti-flood on each step

        if (!stableIndices.has(i)) { continue; }

        const currentResponse = extractLastAssistantResponse(clipboardSnapshots[i]);
        if (!currentResponse.trim()) { continue; }

        // Anti-flood
        if (isAntiFloodBlocked(lastSentAt, simulatedNow, antiFloodMs)) { continue; }

        // First send
        if (!lastSentContent) {
            sent.push(currentResponse);
            lastSentContent = currentResponse;
            lastSentAt = simulatedNow;
            continue;
        }

        // New response (marker count increased)
        if (isNewCopilotResponse(lastSentContent, currentResponse)) {
            sent.push(currentResponse);
            lastSentContent = currentResponse;
            lastSentAt = simulatedNow;
            continue;
        }

        // Diff send
        const newLines = computeDiff(lastSentContent, currentResponse);
        if (newLines.length > 0) {
            const diff = newLines.join('\n');
            sent.push(diff);
            lastSentContent = lastSentContent + '\n' + diff;
            lastSentAt = simulatedNow;
        }
    }

    return sent;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

suite('ChatMonitor — Algorithm', () => {

    // ── extractLastAssistantResponse ─────────────────────────────────────────

    test('extract: returns content on same line as GitHub Copilot:', () => {
        const r = extractLastAssistantResponse('User: hi\nGitHub Copilot: Hello world');
        assert.strictEqual(r, 'Hello world');
    });

    test('extract: includes lines after the marker', () => {
        const r = extractLastAssistantResponse('GitHub Copilot: First line\nSecond line\nThird line');
        assert.ok(r.includes('First line'));
        assert.ok(r.includes('Second line'));
        assert.ok(r.includes('Third line'));
    });

    test('extract: picks the LAST GitHub Copilot: marker in a multi-turn transcript', () => {
        const transcript = 'GitHub Copilot: Old answer\nUser: follow-up\nGitHub Copilot: New answer';
        const r = extractLastAssistantResponse(transcript);
        assert.strictEqual(r, 'New answer');
    });

    test('extract: works with Assistant: marker too', () => {
        const r = extractLastAssistantResponse('Assistant: Hello from assistant');
        assert.strictEqual(r, 'Hello from assistant');
    });

    test('extract: fallback returns full text when no marker found', () => {
        const r = extractLastAssistantResponse('no marker here');
        assert.strictEqual(r, 'no marker here');
    });

    // ── Stability detection ──────────────────────────────────────────────────

    test('stability: triggers on 2nd consecutive identical read with marker', () => {
        const polls = [
            'GitHub Copilot: answer',   // i=0, first occurrence → stableCount=1
            'GitHub Copilot: answer',   // i=1, same → stableCount=2 → stable at i=1
        ];
        const stable = runStabilityDetector(polls);
        assert.deepStrictEqual(stable, [1]);
    });

    test('stability: resets when content changes between reads', () => {
        const polls = [
            'GitHub Copilot: part 1',
            'GitHub Copilot: part 1 extended', // changed → stableCount resets to 1
            'GitHub Copilot: part 1 extended', // same → stableCount=2 → stable at i=2
            'GitHub Copilot: part 1 extended',
        ];
        const stable = runStabilityDetector(polls);
        assert.deepStrictEqual(stable, [2]); // 2nd consecutive identical read, regardless of prior content
    });

    test('stability: no trigger without assistant marker', () => {
        const polls = ['no marker', 'no marker', 'no marker'];
        const stable = runStabilityDetector(polls);
        assert.deepStrictEqual(stable, []);
    });

    test('stability: can detect multiple stable points in one sequence', () => {
        const polls = [
            'GitHub Copilot: chunk 1',
            'GitHub Copilot: chunk 1',   // stable at i=1
            'GitHub Copilot: chunk 1 + 2',
            'GitHub Copilot: chunk 1 + 2', // stable at i=3
        ];
        const stable = runStabilityDetector(polls);
        assert.deepStrictEqual(stable, [1, 3]);
    });

    // ── Diff algorithm ───────────────────────────────────────────────────────

    test('diff: returns only new lines', () => {
        const newLines = computeDiff('Line A\nLine B', 'Line A\nLine B\nLine C');
        assert.deepStrictEqual(newLines, ['Line C']);
    });

    test('diff: returns empty when nothing new', () => {
        const newLines = computeDiff('Line A\nLine B', 'Line A\nLine B');
        assert.strictEqual(newLines.length, 0);
    });

    test('diff: multiple new lines all returned, in order', () => {
        const newLines = computeDiff('A', 'A\nB\nC\nD');
        assert.deepStrictEqual(newLines, ['B', 'C', 'D']);
    });

    // ── Marker count (new response detection) ────────────────────────────────

    test('isNewCopilotResponse: detects second Copilot marker as new response', () => {
        const last    = 'GitHub Copilot: first answer';
        const current = 'GitHub Copilot: first answer\nUser: follow up\nGitHub Copilot: second answer';
        assert.strictEqual(isNewCopilotResponse(last, current), true);
    });

    test('isNewCopilotResponse: same count is not a new response', () => {
        const last    = 'GitHub Copilot: first answer';
        const current = 'GitHub Copilot: first answer with more text';
        assert.strictEqual(isNewCopilotResponse(last, current), false);
    });

    // ── Anti-flood guard ─────────────────────────────────────────────────────

    test('anti-flood: blocks send within 10s window', () => {
        assert.strictEqual(isAntiFloodBlocked(1000, 5000, 10_000), true);
    });

    test('anti-flood: allows send after 10s have elapsed', () => {
        assert.strictEqual(isAntiFloodBlocked(1000, 11_001, 10_000), false);
    });

    test('anti-flood: allows first send (lastSentAt=0)', () => {
        assert.strictEqual(isAntiFloodBlocked(0, 10_001, 10_000), false);
    });

    // ── Full pipeline simulation ─────────────────────────────────────────────

    test('pipeline: first stable read sends full response', () => {
        const snapshots = [
            'GitHub Copilot: The answer is 42',
            'GitHub Copilot: The answer is 42', // stable here
        ];
        const sent = runMonitorAlgorithm(snapshots);
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0], 'The answer is 42');
    });

    test('pipeline: second stable read sends only the new lines (diff)', () => {
        const snapshots = [
            'GitHub Copilot: First chunk',
            'GitHub Copilot: First chunk',              // stable → first send
            'GitHub Copilot: First chunk\nSecond chunk',
            'GitHub Copilot: First chunk\nSecond chunk', // stable → diff send
        ];
        const sent = runMonitorAlgorithm(snapshots);
        assert.strictEqual(sent.length, 2);
        assert.strictEqual(sent[0], 'First chunk');
        assert.ok(sent[1].includes('Second chunk'), `Expected diff, got: "${sent[1]}"`);
        assert.ok(!sent[1].includes('First chunk'), `Diff should not repeat already-sent content`);
    });

    test('pipeline: new Copilot marker sends full new response, not a diff', () => {
        const snapshots = [
            'GitHub Copilot: First answer',
            'GitHub Copilot: First answer',                                         // stable → first send
            'GitHub Copilot: First answer\nUser: more\nGitHub Copilot: Second answer',
            'GitHub Copilot: First answer\nUser: more\nGitHub Copilot: Second answer', // stable → full send
        ];
        const sent = runMonitorAlgorithm(snapshots);
        assert.strictEqual(sent.length, 2);
        assert.strictEqual(sent[0], 'First answer');
        assert.strictEqual(sent[1], 'Second answer');
    });

    test('pipeline: identical stable reads do not re-send the same content', () => {
        const snapshots = [
            'GitHub Copilot: Only answer',
            'GitHub Copilot: Only answer', // stable → sends once
            'GitHub Copilot: Only answer',
            'GitHub Copilot: Only answer', // stable again → diff is empty → no send
        ];
        const sent = runMonitorAlgorithm(snapshots);
        assert.strictEqual(sent.length, 1, `Should send exactly once, got ${sent.length}: ${JSON.stringify(sent)}`);
    });

    test('pipeline: sub-agent pause (no change mid-sequence) then resumes', () => {
        const snapshots = [
            'GitHub Copilot: Partial answer...',
            'GitHub Copilot: Partial answer...', // stable → sends (tool call paused here)
            'GitHub Copilot: Partial answer...',
            'GitHub Copilot: Partial answer...', // stable again → diff empty → no send
            'GitHub Copilot: Partial answer...\nTool result integrated. Full answer here.',
            'GitHub Copilot: Partial answer...\nTool result integrated. Full answer here.', // stable → diff with new line
        ];
        const sent = runMonitorAlgorithm(snapshots);
        assert.strictEqual(sent.length, 2, `Expected 2 sends (initial + after tool), got ${sent.length}`);
        assert.ok(sent[1].includes('Tool result integrated'), `Second send should contain new content`);
    });
});
