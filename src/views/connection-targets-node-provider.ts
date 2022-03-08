// implements tree view UI for connected clients
import * as vscode from 'vscode';
import { getActiveToolchain } from '../extension';
import { formatCommand } from '../utils/vscode';

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
		const treeItems: ConnectionTargetTreeItem[] = config.Targets.map((target: { Name: string; Platform: any; Ip: any; Port: any; }) => {
			return new ConnectionTargetTreeItem(target.Name, target.Platform, target.Ip, target.Port);
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
		super({
			label: `${name} [${platform}]`,
			//highlights: [[0, name.length]]
		}, vscode.TreeItemCollapsibleState.None);
		this.tooltip = new vscode.MarkdownString();
		this.tooltip.appendCodeblock(name);
		this.tooltip.appendMarkdown([
			`---`,
			`**Address**: \`${ip}:${port}\`  `,
			`**Platform**: ${platform}`,
		].join('\n'));
		this.tooltip.isTrusted = true;
		this.tooltip.supportThemeIcons = true;
		this.command = {
			title: 'Connect to All',
			command: 'fatshark-code-assist.stingrayConnect',
			arguments: [ this ],
		};
	}

	contextValue = 'connection-target';
	iconPath = new vscode.ThemeIcon('vm');
}