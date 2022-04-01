import * as vscode from "vscode";
import { getActiveToolchain } from "../extension";
import type { Target } from "../utils/stingray-config";

const buildTooltip = (target: Target) => {
	const tooltip = new vscode.MarkdownString();
	tooltip.appendCodeblock(target.Name);
	tooltip.appendMarkdown([
		`---`,
		`**Id**: \`${target.Id}\`  `,
		`**Address**: \`${target.Ip}:${target.Port}\`  `,
		`**Platform**: ${target.Platform}  `,
		`**Profiler port**: ${target.ProfilerPort}  `,
	].join("\n"));
	return tooltip;
};

export class TargetsNodeProvider implements vscode.TreeDataProvider<Target> {
	private _onDidChangeTreeData: vscode.EventEmitter<Target | undefined | void> = new vscode.EventEmitter<Target | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<Target | undefined | void> = this._onDidChangeTreeData.event;

	getTreeItem(target: Target): vscode.TreeItem | Thenable<vscode.TreeItem> {
		const treeItem = new vscode.TreeItem(`[${target.Platform}] ${target.Name}`, vscode.TreeItemCollapsibleState.None);
		treeItem.tooltip = buildTooltip(target);
		treeItem.iconPath = new vscode.ThemeIcon("vm");
		treeItem.contextValue = "target";
		treeItem.command = {
			title: "Scan for Instances",
			command: "fatshark-code-assist.Target.scan",
			arguments: [ target ],
		};
		return treeItem;
	}

	async getChildren(_target?: Target): Promise<Target[] | undefined> {
		const toolchain = getActiveToolchain()!;
		const config = await toolchain.config();
		return config.Targets;
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}
}
