// implements tree view UI for connected clients
import * as vscode from 'vscode';
import { getActiveToolchain } from '../extension';
import type { ToolchainConfig, ToolchainConfigRunSet, ToolchainConfigTarget } from '../utils/stingray-config';

export class LaunchTargetsNodeProvider implements vscode.TreeDataProvider<LaunchSetTreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<LaunchSetTreeItem | undefined | void> = new vscode.EventEmitter<LaunchSetTreeItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<LaunchSetTreeItem | undefined | void> = this._onDidChangeTreeData.event;

	getTreeItem(element: LaunchSetTreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element;
	}
	async getChildren(element?: LaunchSetTreeItem): Promise<LaunchSetTreeItem[] | undefined> {
		const toolchain = getActiveToolchain();
		if (!toolchain) {
			return;
		}

		const config = await toolchain.config();

		let treeItems: LaunchSetTreeItem[] = config.RunSets.map((runSet) => {
			return new LaunchSetTreeItem(runSet, config);
		});
		return treeItems;
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}
}

export class LaunchSetTreeItem extends vscode.TreeItem {
	constructor(
		public readonly runSet: ToolchainConfigRunSet,
		public readonly config: ToolchainConfig,
	) {
		super(runSet.Name, vscode.TreeItemCollapsibleState.None);

		//const launchUri = formatCommand('fatshark-code-assist.stingrayLaunch', runSet.Id);
		const tooltip = new vscode.MarkdownString();
		tooltip.isTrusted = true;
		runSet.RunItems.forEach((runItem, i) => {
			if (i > 0) {
				tooltip.appendMarkdown('\n---\n');
			}
			const target = this.findTarget(runItem.Target);
			tooltip.appendMarkdown(`**Instance ${i+1}** on _${target.Name}_\n`);
			const chunks: string[][] = [];
			let currentChunk: string[];
			runItem.ExtraLaunchParameters.split(/ +/).forEach((param: string) => {
				if (param) {
					if (param[0] === '-') {
						currentChunk = [];
						chunks.push(currentChunk);
					}
					currentChunk.push('`'+param+'`');
				}
			});
			for (const chunk of chunks) {
				tooltip.appendMarkdown(`* ${chunk.join(' ')}\n`);
			}
		});
		this.tooltip = tooltip;
	}

	private findTarget(targetId: string): ToolchainConfigTarget {
		const target = this.config.Targets.find((target) => {
			return target.Id === targetId;
		});
		if (!target) {
			throw new Error(`Target '${targetId}' not found!`);
		}
		return target;
	}

	contextValue = 'launch-set';
}