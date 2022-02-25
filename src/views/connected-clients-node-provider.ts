// implements tree view UI for connected clients
import * as vscode from 'vscode';
import { connectionHandler } from '../connection-handler';
import { StingrayConnection } from '../stingray-connection';

const IDENTIFY_TIMEOUT = 5000; // Milliseconds.
const IDENTIFY_COMMAND = "stingray_identify";
const IDENTIFY_LUA = `
print("[VSCode] Identifying instance...")
local function GET(obj, method, default)
	return (function(ok, ...)
		if ok then return ... end
		return default
	end)(pcall(obj and obj[method]))
end
stingray.Application.console_send({
	type = "stingray_identify",
	info = {
		--[[ sysinfo = Application.sysinfo(), Too long! ]]
		argv = { GET(Application, "argv", "#ERROR!") },
		build = GET(Application, "build", BUILD),
		build_identifier = GET(Application, "build_identifier", BUILD_IDENTIFIER),
		bundled = GET(Application, "bundled"),
		console_port = GET(Application, "console_port"),
		is_dedicated_server = GET(Application, "is_dedicated_server"),
		machine_id = GET(Application, "machine_id"),
		platform = GET(Application, "platform", PLATFORM),
		plugins = GET(Application, "all_plugin_names"),
		process_id = GET(Application, "process_id"),
		session_id = GET(Application, "session_id"),
		source_platform = GET(Application, "source_platform"),
		time_since_launch = GET(Application, "time_since_launch"),
		title = GET(Window, "title", "Stingray"),
		jit = { GET(jit, "status") } ,
	},
})
`;

export class ConnectedClientsNodeProvider implements vscode.TreeDataProvider<StingrayConnection> {
	private _onDidChangeTreeData: vscode.EventEmitter<StingrayConnection | undefined | void> = new vscode.EventEmitter<StingrayConnection | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<StingrayConnection | undefined | void> = this._onDidChangeTreeData.event;

	getTreeItem(connection: StingrayConnection): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return new Promise<vscode.TreeItem>(async (resolve) => {
			let timeoutId: NodeJS.Timeout;
			const onData = (data: any) => {
				if (data.type === "stingray_identify") {
					connection.onDidReceiveData.remove(onData);
					clearTimeout(timeoutId);
					resolve(new ConnectedClientTreeItem(data.info, connection));
				}
			};

			connection.onDidReceiveData.add(onData);
			connection.sendLua(IDENTIFY_LUA);

			timeoutId = setTimeout(() => {
				connection.onDidReceiveData.remove(onData);
				clearTimeout(timeoutId);
				resolve(new ConnectedClientTreeItem(null, connection));
			}, IDENTIFY_TIMEOUT);
		});
	}

	getChildren(element?: StingrayConnection): vscode.ProviderResult<StingrayConnection[]> {
		return element ? [] : connectionHandler.getAllGames();
		// If element is falsy, it's trying to retrieve the children of a node which shouldn't be possible.
		// Return an empty array as a failsafe.
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}
}

const shortTitle = (title: string, max?: number): string => {
	max = max ?? 32;
	return (title.length <= max) ? title : title.substring(0, max-1) + "…";
};

const buildLabel = (info: any, port: number): string => {
	return info ? `${shortTitle(info.title)} (${info.console_port})` : `Stingray ${port}`;
};

class ConnectedClientTreeItem extends vscode.TreeItem {
	constructor(
		public readonly info: any,
		public readonly connection: StingrayConnection
	) {
		super(buildLabel(info, connection.port), vscode.TreeItemCollapsibleState.None);
		if (info) {
			this._makeTooltip(info);
		}

		this.command = {
			title: 'Focus output',
			command: 'fatshark-code-assist._focusOutput',
			arguments: [ this ],
		};
	}

	_makeTooltip(info: any) {
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
			`**Dedicated server?**: ${info.is_dedicated_server ? 'Yes' : 'No'}  `,
			`**Bundled?**: ${info.bundled ? 'Yes' : 'No'}  `,
			`**Launch time**: ${ new Date(Date.now() - 1000*info.time_since_launch).toLocaleString()}  `,
			`**Plugins**: ${info.plugins.join(', ')}  `,
			`**Arguments**: \`${info.argv.join(' ')}\`  `,
		].join('\n'));
		this.tooltip.isTrusted = true;
		this.tooltip.supportThemeIcons = true;
	}

	contextValue = 'connected-client';
	iconPath = new vscode.ThemeIcon('debug-console');
}