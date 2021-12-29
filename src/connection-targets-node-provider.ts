// implements tree view UI for connected clients
import * as path from 'path';
import * as vscode from 'vscode';
import { getActiveToolchain } from './extension';

export class ConnectionTargetsNodeProvider implements vscode.TreeDataProvider<ConnectionTargetTreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<ConnectionTargetTreeItem | undefined | void> = new vscode.EventEmitter<ConnectionTargetTreeItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<ConnectionTargetTreeItem | undefined | void> = this._onDidChangeTreeData.event;

	getTreeItem(element: ConnectionTargetTreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element;
	}
	async getChildren(element?: ConnectionTargetTreeItem): Promise<ConnectionTargetTreeItem[] | undefined> {
		const toolchain = getActiveToolchain();
		if (!toolchain) {
			return;
		}

		const config = await toolchain.config();
		const treeItems: ConnectionTargetTreeItem[] = [];
		// eslint-disable-next-line @typescript-eslint/naming-convention
		config.Targets.forEach((target: { Name: string; Platform: any; Ip: any; Port: any; }) => {
			const newItem = new ConnectionTargetTreeItem( target.Name, target.Platform, target.Ip, target.Port );
			treeItems.push(newItem);
		});
		return treeItems;
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}
}

export class ConnectionTargetTreeItem extends vscode.TreeItem {
	constructor(
		public readonly name: string,
		public readonly platform: string,
		public readonly ip: string,
		public readonly port: number,
	) {
		super(`${name} ${platform} ${ip}:${port}`, vscode.TreeItemCollapsibleState.None);
		//this.tooltip = new vscode.MarkdownString(`**Platform**: ${platform}\n\n**IP**: ${ip}\n\n**Port**: ${port}`);
	}

	contextValue = 'connection-target';
}