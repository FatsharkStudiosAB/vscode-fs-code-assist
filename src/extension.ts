// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { join as pathJoin } from 'path';
import * as vscode from 'vscode';
import { ConnectedClientsNodeProvider } from './views/connected-clients-node-provider';
import { connectionHandler, MAX_CONNECTIONS } from './connection-handler';
import { ConnectionTargetsNodeProvider, ConnectionTargetTreeItem } from './views/connection-targets-node-provider';
import * as languageFeatures from './stingray-language-features';
import { uuid4 } from './utils/functions';
import { StingrayToolchain } from "./utils/stingray-toolchain";
import { StingrayConnection } from './stingray-connection';

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

	vscode.workspace.onDidChangeWorkspaceFolders(updateIsStingrayProject);
	updateIsStingrayProject();

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.stingrayReloadSources', () => {
		connectionHandler.getAllGames().forEach(game => {
			game.sendCommand("refresh");
			game.sendCommand("game", "unpause");
		});
		vscode.window.setStatusBarMessage("Sources reloaded.", 3000);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.stingrayRecompile', (arg?: ConnectionTargetTreeItem | string) => {
		const config = vscode.workspace.getConfiguration('StingrayLua');
		let platform: string | undefined;
		if (typeof arg === 'string') {
			platform = arg;
		} else if (arg instanceof ConnectionTargetTreeItem) {
			platform = arg.platform;
		}

		if (!platform) {
			platform = config.get('platform') ?? 'win32';
		}

		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification
		}, (progress, token) => new Promise<void>(async (resolve, reject) => {
			const toolchain = getActiveToolchain();
			if (!toolchain) {
				resolve();
				return;
			}

			progress.report({ increment: 0, message: "Stingray Compile: Starting..." });

			const id = uuid4();
			let status = 0;

			const compiler = connectionHandler.getCompiler();
			function onData(data: any) {
				if (data.id === id && data.finished) {
					if (data.status === "success") {
						vscode.commands.executeCommand('fatshark-code-assist.stingrayReloadSources');
						compiler.onDidReceiveData.remove(onData);
						resolve();
					} else {
						compiler.onDidReceiveData.remove(onData);
						resolve();
					}
				} else if (data.type === "compile_progress") {
					const newStatus = Math.ceil(data.i/data.count * 100);
					const increment = newStatus - status;
					const message = data.file || "Reticulating splines...";
					progress.report({ increment: increment, message: "Stingray Compile: " + message });
					status = newStatus;
				} else if (data.type === "message" && data.system === "Compiler" && data.level === "error") {
					vscode.window.showErrorMessage(`Compile error: ${data.message} compile id: ${id}`);
				}
			};

			compiler.onDidReceiveData.add(onData);

			token.onCancellationRequested(() => {
				compiler.onDidReceiveData.remove(onData);
				compiler.sendJSON({
					"id": id,
					"type" : "cancel",
				});
				resolve();
			});

			progress.report({ increment: 0, message: "Stingray Compile: Starting..." });

			const config = await toolchain.config();
			const currentProject = config.Projects[config.ProjectIndex];
			const sourceDir = currentProject.SourceDirectory;
			const dataDir = pathJoin(currentProject.DataDirectoryBase, platform);
			compiler.sendJSON({ // .replace(/\\/g, '/')
				"id": id,
				"type" : "compile",
				"source-directory" : sourceDir,
				"source-directory-maps" : [
					{ "directory" : "core", "root" : config.SourceRepositoryPath ?? toolchain.path }
				],
				"data-directory" : dataDir,
				"platform" : platform,
			});
		}));
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

		const attachArgs = {
			"type": "stingray_lua",
			"request": "attach",
			"name": `Vermintide 2 ${connection.name}`,
			"toolchain": toolchain.path,
			"ip" : connection.ip,
			"port" : connection.port,
		};

		const outputChannel = connectionHandler.getOutputForConnection(connection) as vscode.OutputChannel;
		outputChannel.show();
		vscode.debug.startDebugging(undefined, attachArgs);
	}));


	// connection targets
	let connectTargetsNodeProvider = new ConnectionTargetsNodeProvider();
	let connectTargetTreeView = vscode.window.createTreeView("fs-code-assist-targets", {
		treeDataProvider: connectTargetsNodeProvider,
		showCollapseAll: false,
		canSelectMany: false
	});
	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.refreshTargets', () => {
		connectTargetsNodeProvider.refresh();
	}));

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

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist._focusOutput', (connection: StingrayConnection) => {
		const outputChannel = connectionHandler.getOutputForConnection(connection) as vscode.OutputChannel;
		outputChannel.show();
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
