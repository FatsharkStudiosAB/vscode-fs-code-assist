// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { ConnectedClientsNodeProvider, ConnectedClientTreeItem } from './connected-clients-node-provider';
import { connectionHandler, MAX_CONNECTIONS } from './connection-handler';
import { getCurrentToolchainSettings, getToolchainPath, getToolchainSettingsPath, uuid4 } from './utils';
import * as languageFeatures from './stingray-language-features';

export function activate(context: vscode.ExtensionContext) {
	languageFeatures.activate();

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.stingrayRecompile', () => {
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification
		}, (progress, token) => new Promise<void>((resolve, reject) => {
			const id = uuid4();
			const config = vscode.workspace.getConfiguration("stingray_lua");
			const toolchain = <string|undefined>config.get("toolchain");
			const platform = <string|undefined>config.get("platform");

			if (!toolchain) {
				reject();
				return;
			}

			let tcPath = getToolchainSettingsPath(toolchain);
			if (!tcPath) {
				reject();
				return;
			}

			progress.report({ increment: 0, message: "Stingray Compile: Starting..." });

			let status = 0;

			const compiler = connectionHandler.getCompiler();
			compiler.onDidReceiveData.add(function onData(data: any) {
				if (data.id === id && data.finished) {
					if (data.status === "success") {
						connectionHandler.getAllGames().forEach(game => {
							game.sendCommand("refresh");
							game.sendCommand("game", "unpause");
						});
						compiler.onDidReceiveData.remove(onData);
						resolve();
					} else {
						reject();
					}
				} else if (data.type === "compile_progress") {
					const newStatus = Math.ceil(data.i/data.count * 100);
					const increment = newStatus - status;
					const message = data.file || "Reticulating splines...";
					progress.report({ increment: increment, message: "Stingray Compile: " + message });
					status = newStatus;
				}
			});

			token.onCancellationRequested(() => {
				compiler.sendJSON({
					"id": id,
					"type" : "cancel",
				});
			});

			progress.report({ increment: 0, message: "Stingray Compile: Starting..." });

			let currentTCSettings = getCurrentToolchainSettings(tcPath);
			const enginePath = getToolchainPath(toolchain).replace(/\\/g, '/');
			const sourceDir = currentTCSettings.SourceDirectory.replace(/\\/g, '/');
			const dataDir = currentTCSettings.DataDirectoryBase.replace(/\\/g, '/');
			compiler.sendJSON({
				"id": id,
				"type" : "compile",
				"source-directory" : sourceDir,
				"source-directory-maps" : [
					{ "directory" : "core", "root" : enginePath }
				],
				"data-directory" : dataDir,
				"platform" : platform,
			});
		}));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.stingrayConnect', () => {
		connectionHandler.getCompiler();

		const config = vscode.workspace.getConfiguration("stingray_lua");
		const ip = <string|undefined>config.get("debugTargetIP");
		connectionHandler.connectAllGames(14000, MAX_CONNECTIONS, ip);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.stingrayDisconnect', () => {
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
	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.stingrayCommandTarget', (element) => {
		let connectedClientTreeItem = element as ConnectedClientTreeItem;
		let commandBoxOptions = {prompt:`Command target: ${connectedClientTreeItem.label}`};
		vscode.window.showInputBox(commandBoxOptions).then( (value: string | undefined) => {
			let commandArgs = value?.split(" ") || [];
			if (commandArgs.length > 0) {
				let commandType = commandArgs[0];
				commandArgs.splice(0, 1);
				connectedClientTreeItem.connection?.sendCommand(commandType, ...commandArgs);
			}
		});
	}));

	let luaBoxOptions = {
		prompt: "Enter Lua to extecute.",
	};
	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.stingrayLua', () => {
		vscode.window.showInputBox(luaBoxOptions).then( (value: string | undefined) => {
			if (value) {
				connectionHandler.getAllGames().forEach(game => game.sendLua(value));
			}
		});
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.stingrayLuaTarget', (element) => {
		let connectedClientTreeItem = element as ConnectedClientTreeItem;
		let commandBoxOptions = {prompt:`Lua target: ${connectedClientTreeItem.label}`};
		vscode.window.showInputBox(commandBoxOptions).then( (value: string | undefined) => {
			if (value) {
				connectedClientTreeItem.connection?.sendLua(value);
			}
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.executeSelection', () => {
		let textEditor = vscode.window.activeTextEditor;
		if (textEditor) {
			let selection = textEditor.selection;
			let selectionText = textEditor.document.getText(selection);
			connectionHandler.getAllGames().forEach(game => game.sendLua(selectionText));
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.selectionTarget', (element) => {
		let connectedClientTreeItem = element as ConnectedClientTreeItem;
		let textEditor = vscode.window.activeTextEditor;
		if (textEditor) {
			let selection = textEditor.selection;
			let selectionText = textEditor.document.getText(selection);
			if (selectionText.length > 0){
				connectedClientTreeItem.connection?.sendLua(selectionText);
			}
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.executeFile', () => {
		const textEditor = vscode.window.activeTextEditor;
		if (textEditor) {
			connectionHandler.getAllGames().forEach(game => game.sendLua(textEditor.document.getText()));
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.attachDebugger', (element) => {
		const connectedClientTreeItem = element as ConnectedClientTreeItem;
		const connection = connectedClientTreeItem.connection;

		let folder = vscode.workspace.workspaceFolders;
		if (folder && connection) {
			const config = vscode.workspace.getConfiguration("stingray_lua");
			const toolchain = <string|undefined>config.get("toolchain");
			const attachArgs = {
				"type": "stingray_lua",
				"request": "attach",
				"name": `Vermintide 2 ${connectedClientTreeItem.connection.getName()}`,
				"toolchain": toolchain,
				"ip" : connectedClientTreeItem.connection.ip,
				"port" : connectedClientTreeItem.connection.port,
			};

			const sourceDir = folder[0];
			vscode.debug.startDebugging(sourceDir, attachArgs);
		}
	}));

	// Connected clients panel
	let connectedClientsNodeProvider = new ConnectedClientsNodeProvider();
	let connectedClientsTreeView = vscode.window.createTreeView("fs-code-assist-clients", {
		treeDataProvider: connectedClientsNodeProvider, 
		showCollapseAll: false, 
		canSelectMany: false
	});

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist._refreshConnectedClients', () => {
		connectedClientsNodeProvider.refresh();
	}));
	
	connectedClientsTreeView.onDidChangeSelection( (e)=> {
		let selection = e.selection;
		selection.forEach(clientItem => {
			clientItem.focusOutput();
		});
	});
}

export function deactivate() {
	connectionHandler.closeAll();
	languageFeatures.deactivate();
}
