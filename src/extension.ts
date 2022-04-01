import { join as pathJoin } from 'path';
import { URLSearchParams } from 'url';
import * as vscode from 'vscode';
import { connectionHandler, MAX_CONNECTIONS } from './connection-handler';
import { StingrayConnection } from './stingray-connection';
import * as languageFeatures from './stingray-language-features';
import * as taskProvider from './stingray-task-provider';
import type { Platform, RunSet, Target } from './utils/stingray-config';
import { StingrayToolchain } from "./utils/stingray-toolchain";
import { ConnectionsNodeProvider } from './views/connections-node-provider';
import { RunSetsNodeProvider } from './views/run-sets-node-provider';
import { TargetsNodeProvider } from './views/targets-node-provider';

let _activeToolchain: StingrayToolchain;
export const getActiveToolchain = () => {
	if (_activeToolchain) {
		return _activeToolchain;
	}
	const config = vscode.workspace.getConfiguration('StingrayLua');
	const toolchainRoot: string = config.get('toolchainPath') || process.env.BsBinariesDir || 'C:/BitSquidBinaries';
	const toolchainName: string = config.get('toolchainName') || 'vermintide2';
	if (!toolchainRoot || !toolchainName) {
		return null;
	}
	_activeToolchain = new StingrayToolchain(pathJoin(toolchainRoot, toolchainName));
	return _activeToolchain;
};

const updateIsStingrayProject = async () => {
	let bool = false;
	const workspaceRootPath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
	if (workspaceRootPath) {
		const toolchain = getActiveToolchain();
		if (toolchain) {
			const config = await toolchain.config();
			bool = config.Projects.some((project) => {
				return project.SourceDirectory.toUpperCase() === workspaceRootPath.toUpperCase();
			});
		}
	}
	vscode.commands.executeCommand('setContext', 'fatshark-code-assist:isStingrayProject', bool);
};

export const activate = (context: vscode.ExtensionContext) => {
	languageFeatures.activate(context);
	taskProvider.activate(context);

	vscode.workspace.onDidChangeWorkspaceFolders(updateIsStingrayProject);
	vscode.workspace.onDidChangeConfiguration(updateIsStingrayProject);
	updateIsStingrayProject();

	const targetsNodeProvider = new TargetsNodeProvider();
	context.subscriptions.push(vscode.window.createTreeView("fatshark-code-assist-Targets", {
		treeDataProvider: targetsNodeProvider,
		showCollapseAll: false,
		canSelectMany: true,
	}));

	// Connected clients panel
	const connectionsNodeProvider = new ConnectionsNodeProvider();
	context.subscriptions.push(vscode.window.createTreeView("fatshark-code-assist-Connections", {
		treeDataProvider: connectionsNodeProvider,
		showCollapseAll: false,
		canSelectMany: true,
	}));

	// Launch targets panel.
	const runSetsNodeProvider = new RunSetsNodeProvider();
	context.subscriptions.push(vscode.window.createTreeView("fatshark-code-assist-RunSets", {
		treeDataProvider: runSetsNodeProvider,
		showCollapseAll: false,
		canSelectMany: true,
	}));

	context.subscriptions.push(vscode.commands.registerCommand("fatshark-code-assist.Target.scan", (target?: Target) => {
		connectionHandler.getCompiler();

		const isWin32 = target ? target.Platform === "win32" : true;
		const port = isWin32 ? 14000 : target!.Port;
		const maxConnections = isWin32 ? MAX_CONNECTIONS : 1;
		connectionHandler.connectAllGames(port, maxConnections, target?.Ip);
	}));

	context.subscriptions.push(vscode.commands.registerCommand("fatshark-code-assist.Target.compile", (target: Target) => {
		const toolchain = getActiveToolchain()!;
		return taskProvider.compileForPlatform(toolchain!, target.Platform);
	}));

	const connectionsForCommand = (connection: StingrayConnection, allSelected?: StingrayConnection[]): StingrayConnection[] => {
		if (allSelected) {
			return allSelected;
		} else if (connection instanceof StingrayConnection) {
			return [ connection ];
		} else {
			return connectionHandler.getAllGames();
		}
	};

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.Connection.attachDebugger', (connection: StingrayConnection, allSelected?: StingrayConnection[]) => {
		const toolchain = getActiveToolchain()!;

		connectionsForCommand(connection, allSelected).forEach((game) => {
			const { ip, port } = game;

			const attachArgs = {
				"type": "stingray_lua",
				"request": "attach",
				"name": `${game.ip}:${game.port}`,
				"toolchain": toolchain.path,
				"ip" : ip,
				"port" : port,
				"debugServer": process.env.FATSHARK_CODE_ASSIST_DEBUG_MODE ? 4711 : undefined,
			};

			const outputChannel = connectionHandler.getOutputForConnection(game);
			if (outputChannel) {
				outputChannel.show();
			} else {
				connectionHandler.getGame(port, ip);
			}
			vscode.debug.startDebugging(undefined, attachArgs);
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand("fatshark-code-assist.Connection.openProfiler", async (connection: StingrayConnection) => {
		const info = await connectionHandler.identify(connection);
		if (info) {
			vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${info.profiler_port}/`));
		} else {
			vscode.window.showErrorMessage(`Could not open profiler for instance.`);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.Connection.disconnect', (connection: StingrayConnection, allSelected?: StingrayConnection[]) => {
		connectionsForCommand(connection, allSelected).forEach((game) => {
			game.close();
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand("fatshark-code-assist.Connection.executeCommand", async (connection: StingrayConnection, allSelected?: StingrayConnection[]) => {
		const value = await vscode.window.showInputBox({prompt: "Command"}) || "";
		const args = value.split(/\s+/);
		const cmd = args.shift();
		if (cmd) {
			connectionsForCommand(connection, allSelected).forEach((game) => {
				game.sendCommand(cmd, ...args);
			});
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand("fatshark-code-assist.Connection.executeLua", async (connection: StingrayConnection, allSelected?: StingrayConnection[]) => {
		const lua = await vscode.window.showInputBox({prompt: "Lua script"}) || "";
		connectionsForCommand(connection, allSelected).forEach((game) => {
			game.sendLua(lua);
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand("fatshark-code-assist.Connection.executeSelection", (connection: StingrayConnection, allSelected?: StingrayConnection[]) => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor) {
			const selectionText = textEditor.document.getText(textEditor.selection);
			if (selectionText.length > 0) {
				connectionsForCommand(connection, allSelected).forEach((game) => {
					game.sendLua(selectionText);
				});
			}
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand("fatshark-code-assist.Connection.executeFile", (connection: StingrayConnection, allSelected?: StingrayConnection[]) => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor) {
			const script = textEditor.document.getText();
			connectionsForCommand(connection, allSelected).forEach((game) => {
				game.sendLua(script);
			});
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand("fatshark-code-assist.Connection.reloadResources", (connection: StingrayConnection, allSelected?: StingrayConnection[]) => {
		connectionsForCommand(connection, allSelected).forEach((game) => {
			game.sendCommand("refresh");
			game.sendCommand("game", "unpause");
		});
		vscode.window.setStatusBarMessage("$(refresh) Sources hot reloaded.", 3000);
	}));

	context.subscriptions.push(vscode.commands.registerCommand("fatshark-code-assist.Connection._focusOutput", (connection: StingrayConnection) => {
		const outputChannel = connectionHandler.getOutputForConnection(connection);
		if (outputChannel) {
			outputChannel.show();
		} else {
			vscode.window.showWarningMessage(`No output channel for connection at ${connection?.ip}:${connection?.port}`);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.RunSet.compileAndRun', async (runSet: RunSet) => {
		const toolchain = getActiveToolchain()!;
		const config = await toolchain.config();
		const platformCompilesDone = new Set<Platform>();

		for (const runItem of runSet.RunItems) {
			const target = config.Targets.find((target) => target.Id === runItem.Target);
			const platform = target?.Platform;
			if (!platform) {
				vscode.window.showErrorMessage(`Invalid target in run set ${runSet.Id}`);
				return;
			}

			if (!platformCompilesDone.has(platform)) {
				platformCompilesDone.add(platform);

				const success = await taskProvider.compileForPlatform(toolchain, platform);
				if (!success) {
					vscode.window.showErrorMessage(`Launch: Compile failed for platform ${platform}`);
					return;
				}
			}
		}

		return vscode.commands.executeCommand("fatshark-code-assist.RunSet.run", runSet);
	}));

	context.subscriptions.push(vscode.commands.registerCommand("fatshark-code-assist.RunSet.run", async (runSet: RunSet) => {
		const toolchain = getActiveToolchain()!;

		runSet.RunItems.forEach(async (runItem, i) => {
			let name = runSet.Name;
			if (runSet.RunItems.length > 1) {
				name += ` (Instance ${i+1})`;
			}
			const launchArgs = {
				"type": "stingray_lua",
				"request": "launch",
				"name": name,
				"toolchain": toolchain.path,
				"targetId": runItem.Target,
				"arguments": runItem.ExtraLaunchParameters,
				"debugServer": process.env.FATSHARK_CODE_ASSIST_DEBUG_MODE ? 4711 : undefined,
			};
			const success = await vscode.debug.startDebugging(undefined, launchArgs);
			if (success) {
				vscode.commands.executeCommand("fatshark-code-assist.stingrayConnect");
				// This might reconnect too many times, but it is relatively cheap to do so.
			}
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand("fatshark-code-assist.flushToolcenterConfig", () => {
		targetsNodeProvider.refresh();
		runSetsNodeProvider.refresh();
	}));

	context.subscriptions.push(vscode.commands.registerCommand("fatshark-code-assist._refreshConnectedClients", () => {
		connectionsNodeProvider.refresh();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist._goToResource', async (loc) => {
		if (!vscode.window.activeTextEditor) {
			return;
		}
		const toolchain = getActiveToolchain();
		if (!toolchain) {
			return;
		}
		const { file, line, external } = loc;
		const uri = vscode.Uri.file(file);
		if (external) {
			vscode.env.openExternal(uri);
		} else {
			if (line) {
				const document = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(document);
				const selection = new vscode.Selection(line-1, 0, line-1, 0);
				vscode.window.activeTextEditor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
				vscode.window.activeTextEditor.selection = selection;
			} else {
				vscode.commands.executeCommand('vscode.open', uri);
			}
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand("fatshark-code-assist._openDocumentation", async (info: { object: string, method: string }) => {
		const toolchain = getActiveToolchain()!;
		const { object, method } = info;
		let uriString = `file:///${toolchain.path.replace(/\\/g, "/")}/lua_HTML/obj_stingray_${object}.html`;
		// The fragment is removed when opened in Firefox.
		//if (method) {
		//	uriString += `#sig_stingray_${object}_${method.replace(/_/g, "__")}`;
		//}
		const uri = vscode.Uri.file(uriString);
		vscode.env.openExternal(uri);

		// Testing showing docs inside the editor, very buggy.
		//const basePath = "C:/BitSquidBinaries/vermintide2/lua_HTML";
		//const { object, method } = info;
		//const path = pathJoin(basePath, `obj_stingray_${object}.html`);
		//const html = await readFile(path, { encoding: 'utf8' });
		//const panel = vscode.window.createWebviewPanel(
		//	'stingrayDocs',
		//	'Stingray Documentation',
		//	vscode.ViewColumn.One,
		//	{
		//		enableScripts: true,
		//		localResourceRoots: [ vscode.Uri.file(basePath) ],
		//	},
		//);
		//panel.webview.html = html.replace(/((?:src|href)=['"])(.*?)(['"])/gi, (_, pre, uri, post) => {
		//	if (uri.startsWith("#") || uri.startsWith("http") || uri.startsWith("javascript") ) {
		//		uri = "";
		//	}
		//	const onDiskPath = vscode.Uri.file(pathJoin(basePath, uri));
		//	const webviewUri = panel.webview.asWebviewUri(onDiskPath).toString();
		//	return `${pre}${webviewUri}${post}`;
		//});
		//panel.reveal();
	}));

	context.subscriptions.push(vscode.window.registerUriHandler({
		handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
			const command = uri.path.replace(/^\//, "");
			const params = new URLSearchParams(uri.query);
			if (command === "attach") {
				const ip = params.get("ip") || "localhost";
				const port = parseInt(params.get("port") || "", 10);
				if (!ip || !port) {
					vscode.window.showErrorMessage(`Missing ip or port arguments for /attach command.`);
					return;
				}
				const connection = connectionHandler.getGame(port, ip);
				vscode.commands.executeCommand("fatshark-code-assist.Connection.attachDebugger", connection);
			} else {
				vscode.window.showErrorMessage(`Unknown command: ${command}`);
			}
		}
	}));
};

export const deactivate = () => {
	connectionHandler.closeAll();
};
