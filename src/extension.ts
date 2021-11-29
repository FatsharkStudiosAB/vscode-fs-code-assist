// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
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

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.executeSelection', () => {
		let textEditor = vscode.window.activeTextEditor;
		if (textEditor) {
			let selection = textEditor.selection;
			let selectionText = textEditor.document.getText(selection);
			connectionHandler.getGame(14000).sendLua(selectionText);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.executeFile', () => {
		let textEditor = vscode.window.activeTextEditor;
		if (textEditor) {
			connectionHandler.getGame(14000).sendLua(textEditor.document.getText());
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('fatshark-code-assist.recompileFile', () => {
		// TODO
		// let config = vscode.workspace.getConfiguration("stingray");
		// let id = guid();
		// let enginePath = config.get("engine_path");
		// let sourceDir = config.get("source_dir"); 
		// let dataDir = config.get("data_dir"); 
		// let platform = config.get("platform");

		
		// vscode.workspace.textDocuments.forEach(element => {
		// 	console.log(element.uri.toString());
		// });

		// var cmd = {
		// 	id,
		// 	type : "compile",
		// 	"source-directory" : sourceDir,
		// 	"source-directory-maps" : [
		// 		{ directory : "core", root : enginePath }
		// 	],
		// 	"data-directory" : dataDir,
		// 	platform : platform,
		// 	files:[],
		// };

		// compileConnection.on("data", function oneTimeCallback(response) {
		// 	if (response.id === id) {
		// 		if (response.finished) {
		// 			gameConnection.sendCommand("refresh");
		// 			gameConnection.sendCommand("game", "unpause");
		// 			compileConnection.off("data", oneTimeCallback);
		// 		}
		// 	}
		// });
		// compileConnection.sendJSON(cmd);
	}));
}

export function deactivate() {
	connectionHandler.closeAll();
}
