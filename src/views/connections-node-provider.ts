import * as vscode from "vscode";
import { connectionHandler } from "../connection-handler";
import { StingrayConnection } from "../stingray-connection";

const buildTooltip = (info: any) => {
	const tooltip = new vscode.MarkdownString();
	tooltip.appendCodeblock(info.title);
	tooltip.appendMarkdown([
		`---`,
		`**Port**: ${info.console_port}  `,
		`**Profiler port**: ${info.profiler_port}  ([Open Profiler](http://localhost:${info.profiler_port || 1338}))  `,
		`**Build**: ${info.build} (identifier: ${info.build_identifier})  `,
		`**Platform**: ${info.platform}  `,
		`**Process ID**: ${info.process_id}  `,
		`**Session ID**: ${info.session_id}  `,
		`**Machine ID**: ${info.machine_id}  `,
		`**Dedicated server?**: ${info.is_dedicated_server ? "Yes" : "No"}  `,
		`**Bundled?**: ${info.bundled ? "Yes" : "No"}  `,
		`**Launch time**: ${ new Date(Date.now() - 1000*info.time_since_launch).toLocaleString()}  `,
		`**Plugins**: ${info.plugins.join(", ")}  `,
		`**Arguments**: \`${info.argv.join(" ")}\`  `,
	].join("\n"));
	return tooltip;
};

const shortTitle = (title: string, max?: number): string => {
	max = max ?? 32;
	return (title.length <= max) ? title : title.substring(0, max-1) + "…";
};

const buildLabel = (info: any, port: number): string => {
	if (info) {
		const title = info.is_dedicated_server ? "Dedicated Server" : info.title ? shortTitle(info.title) : "Stingray";
		return `${title} (${info.console_port})`;
	}
	return `Stingray ${port}`;
};

export class ConnectionsNodeProvider implements vscode.TreeDataProvider<StingrayConnection> {
	private _onDidChangeTreeData: vscode.EventEmitter<StingrayConnection | undefined | void> = new vscode.EventEmitter<StingrayConnection | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<StingrayConnection | undefined | void> = this._onDidChangeTreeData.event;

	async getTreeItem(connection: StingrayConnection): Promise<vscode.TreeItem> {
		const info = await connectionHandler.identify(connection);
		const treeItem = new vscode.TreeItem(buildLabel(info, connection.port), vscode.TreeItemCollapsibleState.None);
		treeItem.tooltip = info ? buildTooltip(info) : undefined;
		treeItem.iconPath = new vscode.ThemeIcon("debug-console");
		treeItem.contextValue = "connection";
		treeItem.command = {
			title: "Focus output",
			command: "fatshark-code-assist.Connection._focusOutput",
			arguments: [ connection ],
		};
		return treeItem;
	}

	getChildren(element?: StingrayConnection): vscode.ProviderResult<StingrayConnection[]> {
		return element ? [] : connectionHandler.getAllGames();
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}
}
