// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as net from 'net'
import { time, timeStamp } from 'console';

/**
 * Returns a GUID
 * RFC 4122 Version 4 Compliant solution:
 * http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript
 * @memberOf stingray
 * @return {string}
 */
 export function guid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random()*16|0, v = c === 'x' ? r : (r&0x3|0x8);
        return v.toString(16);
    });
};

var compiler_socket = new net.Socket();
var game_socket = new net.Socket();
var last_recompile_uuid = "";
var command_queue = new Array();
var _compiler_socker_ready = false;
var _game_socket_ready = false;

export function sendJSON(socket: net.Socket, data: any) {
	const payload = JSON.stringify(data);
	const buffer = new Uint8Array(8 + payload.length);
	buffer[0] = 0;
	buffer[1] = 0;
	buffer[2] = 0;
	buffer[3] = 0;

	let len = payload.length
	buffer[7] = len & 0xFF;
	buffer[6] = (len >> 8) & 0xFF;
	buffer[5] = (len >> 16) & 0xFF;
	buffer[4] = (len >> 24) & 0xFF;
	
	for (var i = 0; i < payload.length; i++ ) {
		buffer[8+i] = payload.charCodeAt(i);
	}
	socket.write(buffer)
}

export function executeCommandQueue() {
	command_queue.forEach(command => {
		vscode.commands.executeCommand(command);
	});
	command_queue.length = 0;
}

export function makeConnection(client_id:number) {
	if (!_compiler_socker_ready && !compiler_socket.connecting) {
		compiler_socket.connect(14032, '127.0.0.1', function(){
			console.log("compiler connect");

			if (isConnected(client_id)) {
				executeCommandQueue();
			}
		});
	}

	if (!_game_socket_ready && !game_socket.connecting) {
		game_socket.connect(14000+client_id, '127.0.0.1', function(){
			console.log("game connect");

			if (isConnected(client_id)) {
				executeCommandQueue();
			}
		});
	}
}

export function isConnected(client_id:number) {
	return _compiler_socker_ready && _game_socket_ready;
}

function getTimestamp() {
	let date = new Date();
	let hh = date.getHours();
	let mm = date.getMinutes();
	let ss = date.getSeconds();
	let ms = date.getMilliseconds();
	return `${hh}:${mm}:${ss}.${ms}`;
}

export function activate(context: vscode.ExtensionContext) {
	let output_channel = vscode.window.createOutputChannel("Stingray");
	output_channel.show(true);
	compiler_socket.on("ready", function(){
		_compiler_socker_ready = true;
	});
	game_socket.on("ready", function(){
		_game_socket_ready = true;
	});
	compiler_socket.on("end", function(){
		_compiler_socker_ready = false;
	});
	game_socket.on("end", function(){
		_game_socket_ready = false;
	});
	compiler_socket.on("data", function(data){
		let buffer_idx = 0
		let buffer_len = data.length
		while (buffer_idx < buffer_len) {
			let response_type = data.readInt32BE(buffer_idx);
			buffer_idx += 4;
			let response_len = data.readInt32BE(buffer_idx);
			buffer_idx += 4;

			if (response_type == 0) {
				let response_text = data.toString("binary", buffer_idx, buffer_idx+response_len).replace(/\0+$/g,"");
				
				let response = JSON.parse(response_text);
				
				if ('finished' in response) {
					if (response.id == last_recompile_uuid) {
						output_channel.appendLine("Content refresh triggered!");
						const refresh_cmd = {
							id : guid(),
							type : "command",
							command : "refresh",
							arg : [],
						};
						if (game_socket.readable) {
							sendJSON(game_socket, refresh_cmd);
						}

						const unpause_cmd = {
							id : guid(),
							type : "command",
							command : "game",
							arg : ["unpause"],
						};
						if (game_socket.readable) {
							sendJSON(game_socket, unpause_cmd);
						}
					}
				}
			}
			buffer_idx += response_len;
		}
	});

	
	game_socket.on("data", function(data){
		let buffer_idx = 0;
		let buffer_len = data.length;

		let timestamp = getTimestamp();
		
		while (buffer_idx < buffer_len) {
			let response_type = data.readInt32BE(buffer_idx);
			buffer_idx += 4;
			let response_len = data.readInt32BE(buffer_idx);
			buffer_idx += 4;
			if (response_type == 0) {
				let response_text = data.toString("binary", buffer_idx, buffer_idx+response_len).replace(/\0+$/g,"");
				let response = JSON.parse(response_text);
				if (response.type === "message") {
					output_channel.appendLine(`[${timestamp}][${response.level}][${response.system}] ${response.message}`);
				}
			}
			buffer_idx += response_len;
		}
	});

	let stingrayRecompile = vscode.commands.registerCommand('fatshark-code-assist.stingrayRecompile', () => {
		if (!isConnected(0)){
			command_queue.push("fatshark-code-assist.stingrayRecompile");
			makeConnection(0);
		} else {
			output_channel.appendLine("Recompile triggered!");

			let config = vscode.workspace.getConfiguration("stingray");
			let engine_path = config.get("engine_path");
			let source_dir = config.get("source_dir"); 
			let data_dir = config.get("data_dir"); 
			let platform = config.get("platform");
	
			last_recompile_uuid = guid();
			var cmd = {
				id : last_recompile_uuid,
				type : "compile",
				"source-directory" : source_dir,
				"source-directory-maps" : [
					{ directory : "core", root : engine_path }
				],
				"data-directory" : data_dir,
				platform : platform,
			};
			
			sendJSON(compiler_socket, cmd);
		}
	});
	context.subscriptions.push(stingrayRecompile);

	let stingrayConnect = vscode.commands.registerCommand('fatshark-code-assist.stingrayConnect', () => {
		makeConnection(0);
	});
	context.subscriptions.push(stingrayConnect);
}

// this method is called when your extension is deactivated
export function deactivate() {
	compiler_socket.destroy();
	game_socket.destroy();
}
