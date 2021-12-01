// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { ConnectedClientsNodeProvider, ConnectedClientTreeItem } from './connected-clients-node-provider';
import { connectionHandler } from './connection-handler';
import { guid } from './utils';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.stingrayRecompile', () => {
		let config = vscode.workspace.getConfiguration("stingray");
		let id = guid();
		let enginePath = config.get("engine_path");
		let sourceDir = config.get("source_dir"); 
		let dataDir = config.get("data_dir"); 
		let platform = config.get("platform");
		var cmd = {
			id,
			type : "compile",
			"source-directory" : sourceDir,
			"source-directory-maps" : [
				{ directory : "core", root : enginePath }
			],
			"data-directory" : dataDir,
			platform : platform,
		};

		connectionHandler.getCompiler().on("data", function oneTimeCallback(response) {
			if (response.id === id) {
				if (response.finished) {
					connectionHandler.getAllGames().forEach(game => game.sendCommand("refresh"));
					connectionHandler.getAllGames().forEach(game => game.sendCommand("game", "unpause"));
					connectionHandler.getCompiler().off("data", oneTimeCallback);
				}
			}
		});
		connectionHandler.getCompiler().sendJSON(cmd);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.stingrayConnect', () => {
		connectionHandler.getCompiler();
		connectionHandler.connectAllGames(14000, 32);
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

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.attachDebugger', () => {
		let test = {
			"type": "stingray_lua",
			"request": "attach",
			"name": "Vermintide 2",
			"toolchain": "Vermintide2 (trunk)",
			"engine_exe": "stingray_win64_dev_x64.exe",
		};
		let folder = vscode.workspace.workspaceFolders;
		if (folder) {
			//console.log(folder, folder[0]);
			vscode.debug.startDebugging(folder[0], test );
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
}
