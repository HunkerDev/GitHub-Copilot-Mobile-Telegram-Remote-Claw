import * as vscode from 'vscode';

export class RemoteClawStatusBar {
    private readonly item: vscode.StatusBarItem;

    constructor() {
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.item.command = 'remclaw.openStatusMenu';
        this.setConnecting();
        this.item.show();
    }

    setConnecting(): void {
        this.item.text = '🦞 Remote Claw: Connecting';
        this.item.tooltip = 'Telegram Remote Claw — Connecting…';
    }

    setConnected(): void {
        this.item.text = '🦞 Remote Claw: Connected';
        this.item.tooltip = 'Telegram Remote Claw — Connected. Click for options.';
    }

    setDisconnected(): void {
        this.item.text = '🦞 Remote Claw: Disconnected';
        this.item.tooltip = 'Telegram Remote Claw — Disconnected. Click to reconnect.';
    }

    setReconnecting(): void {
        this.item.text = '🦞 Remote Claw: Reconnecting';
        this.item.tooltip = 'Telegram Remote Claw — Reconnecting…';
    }

    dispose(): void {
        this.item.dispose();
    }
}

