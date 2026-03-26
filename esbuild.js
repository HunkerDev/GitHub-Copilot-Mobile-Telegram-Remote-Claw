// @ts-check
'use strict';

const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode', 'grammy', 'screenshot-desktop'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    minify: !watch,
};

if (watch) {
    esbuild.context(buildOptions).then((ctx) => {
        ctx.watch();
        console.log('[esbuild] Watching for changes...');
    }).catch((err) => {
        console.error(err);
        process.exit(1);
    });
} else {
    esbuild.build(buildOptions).then(() => {
        console.log('[esbuild] Build succeeded → dist/extension.js');
    }).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
