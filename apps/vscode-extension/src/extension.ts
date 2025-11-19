import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "oss-ai-agent-tool-vscode" is now active!');

    let disposable = vscode.commands.registerCommand('oss-ai-agent.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from OSS AI Agent Tool!');
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}

