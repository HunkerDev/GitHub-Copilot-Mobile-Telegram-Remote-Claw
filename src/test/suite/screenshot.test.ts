/**
 * Screenshot — captureScreenshot() unit tests
 *
 * screenshot-desktop is stubbed via require.cache injection so no real
 * display is needed. Tests verify that the function returns a valid Buffer
 * and that the buffer can be saved to disk as a PNG file.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// ── Minimal valid PNG (1×1 transparent pixel) ─────────────────────────────────
const FAKE_PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
    '890000000a49444154789c6260000000020001e221bc330000000049454e44ae426082',
    'hex',
);

// ── Inject stub into require.cache BEFORE loading screenshot.ts ───────────────
const ssDesktopPath = require.resolve('screenshot-desktop');
const fakeCapture = (_opts?: { format?: string }): Promise<Buffer> => Promise.resolve(FAKE_PNG);
(require.cache as Record<string, unknown>)[ssDesktopPath] = {
    id: ssDesktopPath,
    filename: ssDesktopPath,
    loaded: true,
    exports: fakeCapture,
    parent: null,
    children: [],
    paths: [],
};

// Force fresh load of screenshot module with stub active
const screenshotModulePath = require.resolve('../../utils/screenshot');
delete (require.cache as Record<string, unknown>)[screenshotModulePath];
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { captureScreenshot } = require('../../utils/screenshot') as typeof import('../../utils/screenshot');

// ── Output directory for saved screenshots ────────────────────────────────────
const OUTPUT_DIR = path.resolve(__dirname, '..', '..', '..', 'out', 'test-screenshots');

suite('Screenshot — captureScreenshot()', () => {
    suiteSetup(() => {
        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }
    });

    test('returns a Buffer', async () => {
        const buf = await captureScreenshot();
        assert.ok(Buffer.isBuffer(buf), 'captureScreenshot() must return a Buffer');
    });

    test('buffer is not empty', async () => {
        const buf = await captureScreenshot();
        assert.ok(buf.length > 0, 'Buffer must not be empty');
    });

    test('saves screenshot to output folder', async () => {
        const buf = await captureScreenshot();
        const filePath = path.join(OUTPUT_DIR, `screenshot-${Date.now()}.png`);

        fs.writeFileSync(filePath, buf);

        assert.ok(fs.existsSync(filePath), 'File must exist after saving');
        const saved = fs.readFileSync(filePath);
        assert.strictEqual(saved.length, buf.length, 'Saved file size must match buffer size');

        fs.unlinkSync(filePath);
    });

    test('saved file has PNG signature', async () => {
        const buf = await captureScreenshot();
        const filePath = path.join(OUTPUT_DIR, `screenshot-sig-${Date.now()}.png`);

        fs.writeFileSync(filePath, buf);
        const saved = fs.readFileSync(filePath);

        // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
        assert.strictEqual(saved[0], 0x89, 'Byte 0: PNG signature');
        assert.strictEqual(saved[1], 0x50, 'Byte 1: P');
        assert.strictEqual(saved[2], 0x4e, 'Byte 2: N');
        assert.strictEqual(saved[3], 0x47, 'Byte 3: G');

        fs.unlinkSync(filePath);
    });
});
