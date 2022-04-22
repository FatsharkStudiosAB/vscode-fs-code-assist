// Handles connections to stingray compile server and game clients.
// Handles creating and hooking to VS Code Output windows.
// Handles "Connected Clients" side panel refreshing.

import * as vscode from 'vscode';
import { StingrayConnection } from "./stingray-connection";
import { getTimestamp } from './utils/functions';

export const MAX_CONNECTIONS = 4;

const IDENTIFY_TIMEOUT = 5000; // Milliseconds.
const IDENTIFY_LUA = `
--[[ print("[VSCode] Identifying instance...") ]]
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
		profiler_port = GET(Application, "profiler_port"),
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

export class ConnectionHandler {
	private _compiler?: StingrayConnection;
	private _game = new Map<number, StingrayConnection>();
	private _connectionOutputs = new Map<StingrayConnection, vscode.OutputChannel>();
	private _identifyInfo = new Map<StingrayConnection, Promise<any>>();
	private _outputsByName = new Map<string, vscode.OutputChannel>();

	closeAll() {
		this._compiler?.close();
		for (const [_port, game] of this._game) {
			game.close();
		}
	}

	getCompiler() {
		if (!this._compiler || this._compiler.isClosed) {
			this._compiler = new StingrayConnection(14032);
			this._addOutputChannel("Stingray Compiler", this._compiler, false);
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

	_addOutputChannel(name:string, connection:StingrayConnection, show: boolean = true) {
		let oldOutputChannel = this._outputsByName.get(name);
		if (oldOutputChannel) {
			oldOutputChannel.hide();
			oldOutputChannel.dispose();
			this._outputsByName.delete(name);
		}

		let outputChannel: vscode.OutputChannel;
		connection.onDidConnect.add(() => {
			outputChannel = vscode.window.createOutputChannel(name);
			if (show) {
				outputChannel.show();
			}
			this._connectionOutputs.set(connection, outputChannel);
			this._outputsByName.set(name, outputChannel);
			vscode.commands.executeCommand("fatshark-code-assist._refreshConnectedClients");
		});
		connection.onDidDisconnect.add((hadError: boolean) => {
			this._connectionOutputs.delete(connection);
			this._identifyInfo.delete(connection);
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

	identify(connection: StingrayConnection, forceRefresh?: boolean): Promise<any | null> {
		if (forceRefresh) {
			this._identifyInfo.delete(connection);
		} else {
			const info = this._identifyInfo.get(connection);
			if (info) {
				return info;
			}
		}

		let onData: (data: any) => void;
		let timeoutId: NodeJS.Timeout;

		const identifyResult = new Promise<any>(async (resolve) => {
			connection.onDidReceiveData.add(onData = (data: any) => {
				if (data.type === "stingray_identify") {
					resolve(data.info);
				}
			});
			timeoutId = setTimeout(resolve, IDENTIFY_TIMEOUT, null);
		});
		identifyResult.finally(() => {
			connection.onDidReceiveData.remove(onData);
			clearTimeout(timeoutId);
		});
		this._identifyInfo.set(connection, identifyResult);
		connection.sendLua(IDENTIFY_LUA);
		return identifyResult;
	}
}

export const connectionHandler = new ConnectionHandler;