import * as assert from 'assert';
import {
    getUtf16Length,
    markdownToEntitiesTelegram,
    type TelegramEntity,
} from '../../utils/formatter';

// ---------------------------------------------------------------------------
// suite: getUtf16Length
// ---------------------------------------------------------------------------

suite('formatter — getUtf16Length', () => {
    test('T-UTF-1: ASCII string', () => {
        assert.strictEqual(getUtf16Length('hello'), 5);
    });

    test('T-UTF-2: empty string', () => {
        assert.strictEqual(getUtf16Length(''), 0);
    });

    test('T-UTF-3: string with emoji (2 UTF-16 code units)', () => {
        // '😀' is U+1F600, encoded as a surrogate pair in UTF-16 → length 2
        assert.strictEqual(getUtf16Length('😀'), 2);
    });
});

// ---------------------------------------------------------------------------
// suite: markdownToEntitiesTelegram
// ---------------------------------------------------------------------------

suite('formatter — markdownToEntitiesTelegram', () => {

    // T1 — Bold
    test('T1: bold text', () => {
        const result = markdownToEntitiesTelegram('**Hello**');
        assert.strictEqual(result.text, 'Hello');
        assert.deepStrictEqual(result.entities, [
            { _: 'messageEntityBold', offset: 0, length: 5 },
        ] as TelegramEntity[]);
    });

    // T2 — Italic
    test('T2: italic text', () => {
        const result = markdownToEntitiesTelegram('*world*');
        assert.strictEqual(result.text, 'world');
        assert.deepStrictEqual(result.entities, [
            { _: 'messageEntityItalic', offset: 0, length: 5 },
        ] as TelegramEntity[]);
    });

    // T3 — Strikethrough
    test('T3: strikethrough text', () => {
        const result = markdownToEntitiesTelegram('~~deleted~~');
        assert.strictEqual(result.text, 'deleted');
        assert.deepStrictEqual(result.entities, [
            { _: 'messageEntityStrike', offset: 0, length: 7 },
        ] as TelegramEntity[]);
    });

    // T4 — Inline code
    test('T4: inline code', () => {
        const result = markdownToEntitiesTelegram('`myVar`');
        assert.strictEqual(result.text, 'myVar');
        assert.deepStrictEqual(result.entities, [
            { _: 'messageEntityCode', offset: 0, length: 5 },
        ] as TelegramEntity[]);
    });

    // T5 — Fenced code block with language
    test('T5: fenced code block with language', () => {
        const result = markdownToEntitiesTelegram('```typescript\nconst x = 1;\n```');
        assert.strictEqual(result.text, 'const x = 1;');
        assert.deepStrictEqual(result.entities, [
            { _: 'messageEntityPre', offset: 0, length: 12, language: 'typescript' },
        ] as TelegramEntity[]);
    });

    // T6 — Fenced code block without language
    test('T6: fenced code block without language', () => {
        const result = markdownToEntitiesTelegram('```\nhello\n```');
        assert.strictEqual(result.text, 'hello');
        assert.deepStrictEqual(result.entities, [
            { _: 'messageEntityPre', offset: 0, length: 5, language: '' },
        ] as TelegramEntity[]);
    });

    // T7 — Hyperlink
    test('T7: hyperlink', () => {
        const result = markdownToEntitiesTelegram('[GitHub](https://github.com)');
        assert.strictEqual(result.text, 'GitHub');
        assert.deepStrictEqual(result.entities, [
            { _: 'messageEntityTextUrl', offset: 0, length: 6, url: 'https://github.com' },
        ] as TelegramEntity[]);
    });

    // T8 — Blockquote
    test('T8: blockquote', () => {
        const result = markdownToEntitiesTelegram('> quoted line');
        assert.strictEqual(result.text, 'quoted line');
        assert.deepStrictEqual(result.entities, [
            { _: 'messageEntityBlockquote', offset: 0, length: 11 },
        ] as TelegramEntity[]);
    });

    // T9 — Mixed bold + italic in the same paragraph
    test('T9: mixed bold and italic in same paragraph', () => {
        const result = markdownToEntitiesTelegram('**bold** and *italic*');
        assert.strictEqual(result.text, 'bold and italic');
        assert.deepStrictEqual(result.entities, [
            { _: 'messageEntityBold',   offset: 0, length: 4 },
            { _: 'messageEntityItalic', offset: 9, length: 6 },
        ] as TelegramEntity[]);
    });

    // T10 — Bold link (nested entities) — sort by _ to be order-independent
    test('T10: bold link (nested entities)', () => {
        const result = markdownToEntitiesTelegram('**[click here](https://example.com)**');
        assert.strictEqual(result.text, 'click here');
        const sorted = [...result.entities].sort((a, b) => a._.localeCompare(b._));
        assert.deepStrictEqual(sorted, [
            { _: 'messageEntityBold',    offset: 0, length: 10 },
            { _: 'messageEntityTextUrl', offset: 0, length: 10, url: 'https://example.com' },
        ] as TelegramEntity[]);
    });

    // T11 — Heading stripped to plain text, no entity
    test('T11: heading stripped to plain text, no entity', () => {
        const result = markdownToEntitiesTelegram('# My Title');
        assert.strictEqual(result.text, 'My Title');
        assert.deepStrictEqual(result.entities, []);
    });

    // T12 — Plain text, no entities
    test('T12: plain text without Markdown', () => {
        const result = markdownToEntitiesTelegram('Just plain text.');
        assert.strictEqual(result.text, 'Just plain text.');
        assert.deepStrictEqual(result.entities, []);
    });

    // T13 — Empty string
    test('T13: empty string input', () => {
        const result = markdownToEntitiesTelegram('');
        assert.strictEqual(result.text, '');
        assert.deepStrictEqual(result.entities, []);
    });

    // T14 — Hard line break
    test('T14: hard line break produces newline in plain text', () => {
        // Markdown hard line break: backslash before newline
        const result = markdownToEntitiesTelegram('line one\\\nline two');
        assert.ok(result.text.includes('\n'), `Expected newline in: ${JSON.stringify(result.text)}`);
    });

    // T15 — Full integration smoke test
    test('T15: full combined message smoke test', () => {
        const input =
            '**Hello** *world*! Visit [our site](https://example.com).\n' +
            'Use `npm install` and:\n' +
            '```bash\nnpm run build\n```';

        const result = markdownToEntitiesTelegram(input);

        // Verify plain text contains all expected fragments
        assert.ok(result.text.includes('Hello'),       'missing: Hello');
        assert.ok(result.text.includes('world'),       'missing: world');
        assert.ok(result.text.includes('our site'),    'missing: our site');
        assert.ok(result.text.includes('npm install'), 'missing: npm install');
        assert.ok(result.text.includes('npm run build'), 'missing: npm run build');

        // Compute exact offsets from the actual plain text produced
        const boldOffset    = result.text.indexOf('Hello');
        const italicOffset  = result.text.indexOf('world');
        const urlOffset     = result.text.indexOf('our site');
        const codeOffset    = result.text.indexOf('npm install');
        const preOffset     = result.text.indexOf('npm run build');

        // Assert that all 5 entity types are present with correct properties
        const byType = (type: TelegramEntity['_']) =>
            result.entities.find(e => e._ === type);

        const bold = byType('messageEntityBold');
        assert.ok(bold, 'missing messageEntityBold');
        assert.strictEqual(bold!.offset, boldOffset);
        assert.strictEqual(bold!.length, 'Hello'.length);

        const italic = byType('messageEntityItalic');
        assert.ok(italic, 'missing messageEntityItalic');
        assert.strictEqual(italic!.offset, italicOffset);
        assert.strictEqual(italic!.length, 'world'.length);

        const url = byType('messageEntityTextUrl');
        assert.ok(url, 'missing messageEntityTextUrl');
        assert.strictEqual(url!.offset, urlOffset);
        assert.strictEqual(url!.length, 'our site'.length);
        assert.strictEqual(url!.url, 'https://example.com');

        const code = byType('messageEntityCode');
        assert.ok(code, 'missing messageEntityCode');
        assert.strictEqual(code!.offset, codeOffset);
        assert.strictEqual(code!.length, 'npm install'.length);

        const pre = byType('messageEntityPre');
        assert.ok(pre, 'missing messageEntityPre');
        assert.strictEqual(pre!.offset, preOffset);
        assert.strictEqual(pre!.length, 'npm run build'.length);
        assert.strictEqual(pre!.language, 'bash');
    });

    // T16 — Check Line Breaks on Text
    // Verifies that newlines are preserved between block-level elements
    // (heading, paragraph, code block, list) and that entity offsets are
    // computed against the text that includes those newlines.
    // Failures here indicate that the implementation is dropping newlines
    // between top-level blocks when building the plain-text output.
    test('T16: Check Line Breaks on Text — newlines preserved between blocks and entities', () => {
        const md = [
            '## Title text (exampletext.py)',
            'Code example description',
            '```python',
            '"""Commented text"""',
            'import os',
            'import sys',
            'def main():',
            '    contents = []',
            'if __name__ == "__main__":',
            '    main()',
            '```',
            '---',
            '### Conclusions',
            '- **Inputs:** text imput for example.',
            '- **Output:** generate text output example.',
        ].join('\n');

        const result = markdownToEntitiesTelegram(md);

        // 1. Heading should be followed by a newline before the next paragraph
        assert.ok(
            result.text.includes('Title text (exampletext.py)\nCode example description'),
            `Missing \\n between heading and paragraph.\nActual text: ${JSON.stringify(result.text)}`
        );

        // 2. Paragraph should be followed by a newline before the code block content
        assert.ok(
            result.text.includes('Code example description\n"""Commented text"""'),
            `Missing \\n between paragraph and code block.\nActual text: ${JSON.stringify(result.text)}`
        );

        // 3. Code block should be followed by a newline before the next heading
        assert.ok(
            result.text.includes('    main()\nConclusions'),
            `Missing \\n between code block and Conclusions heading.\nActual text: ${JSON.stringify(result.text)}`
        );

        // 4. "Conclusions" heading should be followed by a newline before the list
        assert.ok(
            result.text.includes('Conclusions\nInputs:'),
            `Missing \\n between Conclusions heading and list items.\nActual text: ${JSON.stringify(result.text)}`
        );

        // 5. List items should be separated by a newline
        assert.ok(
            result.text.includes('example.\nOutput:'),
            `Missing \\n between list items.\nActual text: ${JSON.stringify(result.text)}`
        );

        // 6. PRE entity must exist, cover the full code block, and carry the language tag
        const preEntity = result.entities.find(e => e._ === 'messageEntityPre');
        assert.ok(preEntity, 'Missing messageEntityPre entity');
        assert.strictEqual(preEntity!.language, 'python');
        const codeSlice = result.text.slice(preEntity!.offset, preEntity!.offset + preEntity!.length);
        assert.ok(
            codeSlice.startsWith('"""Commented text"""'),
            `Code block should start with '"""Commented text"""', got: ${JSON.stringify(codeSlice)}`
        );
        assert.ok(
            codeSlice.endsWith('    main()'),
            `Code block should end with '    main()', got: ${JSON.stringify(codeSlice)}`
        );

        // 7. Two bold entities must exist: "Inputs:" and "Output:"
        const boldEntities = result.entities.filter(e => e._ === 'messageEntityBold');
        assert.strictEqual(boldEntities.length, 2, `Expected 2 bold entities, got ${boldEntities.length}`);
        const boldTexts = boldEntities.map(e => result.text.slice(e.offset, e.offset + e.length));
        assert.ok(boldTexts.includes('Inputs:'), `Expected bold "Inputs:", got: ${JSON.stringify(boldTexts)}`);
        assert.ok(boldTexts.includes('Output:'), `Expected bold "Output:", got: ${JSON.stringify(boldTexts)}`);
    });

    // T17 — Empty-label link: [](url) must not drop the URL from plain text
    test('T17: empty-label link uses URL as display text', () => {
        const url = 'file:///c%3A/workspace/projects/AURORA%20PHOENIX/tasks/0042-prd-crimson-falcon.md#3-7';
        const result = markdownToEntitiesTelegram(`Read [](${url}), lines 1 to 100`);

        // The URL must appear verbatim in the plain text (not silently dropped)
        assert.ok(
            result.text.includes(url),
            `URL should appear in plain text, got: ${JSON.stringify(result.text)}`
        );
        assert.strictEqual(
            result.text,
            `Read ${url}, lines 1 to 100`,
        );

        // A text_link entity must exist pointing at the URL
        const entity = result.entities.find(e => e._ === 'messageEntityTextUrl');
        assert.ok(entity, 'Missing messageEntityTextUrl entity');
        assert.strictEqual(entity!.url, url);
        assert.strictEqual(entity!.offset, 'Read '.length);
        assert.strictEqual(entity!.length, url.length);
    });
});
