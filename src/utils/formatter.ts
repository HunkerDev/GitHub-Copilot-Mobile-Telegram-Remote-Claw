import { MessageFormat } from '../config/settings';
import { marked, type TokensList, type Token, type Tokens } from 'marked';

/**
 * T2.4 — Splits a long message into chunks of at most `maxLen` characters.
 * Prefers to break at paragraph → newline → word boundaries; never mid-word.
 * When multiple parts are produced each chunk is prefixed with [Part N/M].
 */
export function splitMessage(text: string, maxLen = 4096): string[] {
    if (text.length <= maxLen) {
        return [text];
    }

    const parts: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            parts.push(remaining);
            break;
        }

        const slice = remaining.slice(0, maxLen);
        let splitAt: number;

        // Prefer paragraph boundary (double newline) in the latter half of the slice
        const paraIdx = slice.lastIndexOf('\n\n');
        if (paraIdx > maxLen * 0.4) {
            splitAt = paraIdx + 2;
        } else {
            // Fall back to single newline
            const newlineIdx = slice.lastIndexOf('\n');
            if (newlineIdx > maxLen * 0.2) {
                splitAt = newlineIdx + 1;
            } else {
                // Fall back to word boundary (space)
                const spaceIdx = slice.lastIndexOf(' ');
                if (spaceIdx > 0) {
                    splitAt = spaceIdx + 1;
                } else {
                    // Hard split — no natural boundary found (e.g. very long URL)
                    splitAt = maxLen;
                }
            }
        }

        parts.push(remaining.slice(0, splitAt).trimEnd());
        remaining = remaining.slice(splitAt).trimStart();
    }

    if (parts.length <= 1) {
        return parts;
    }

    // Inject [Part N/M] prefix on each chunk
    const total = parts.length;
    return parts.map((part, i) => `[Part ${i + 1}/${total}]\n${part}`);
}

/**
 * T2.4 — Wraps `text` in a fenced code block.
 * Uses Markdown triple-backtick syntax or HTML <pre><code> depending on `format`.
 */
export function formatCodeBlock(
    text: string,
    lang?: string,
    format: MessageFormat = 'markdown',
): string {
    if (format === 'html') {
        return `<pre><code>${escapeHtml(text)}</code></pre>`;
    }
    const langTag = lang ?? '';
    return `\`\`\`${langTag}\n${text}\n\`\`\``;
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Scans `text` for Markdown tables (with or without a header row) and converts
 * each one to a card-style block safe for Telegram's Markdown v1 parser.
 *
 * Rules applied:
 *   - If line 2 is a separator row (|---|), line 1 is treated as the header.
 *   - If no separator is present, all rows are treated as data (no header assumed).
 *   - Header cells are rendered bold, joined with  •
 *   - Each data row becomes:  ▸ *FirstCol* — Col2 — Col3 …
 *   - After conversion, ALL remaining | characters are stripped from the full text.
 */
export function convertTablesToCards(text: string): string {
    // Parse a pipe-delimited row into trimmed, non-empty cell strings.
    const parseRow = (line: string): string[] =>
        line.split('|').slice(1, -1).map(c => c.trim()).filter(c => c.length > 0);

    // A separator row contains only dashes, colons, and spaces in each cell.
    const isSeparatorLine = (line: string): boolean => {
        const cells = line.split('|').slice(1, -1);
        return cells.length > 0 && cells.every(c => /^[\s:]*-+[\s:]*$/.test(c));
    };

    // Match any block of 2+ consecutive lines that start with |
    const TABLE_BLOCK_RE = /^(?:\|[^\n]+\n?){2,}/gm;

    let result = text.replace(TABLE_BLOCK_RE, (match) => {
        const lines = match.split('\n').filter(l => l.trim().startsWith('|'));
        if (lines.length === 0) { return match; }

        // If line[1] is a separator → line[0] is the header row
        const hasHeader = lines.length >= 2 && isSeparatorLine(lines[1]);

        let headerCells: string[] = [];
        let dataLines: string[];

        if (hasHeader) {
            headerCells = parseRow(lines[0]);
            dataLines = lines.slice(2);   // skip header + separator
        } else {
            dataLines = lines;            // all rows are data, no header
        }

        const parts: string[] = [];

        if (headerCells.length > 0) {
            // Bold header cells separated by •
            parts.push(`*${headerCells.join(' • ')}*`);
        }

        for (const row of dataLines.map(parseRow)) {
            if (row.length === 0) { continue; }
            const [first, ...rest] = row;
            // First column is bold; remaining columns are plain, separated by —
            const cardLine = rest.length > 0
                ? `▸ *${first}* — ${rest.join(' — ')}`
                : `▸ *${first}*`;
            parts.push(cardLine);
        }

        return parts.join('\n') + '\n';
    });

    // Strip every remaining | character from the full output (also catches any
    // stray pipes that appear outside table blocks).
    result = result.replace(/\|/g, '');

    return result;
}

// ---------------------------------------------------------------------------
// Telegram entity types
// ---------------------------------------------------------------------------

/** All entity type strings produced by the Telegram entity parser. */
export type TelegramEntityType =
    | 'messageEntityBold'
    | 'messageEntityItalic'
    | 'messageEntityStrike'
    | 'messageEntityCode'
    | 'messageEntityPre'
    | 'messageEntityTextUrl'
    | 'messageEntityBlockquote';

/** A single formatting entity for the Telegram Bot API. */
export interface TelegramEntity {
    /** Entity type — mirrors Telegram's MessageEntity. */
    _: TelegramEntityType;
    /** Start position in the plain text, counted in UTF-16 code units. */
    offset: number;
    /** Length of the span, counted in UTF-16 code units. */
    length: number;
    /** Only for 'messageEntityTextUrl' — the hyperlink target. */
    url?: string;
    /** Only for 'messageEntityPre' — the programming language hint. */
    language?: string;
}

/** Return type of markdownToEntitiesTelegram(). */
export interface TelegramParseResult {
    /** Plain text version — all Markdown syntax stripped. */
    text: string;
    /** Ordered array of formatting entities for the Telegram API. */
    entities: TelegramEntity[];
}

/**
 * Returns the number of UTF-16 code units in `str`.
 * Telegram counts all entity offsets and lengths in UTF-16 code units,
 * which equals JavaScript's native String.prototype.length.
 */
export function getUtf16Length(str: string): number {
    return str.length;
}

/**
 * Converts a GFM Markdown string into a plain-text string plus a structured
 * array of Telegram MessageEntity objects, eliminating the need for parse_mode
 * and all special-character escaping.
 */
export function markdownToEntitiesTelegram(markdownText: string): TelegramParseResult {
    const tokens = marked.lexer(markdownText, { gfm: true });
    let plainText = '';
    const entities: TelegramEntity[] = [];

    function processTokens(tokenList: TokensList | Token[]): void {
        if (!tokenList) {
            return;
        }
        // marked.lexer returns TokensList, which is an array with a 'links' property.
        // We only want to iterate over the array part.
        const iterableTokens = Array.isArray(tokenList) ? tokenList : [];
        // Block-level token types that should be separated by a newline in the
        // plain-text output when they appear consecutively in the same list.
        const BLOCK_TYPES = ['paragraph', 'heading', 'code', 'blockquote', 'list'];

        for (let i = 0; i < iterableTokens.length; i++) {
            const token = iterableTokens[i];
            const startOffset = getUtf16Length(plainText);
            let entityType: TelegramEntityType | null = null;
            const entityProps: { url?: string; language?: string } = {};

            switch (token.type) {
                case 'paragraph':
                    processTokens((token as Tokens.Paragraph).tokens);
                    break;
                case 'strong':
                    entityType = 'messageEntityBold';
                    processTokens((token as Tokens.Strong).tokens);
                    break;
                case 'em':
                    entityType = 'messageEntityItalic';
                    processTokens((token as Tokens.Em).tokens);
                    break;
                case 'del':
                    entityType = 'messageEntityStrike';
                    processTokens((token as Tokens.Del).tokens);
                    break;
                case 'codespan':
                    entityType = 'messageEntityCode';
                    plainText += (token as Tokens.Codespan).text;
                    break;
                case 'code': {
                    // Fenced code block
                    entityType = 'messageEntityPre';
                    const codeToken = token as Tokens.Code;
                    // Ensure language is always set, even if empty
                    entityProps.language = codeToken.lang?.trim() || '';
                    let codeText = codeToken.text;
                    // Normalize line endings from marked's output
                    codeText = codeText.replace(/\r\n/g, '\n');
                    codeText = codeText.replace(/\r/g, '\n');
                    plainText += codeText;
                    break;
                }
                case 'link': {
                    entityType = 'messageEntityTextUrl';
                    const linkToken = token as Tokens.Link;
                    entityProps.url = linkToken.href;
                    if (linkToken.tokens && linkToken.tokens.length > 0) {
                        processTokens(linkToken.tokens);
                    } else {
                        // Empty display text (e.g. [](url)) — use the URL as the label
                        // so the text span exists and the entity is not silently dropped.
                        plainText += linkToken.href;
                    }
                    break;
                }
                case 'blockquote': {
                    entityType = 'messageEntityBlockquote';
                    const bqToken = token as Tokens.Blockquote;
                    if (bqToken.tokens) {
                        const childTokens = bqToken.tokens;
                        childTokens.forEach((childToken: Token, index: number) => {
                            const textBeforeChild = plainText;
                            processTokens([childToken]);
                            if (
                                plainText.length > textBeforeChild.length &&
                                index < childTokens.length - 1
                            ) {
                                const nextToken = childTokens[index + 1];
                                if (
                                    nextToken &&
                                    ['paragraph', 'list', 'blockquote', 'code', 'heading'].includes(
                                        nextToken.type,
                                    )
                                ) {
                                    plainText += '\n';
                                }
                            }
                        });
                    }
                    break;
                }
                case 'list': {
                    const listToken = token as Tokens.List;
                    listToken.items.forEach((item: Tokens.ListItem, index: number) => {
                        const textBeforeItem = plainText;
                        processTokens(item.tokens);
                        if (
                            plainText.length > textBeforeItem.length &&
                            index < listToken.items.length - 1
                        ) {
                            plainText += '\n';
                        }
                    });
                    break;
                }
                case 'heading':
                    processTokens((token as Tokens.Heading).tokens);
                    break;
                case 'hr':
                    break;
                case 'br':
                    plainText += '\n';
                    break;
                case 'text': {
                    const textToken = token as Tokens.Text;
                    if (textToken.tokens) {
                        processTokens(textToken.tokens);
                    } else {
                        plainText += textToken.text;
                    }
                    break;
                }
                case 'html':
                    break;
                case 'space':
                    break;
                default: {
                    // Attempt to handle generic tokens with 'tokens' or 'text' properties
                    const genericToken = token as { tokens?: Token[]; text?: string };
                    if (genericToken.tokens && Array.isArray(genericToken.tokens)) {
                        processTokens(genericToken.tokens);
                    } else if (typeof genericToken.text === 'string') {
                        plainText += genericToken.text;
                    }
                    break;
                }
            }

            if (entityType) {
                const currentTextLength = getUtf16Length(plainText) - startOffset;
                if (currentTextLength > 0) {
                    entities.push({
                        _: entityType,
                        offset: startOffset,
                        length: currentTextLength,
                        ...entityProps,
                    });
                }
            }

            // Insert a single '\n' separator between consecutive block-level tokens
            // when the current token produced text and is not the last in the list.
            // This mirrors the line-break that existed in the original markdown source.
            if (
                BLOCK_TYPES.includes(token.type) &&
                i < iterableTokens.length - 1 &&
                getUtf16Length(plainText) > startOffset &&
                !plainText.endsWith('\n')
            ) {
                plainText += '\n';
            }
        }
    }

    processTokens(tokens);
    return { text: plainText, entities };
}

/**
 * Splits a plain-text string and its associated Telegram entity array into
 * chunks of at most `maxLen` UTF-16 code units, preserving and re-offsetting
 * entities per chunk. Entity spans that cross a chunk boundary are truncated
 * to fit within the chunk.
 */
export function splitTelegramEntities(
    plainText: string,
    entities: TelegramEntity[],
    maxLen = 4096,
): TelegramParseResult[] {
    if (getUtf16Length(plainText) <= maxLen) {
        return [{ text: plainText, entities }];
    }

    // Collect raw chunks with their absolute start/end positions in plainText.
    const rawChunks: Array<{ text: string; start: number; end: number }> = [];
    let remaining = plainText;
    let globalOffset = 0;

    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            rawChunks.push({ text: remaining, start: globalOffset, end: globalOffset + remaining.length });
            break;
        }

        const slice = remaining.slice(0, maxLen);
        let splitAt: number;

        const paraIdx = slice.lastIndexOf('\n\n');
        if (paraIdx > maxLen * 0.4) {
            splitAt = paraIdx + 2;
        } else {
            const newlineIdx = slice.lastIndexOf('\n');
            if (newlineIdx > maxLen * 0.2) {
                splitAt = newlineIdx + 1;
            } else {
                const spaceIdx = slice.lastIndexOf(' ');
                splitAt = spaceIdx > 0 ? spaceIdx + 1 : maxLen;
            }
        }

        const chunkText = remaining.slice(0, splitAt).trimEnd();
        rawChunks.push({ text: chunkText, start: globalOffset, end: globalOffset + chunkText.length });

        const nextRaw = remaining.slice(splitAt);
        const nextTrimmed = nextRaw.trimStart();
        globalOffset += splitAt + (nextRaw.length - nextTrimmed.length);
        remaining = nextTrimmed;
    }

    if (rawChunks.length <= 1) {
        return [{ text: plainText, entities }];
    }

    return rawChunks.map((chunk) => {
        const { start: chunkStart, end: chunkEnd } = chunk;

        const chunkEntities = entities
            .filter(e => e.offset < chunkEnd && e.offset + e.length > chunkStart)
            .map(e => {
                const entityStart = Math.max(e.offset, chunkStart);
                const entityEnd   = Math.min(e.offset + e.length, chunkEnd);
                const adjusted: TelegramEntity = {
                    _:      e._,
                    offset: entityStart - chunkStart,
                    length: entityEnd - entityStart,
                };
                if (e.url      !== undefined) { adjusted.url      = e.url; }
                if (e.language !== undefined) { adjusted.language = e.language; }
                return adjusted;
            })
            .filter(e => e.length > 0);

        return { text: chunk.text, entities: chunkEntities };
    });
}
