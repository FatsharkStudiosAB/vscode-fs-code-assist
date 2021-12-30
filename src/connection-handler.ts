// Handles connections to stingray compile server and game clients.
// Handles creating and hooking to VS Code Output windows.
// Handles "Connected Clients" side panel refreshing.

import * as vscode from 'vscode';
import { StingrayConnection } from "./stingray-connection";
import { getTimestamp } from './utils/functions';

export const MAX_CONNECTIONS = 4;

export class ConnectionHandler {
	_compiler?: StingrayConnection;
	_game: Map<number, StingrayConnection>;
	_connectionOutputs: Map<StingrayConnection, vscode.OutputChannel>;
	_outputsByName: Map<string, vscode.OutputChannel>;

	constructor(){
		this._game = new Map();
		this._connectionOutputs = new Map();
		this._outputsByName = new Map();
	}

	closeAll() {
		this._compiler?.close();
		for (const [_port, game] of this._game) {
			game.close();
		}
	}

	getCompiler() {
		if (!this._compiler || this._compiler.isClosed) {
			this._compiler = new StingrayConnection(14032);
			this._addOutputChannel("Stingray Compiler", this._compiler);
		}
		return this._compiler;
	}

	getGame(port:number, ip?:string) {
		let game = this._game.get(port);
		if (!game || game.isClosed) {
			game = new StingrayConnection(port, ip);
			this._game.set(port, game);
			this._addOutputChannel(`Stingray (${port})`, game);
		}
		return game;
	}

	connectAllGames(portStart:number, range:number, ip?:string) {
		range = Math.min(range, MAX_CONNECTIONS);
		for (let i = 0; i < range; ++i) {
			this.getGame(portStart+i, ip);
		}
	}

	getAllGames() {
		const allGameConnections = [];
		for (const [_, game] of this._game) {
			if (!game.isClosed) {
				allGameConnections.push(game);
			}
		}
		return allGameConnections;
	}

	getOutputForConnection(connection:StingrayConnection) {
		return this._connectionOutputs.get(connection);
	}

	_addOutputChannel(name:string, connection:StingrayConnection) {
		let oldOutputChannel = this._outputsByName.get(name);
		if (oldOutputChannel) {
			oldOutputChannel.hide();
			oldOutputChannel.dispose();
			this._outputsByName.delete(name);
		}

		let outputChannel: vscode.OutputChannel;
		connection.onDidConnect.add(() => {
			outputChannel = vscode.window.createOutputChannel(name);
			outputChannel.show();
			this._connectionOutputs.set(connection, outputChannel);
			this._outputsByName.set(name, outputChannel);
			vscode.commands.executeCommand("fatshark-code-assist._refreshConnectedClients");
		});
		connection.onDidDisconnect.add((hadError:boolean) => {
			this._connectionOutputs.delete(connection);
			vscode.commands.executeCommand("fatshark-code-assist._refreshConnectedClients");
		});
		connection.onDidReceiveData.add((data:any) => {
			if (data.type === "message") {
				if (data.system) {
					outputChannel.appendLine(`${getTimestamp()}  [${data.level}][${data.system}] ${data.message}`);
				} else {
					outputChannel.appendLine(`${getTimestamp()}  [${data.level}] ${data.message}`);
				}
			}
			if (data.message_type === "lua_error") { // If it is an error, print extra diagnostics.
				outputChannel.appendLine(data.lua_callstack);
			}
		});
	}
}

export const connectionHandler = new ConnectionHandler;