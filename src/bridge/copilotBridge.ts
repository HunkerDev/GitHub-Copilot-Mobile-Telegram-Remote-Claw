import * as vscode from 'vscode';

const MAX_CONTEXT_CHARS = 8000;

/**
 * T2.5 — Direct LM bridge used by Telegram slash-command handlers.
 * Calls the Copilot language model programmatically without opening the VS Code
 * Chat panel, and prepends the currently-active editor file as context.
 */
export class CopilotBridge {
    /**
     * Asks Copilot a question using the full agent loop with all registered VS Code tools.
     * Injects the active-editor file content as context (truncated to 8 000 chars).
     * Runs tool calls (file read, workspace search, terminal, etc.) automatically until
     * the model stops requesting tools or maxIterations is reached.
     */
    async askQuestion(question: string): Promise<string> {
        const copilotExt = vscode.extensions.getExtension('github.copilot-chat');
        if (!copilotExt) {
            throw new Error('GitHub Copilot Chat extension is not installed or not enabled.');
        }

        // Try preferred models in order; fall back to any available Copilot model
        let models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'claude-sonnet-4.6' });
        if (!models || models.length === 0) {
            models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'claude-sonnet-4.5' });
        }
        if (!models || models.length === 0) {
            models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
        }
        if (!models || models.length === 0) {
            models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        }
        if (!models || models.length === 0) {
            throw new Error('No Copilot language model is available. Ensure GitHub Copilot is active.');
        }

        const model = models[0];
        console.log(`[RemoteClaw] Using model: ${model.name} (${model.family})`);

        const messages: vscode.LanguageModelChatMessage[] = [];

        // Inject active-file workspace context (T2.5)
        const contextMsg = this.buildContextMessage();
        if (contextMsg) {
            messages.push(vscode.LanguageModelChatMessage.User(contextMsg));
        }
        messages.push(vscode.LanguageModelChatMessage.User(question));

        // Gather all registered LM tools (file read, workspace search, terminal, etc.)
        const tools = [...vscode.lm.tools];
        console.log(`[RemoteClaw] Tools available: ${tools.map(t => t.name).join(', ') || 'none'}`);

        const tokenSource = new vscode.CancellationTokenSource();
        try {
            return await this.runAgentLoop(model, messages, tools, tokenSource.token);
        } finally {
            tokenSource.dispose();
        }
    }

    /**
     * Runs the agent loop: sends messages to the model, executes any tool calls,
     * appends results, and repeats until no more tool calls or maxIterations reached.
     */
    private async runAgentLoop(
        model: vscode.LanguageModelChat,
        messages: vscode.LanguageModelChatMessage[],
        tools: vscode.LanguageModelToolInformation[],
        token: vscode.CancellationToken,
        maxIterations = 10,
    ): Promise<string> {
        let fullText = '';

        for (let iter = 0; iter < maxIterations; iter++) {
            const response = await model.sendRequest(messages, { tools }, token);

            const toolCalls: vscode.LanguageModelToolCallPart[] = [];
            let iterText = '';

            for await (const part of response.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    iterText += part.value;
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    console.log(`[RemoteClaw] Tool call: ${part.name}`);
                    toolCalls.push(part);
                }
            }

            if (iterText) {
                fullText += iterText;
            }

            // No tool calls — model is done
            if (toolCalls.length === 0) {
                break;
            }

            // Add assistant turn (text + tool calls) to history
            const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
            if (iterText) { assistantParts.push(new vscode.LanguageModelTextPart(iterText)); }
            assistantParts.push(...toolCalls);
            messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

            // Execute each tool call and collect results
            const toolResultParts: vscode.LanguageModelToolResultPart[] = [];
            for (const toolCall of toolCalls) {
                try {
                    const result = await vscode.lm.invokeTool(
                        toolCall.name,
                        { input: toolCall.input, toolInvocationToken: undefined },
                        token,
                    );
                    toolResultParts.push(
                        new vscode.LanguageModelToolResultPart(toolCall.callId, result.content),
                    );
                } catch (err) {
                    console.error(`[RemoteClaw] Tool '${toolCall.name}' failed:`, err);
                    toolResultParts.push(
                        new vscode.LanguageModelToolResultPart(toolCall.callId, [
                            new vscode.LanguageModelTextPart(`Tool execution failed: ${String(err)}`),
                        ]),
                    );
                }
            }

            // Add tool results to messages for the next iteration
            messages.push(vscode.LanguageModelChatMessage.User(toolResultParts));
        }

        return fullText;
    }

    /**
     * Reads the active editor document and returns a formatted context string,
     * or null when no editor is open.  Content is truncated to MAX_CONTEXT_CHARS.
     */
    private buildContextMessage(): string | null {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return null;
        }
        const doc = editor.document;
        const filename = doc.fileName.replace(/\\/g, '/').split('/').pop() ?? doc.fileName;
        const content = doc.getText().slice(0, MAX_CONTEXT_CHARS);
        return `Active file: \`${filename}\`\n\`\`\`\n${content}\n\`\`\``;
    }
}

/**
 * T2.1 / T2.2 — Creates and registers the @remoteclaw VS Code Chat Participant.
 *
 * The handler:
 *  1. Selects a Copilot GPT-4o language model.
 *  2. Streams the response, forwarding text fragments to the VS Code Chat panel.
 *  3. Buffers all fragments; after the stream completes, calls `telegramSendCallback`
 *     with the full text (never partial chunks).
 *  4. On any LM error, sends a safe error message to Telegram via the callback.
 *
 * @param telegramSendCallback  Async function that delivers a string to the Telegram owner.
 * @returns A disposable that unregisters the chat participant on dispose.
 */
export function createCopilotBridge(
    telegramSendCallback: (text: string) => Promise<void>,
): vscode.Disposable {
    const participant = vscode.chat.createChatParticipant(
        'telegram-remote-claw.remoteclaw',
        async (
            request: vscode.ChatRequest,
            context: vscode.ChatContext,
            response: vscode.ChatResponseStream,
            token: vscode.CancellationToken,
        ): Promise<void> => {
            console.log('[RemoteClaw] >>> ENTERED createCopilotBridge handler. prompt:', request.prompt);
            const copilotExt = vscode.extensions.getExtension('github.copilot-chat');
            if (!copilotExt) {
                const msg = '⚠️ GitHub Copilot Chat extension is not installed or not enabled.';
                response.markdown(msg);
                await telegramSendCallback(msg);
                return;
            }

            // Log all available models so we can identify the correct family string
            const allModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            console.log('[RemoteClaw] Available models:', allModels.map(m => `name="${m.name}" family="${m.family}" id="${m.id}"`).join(' | '));

            // Select best available model
            let models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'claude-sonnet-4.6' });
            if (!models || models.length === 0) {
                models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'claude-sonnet-4.5' });
            }
            if (!models || models.length === 0) {
                models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
            }
            if (!models || models.length === 0) {
                models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            }
            if (!models || models.length === 0) {
                const msg = '⚠️ No Copilot language model is available.';
                response.markdown(msg);
                await telegramSendCallback(msg);
                return;
            }

            const model = models[0];
            console.log(`[RemoteClaw] Participant using model: ${model.name}`);

            const tools = [...vscode.lm.tools];
            console.log(`[RemoteClaw] Participant tools: ${tools.map(t => t.name).join(', ') || 'none'}`);

            // Inject conversation history so the model understands previous exchanges
            const messages: vscode.LanguageModelChatMessage[] = [];
            for (const turn of context.history) {
                if (turn instanceof vscode.ChatRequestTurn) {
                    messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
                } else if (turn instanceof vscode.ChatResponseTurn) {
                    const text = turn.response
                        .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
                        .map(p => p.value.value)
                        .join('');
                    if (text) {
                        messages.push(vscode.LanguageModelChatMessage.Assistant(text));
                    }
                }
            }
            messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

            try {
                let fullText = '';
                const MAX_ITER = 10;

                for (let iter = 0; iter < MAX_ITER; iter++) {
                    const chatResponse = await model.sendRequest(
                        messages,
                        { tools: tools.length > 0 ? tools : undefined },
                        token,
                    );

                    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
                    let iterText = '';
                    let lineBuffer = '';

                    for await (const part of chatResponse.stream) {
                        if (part instanceof vscode.LanguageModelTextPart) {
                            iterText += part.value;
                            response.markdown(part.value); // stream to VS Code Chat panel
                            lineBuffer += part.value;

                            // Send every complete line (ending with \n) to Telegram
                            let newlineIdx: number;
                            while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
                                const line = lineBuffer.slice(0, newlineIdx).trim();
                                lineBuffer = lineBuffer.slice(newlineIdx + 1);
                                if (line) {
                                    try {
                                        await telegramSendCallback(line);
                                    } catch (streamErr) {
                                        console.error('[RemoteClaw] Streaming line to Telegram failed:', streamErr);
                                    }
                                }
                            }
                        } else if (part instanceof vscode.LanguageModelToolCallPart) {
                            console.log(`[RemoteClaw] Tool call: ${part.name}`);
                            toolCalls.push(part);
                        }
                    }

                    // Send any remaining text that didn't end with a newline
                    const remainingLine = lineBuffer.trim();
                    if (remainingLine) {
                        try {
                            await telegramSendCallback(remainingLine);
                        } catch (streamErr) {
                            console.error('[RemoteClaw] Streaming final line to Telegram failed:', streamErr);
                        }
                    }

                    if (iterText) { fullText += iterText; }

                    // No tool calls — model is done
                    if (toolCalls.length === 0) { break; }

                    // Add assistant turn to history
                    const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
                    if (iterText) { assistantParts.push(new vscode.LanguageModelTextPart(iterText)); }
                    assistantParts.push(...toolCalls);
                    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

                    // Execute each tool — pass toolInvocationToken for full Copilot context
                    const toolResultParts: vscode.LanguageModelToolResultPart[] = [];
                    for (const toolCall of toolCalls) {
                        try {
                            const result = await vscode.lm.invokeTool(
                                toolCall.name,
                                {
                                    input: toolCall.input,
                                    toolInvocationToken: request.toolInvocationToken,
                                },
                                token,
                            );
                            toolResultParts.push(
                                new vscode.LanguageModelToolResultPart(toolCall.callId, result.content),
                            );
                        } catch (toolErr) {
                            console.error(`[RemoteClaw] Tool '${toolCall.name}' error:`, toolErr);
                            toolResultParts.push(
                                new vscode.LanguageModelToolResultPart(toolCall.callId, [
                                    new vscode.LanguageModelTextPart(`Tool failed: ${String(toolErr)}`),
                                ]),
                            );
                        }
                    }
                    messages.push(vscode.LanguageModelChatMessage.User(toolResultParts));
                }

                if (fullText.trim()) {
                    console.log('[RemoteClaw] Streaming complete. Total chars sent:', fullText.length);
                }
            } catch (err: unknown) {
                const errMsg = err instanceof Error ? err.message : String(err);
                const safeMsg = `❌ Copilot request failed: ${errMsg}`;
                response.markdown(safeMsg);
                await telegramSendCallback(safeMsg);
            }
        },
    );

    return participant;
}
