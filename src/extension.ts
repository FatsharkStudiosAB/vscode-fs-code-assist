// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { join as pathJoin } from 'path';
import { URLSearchParams } from 'url';
import * as vscode from 'vscode';
import { connectionHandler, MAX_CONNECTIONS } from './connection-handler';
import { StingrayConnection } from './stingray-connection';
import * as languageFeatures from './stingray-language-features';
import * as taskProvider from './stingray-task-provider';
import { Platform, RunSet } from './utils/stingray-config';
import { StingrayToolchain } from "./utils/stingray-toolchain";
import { ConnectedClientsNodeProvider } from './views/connected-clients-node-provider';
import { ConnectionTargetsNodeProvider, ConnectionTargetTreeItem } from './views/connection-targets-node-provider';
import { LaunchSetTreeItem, LaunchTargetsNodeProvider } from './views/launch-targets-node-provider';

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

export function activate(context: vscode.ExtensionContext) {
	languageFeatures.activate(context);
	taskProvider.activate(context);

	vscode.workspace.onDidChangeWorkspaceFolders(updateIsStingrayProject);
	vscode.workspace.onDidChangeConfiguration(updateIsStingrayProject);
	updateIsStingrayProject();

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.stingrayReloadSources', () => {
		connectionHandler.getAllGames().forEach(game => {
			game.sendCommand("refresh");
			game.sendCommand("game", "unpause");
		});
		vscode.window.setStatusBarMessage("Sources reloaded.", 3000);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.stingrayRecompile', (item?: ConnectionTargetTreeItem) => {
		const toolchain = getActiveToolchain();
		if (!toolchain) {
			vscode.window.showErrorMessage("No active toolchain!");
			return;
		}

		let platform: Platform;
		if (item) {
			platform = item.platform;
		} else {
			const config = vscode.workspace.getConfiguration('StingrayLua');
			platform = config.get('platform') ?? "win32";
		}

		const task = taskProvider.createDefaultTask(platform, toolchain);
		vscode.tasks.executeTask(task);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.stingrayConnect', (element?: ConnectionTargetTreeItem) => {
		connectionHandler.getCompiler();
		if (element) {
			const port = element.platform === "win32" ? 14000 : element.port;
			const maxConnections = element.platform === "win32" ? MAX_CONNECTIONS : 1;
			connectionHandler.connectAllGames(port, maxConnections, element.ip);
		} else {
			connectionHandler.connectAllGames(14000, MAX_CONNECTIONS);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.stingrayDisconnect', (connection: StingrayConnection) => {
		connection.close();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.stingrayDisconnectAll', () => {
		connectionHandler.closeAll();
	}));

	let commandBoxOptions = {
		prompt: "Enter Stingray command.",
	};
	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.stingrayCommand', () => {
		vscode.window.showInputBox(commandBoxOptions).then( (value: string | undefined) => {
			let commandArgs = value?.split(" ") || [];
			if (commandArgs.length > 0) {
				let commandType = commandArgs[0];
				commandArgs.splice(0, 1);
				connectionHandler.getAllGames().forEach(game => game.sendCommand(commandType, ...commandArgs));
			}
		});
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.stingrayCommandTarget', async (connection: StingrayConnection) => {
		const value = await vscode.window.showInputBox({prompt: 'Command'}) || '';
		const args = value.split(/\s+/);
		const cmd = args.shift();
		if (cmd) {
			connection.sendCommand(cmd, ...args); // cmd is a fixed argument...
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.executeLua', async (connection?: StingrayConnection) => {
		const lua = await vscode.window.showInputBox({prompt: 'Lua script'});
		if (!lua) {
			return;
		}

		if (connection) {
			connection.sendLua(lua);
		} else {
			connectionHandler.getAllGames().forEach((game) => game.sendLua(lua));
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.executeSelection', () => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor) {
			const selection = textEditor.selection;
			const selectionText = textEditor.document.getText(selection);
			connectionHandler.getAllGames().forEach(game => game.sendLua(selectionText));
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.selectionTarget', (connection: StingrayConnection) => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor) {
			const selectionText = textEditor.document.getText(textEditor.selection);
			if (selectionText.length > 0) {
				connection.sendLua(selectionText);
			}
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.executeFile', () => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor) {
			connectionHandler.getAllGames().forEach(game => game.sendLua(textEditor.document.getText()));
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.attachDebugger', (connection: StingrayConnection) => {
		if (!connection) {
			vscode.window.showErrorMessage('Command attachDebugger executed in the wrong context.');
			return;
		}

		const toolchain = getActiveToolchain();
		if (!toolchain) {
			vscode.window.showErrorMessage('No active toolchain.');
			return;
		}

		const { ip, port } = connection;

		const attachArgs = {
			"type": "stingray_lua",
			"request": "attach",
			"name": `${connection.ip}:${connection.port}`,
			"toolchain": toolchain.path,
			"ip" : ip,
			"port" : port,
			"debugServer": process.env.FATSHARK_CODE_ASSIST_DEBUG_MODE ? 4711 : undefined,
		};

		const outputChannel = connectionHandler.getOutputForConnection(connection);
		if (outputChannel) {
			outputChannel.show();
		} else {
			connectionHandler.getGame(port, ip);
		}
		vscode.debug.startDebugging(undefined, attachArgs);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.stingrayLaunch', async (element: any) => {
		const toolchain = getActiveToolchain();
		if (!toolchain) {
			throw new Error('No active toolchain');
		}

		let runSet: RunSet;
		if (element instanceof LaunchSetTreeItem) {
			runSet = element.runSet;
		} else if (typeof element === 'string') {
			const config = await toolchain.config();
			const foundRunSet = config.RunSets.find((runSet) => runSet.Id === element);
			if (!foundRunSet) {
				vscode.window.showErrorMessage(`No run set with given id found: ${element}`);
				return;
			}
			runSet = foundRunSet;
		} else {
			vscode.window.showErrorMessage(`Invalid argument ${element}`);
			return;
		}

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
				vscode.commands.executeCommand("fatshark-code-assist.attachDebugger", { ip, port });
			} else if (command === "launch") {
				const runSetId = params.get("runSetId");
				if (!runSetId) {
					vscode.window.showErrorMessage(`Missing runSetId arguments for /launch command.`);
					return;
				}
				vscode.commands.executeCommand("fatshark-code-assist.stingrayLaunch", runSetId);
			} else {
				vscode.window.showErrorMessage(`Unknown command: ${command}`);
			}
		}
	}));

	// connection targets
	let connectTargetsNodeProvider = new ConnectionTargetsNodeProvider();
	let connectTargetTreeView = vscode.window.createTreeView("fs-code-assist-targets", {
		treeDataProvider: connectTargetsNodeProvider,
		showCollapseAll: false,
		canSelectMany: false
	});

	// Connected clients panel
	let connectedClientsNodeProvider = new ConnectedClientsNodeProvider();
	let connectedClientsTreeView = vscode.window.createTreeView("fs-code-assist-clients", {
		treeDataProvider: connectedClientsNodeProvider,
		showCollapseAll: false,
		canSelectMany: true
	});

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist._refreshConnectedClients', () => {
		connectedClientsNodeProvider.refresh();
	}));

	// Launch targets panel.
	let launchTargetsNodeProvider = new LaunchTargetsNodeProvider();
	vscode.window.createTreeView('fs-code-assist-launch', {
		treeDataProvider: launchTargetsNodeProvider,
		showCollapseAll: false,
		canSelectMany: true
	});

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.refreshTargets', () => {
		connectTargetsNodeProvider.refresh();
		launchTargetsNodeProvider.refresh();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist._focusOutput', (connection: StingrayConnection) => {
		const outputChannel = connectionHandler.getOutputForConnection(connection);
		if (outputChannel) {
			outputChannel.show();
		} else {
			vscode.window.showWarningMessage(`No output channel for connection at ${connection?.ip}:${connection?.port}`);
		}
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
}

export function deactivate() {
	connectionHandler.closeAll();
}
