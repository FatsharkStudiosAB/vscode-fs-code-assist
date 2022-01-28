// implements tree view UI for connected clients
import * as vscode from 'vscode';
import { connectionHandler } from './connection-handler';
import { StingrayConnection } from './stingray-connection';

const IDENTIFY_TIMEOUT = 2500; // Milliseconds.
const IDENTIFY_COMMAND = "stingray_identify";
const IDENTIFY_LUA = `
Application.console_send({
	type = "${IDENTIFY_COMMAND}",
	info = {
		--[[ sysinfo = Application.sysinfo(), ]]
		argv = { Application.argv() },
		build = rawget(_G, "BUILD") or Application.build(),
		build_identifier = Application.build_identifier(),
		bundled = Application.bundled(),
		console_port = Application.console_port(),
		is_dedicated_server = Application.is_dedicated_server(),
		machine_id = Application.machine_id(),
		platform = rawget(_G, "PLATFORM") or Application.platform(),
		plugins = Application.all_plugin_names(),
		process_id = Application.process_id(),
		session_id = Application.session_id(),
		source_platform = Application.source_platform(),
		time_since_launch = Application.time_since_launch(),
		title = Window.title and Window.title() or "Stingray",
	},
})
`;

export class ConnectedClientsNodeProvider implements vscode.TreeDataProvider<ConnectedClientTreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<ConnectedClientTreeItem | undefined | void> = new vscode.EventEmitter<ConnectedClientTreeItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<ConnectedClientTreeItem | undefined | void> = this._onDidChangeTreeData.event;

	getTreeItem(element: ConnectedClientTreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element;
	}
	getChildren(element?: ConnectedClientTreeItem): vscode.ProviderResult<ConnectedClientTreeItem[]> {
		return this._gatherClientConnections();
	}
	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	private async _gatherClientConnections() {
		const openConnections = connectionHandler.getAllGames();
		const treeItems: Promise<ConnectedClientTreeItem>[] = openConnections.map(connection => {
			return new Promise((resolve, reject) => {
				const timeoutId = setTimeout(reject, IDENTIFY_TIMEOUT);
				const onData = (data: any) => {
					if (data.type === IDENTIFY_COMMAND) {
						connection.onDidReceiveData.remove(onData);
						const outputChannel = connectionHandler.getOutputForConnection(connection) as vscode.OutputChannel;
						clearTimeout(timeoutId);
						resolve(new ConnectedClientTreeItem(data.info, outputChannel, connection));
					}
				};
				connection.onDidReceiveData.add(onData);
				connection.sendLua(IDENTIFY_LUA);
			});
		});
		return Promise.all(treeItems);
	}
}

const shortTitle = (title: string, max?: number): string => {
	max = max ?? 32;
	return (title.length <= max) ? title : title.substring(0, max-1) + "…";
};

export class ConnectedClientTreeItem extends vscode.TreeItem {
	constructor(
		public readonly info: any,
		private readonly connectionOutput: vscode.OutputChannel,
		public readonly connection: StingrayConnection
	) {
		super(`${shortTitle(info.title)} (${info.console_port})`, vscode.TreeItemCollapsibleState.None);
		this.tooltip = new vscode.MarkdownString();
		this.tooltip.appendCodeblock(info.title);
		this.tooltip.appendMarkdown([
			`---`,
			`**Port**: ${info.console_port}  `,
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
		].join('\n'));
		this.tooltip.isTrusted = true;
		this.tooltip.supportThemeIcons = true;
	}

	focusOutput() {
		if (this.connectionOutput) {
			this.connectionOutput.show();
		}
	}

	contextValue = 'connected-client';
	iconPath = new vscode.ThemeIcon('debug-console');
}