// eslint-disable-next-line @typescript-eslint/no-var-requires
const screenshotDesktop = require('screenshot-desktop') as (opts?: { format?: string }) => Promise<Buffer>;

/**
 * Captures the full desktop screen and returns a PNG buffer.
 * Never writes to disk.
 */
export async function captureScreenshot(): Promise<Buffer> {
    const result = await screenshotDesktop({ format: 'png' });
    return Buffer.isBuffer(result) ? result : Buffer.from(result);
}
