import * as net from 'net';
import { TextEncoder } from 'util';
import * as utils from './utils';
import { Multicast } from './utils';

const DEFAULT_IP = '127.0.0.1';

enum MessageType { // Must be the same as in engine.
	Json = 0,
	JsonWithBinary = 1,
}

export class StingrayConnection {
	_socket : net.Socket;
	_ready : boolean = false;
	_closed : boolean = false;
	_error : boolean = false;
	_name : string;

	private _encoder = new TextEncoder();

	onDidConnect = new Multicast();
	onDidDisconnect = new Multicast();
	onDidReceiveData = new Multicast();

	constructor(port: number, ip?: string) {
		this._name = `Stingray (${ip||DEFAULT_IP}:${port})`;

		this._socket = new net.Socket();
		this._socket.on("close", this._onClose.bind(this));
		this._socket.on("connect", this._onConnect.bind(this));
		this._socket.on("data", this._onData.bind(this));
		this._connect(port, ip);
	}

	close() {
		this._socket.destroy();
	}

	sendCommand(command:string, ...args:any) {
		let guid = utils.uuid4();
		this._send({
			id : guid,
			type : "command",
			command : command,
			arg : [...args]
		});
		return guid;
	}

	sendDebuggerCommand(command: string, data?:any) {
		this._send(Object.assign({
			type: "lua_debugger",
			command: command
		}, data));
	}

	sendJSON(object:any) {
		this._send(object);
	}

	sendLua(text:string) {
		this._send({
			type : "script",
			script: text
		});
	}

	isReady() { return this._ready; }
	isClosed() { return this._closed; }
	hadError() { return this._error; }
	getName() { return this._name; }

	_connect(port:number, ip?:string) {
		this._socket.connect(port, ip || DEFAULT_IP);
	}

	_send(data: any) {
		const payload = JSON.stringify(data);
		const length = Buffer.byteLength(payload, "utf8");
		const buffer = new Uint8Array(8 + length);

		buffer[0] = 0;
		buffer[1] = 0;
		buffer[2] = 0;
		buffer[3] = 0;

		buffer[4] = 0xFF & (length >> 24);
		buffer[5] = 0xFF & (length >> 16);
		buffer[6] = 0xFF & (length >> 8);
		buffer[7] = 0xFF & length;

		this._encoder.encodeInto(payload, buffer.subarray(8));
		this._socket.write(buffer);
	}

	_onConnect() {
		this._ready = true;
		this.onDidConnect.fire();
	}

	_onClose(hadError: boolean) {
		this._ready = false;
		this._closed = true;
		this._error = hadError;
		this.onDidDisconnect.fire(hadError);
	}

	_onData(data:Buffer) {
		for (let bufferIdx = 0; bufferIdx < data.length ;) {
			// Parse message header.
			const messageType = data.readInt32BE(bufferIdx);
			bufferIdx += 4;
			const messageLength = data.readInt32BE(bufferIdx);
			bufferIdx += 4;

			let jsonLength = messageLength;

			let binaryOffset = 0;
			if (messageType === MessageType.JsonWithBinary) {
				binaryOffset = data.readInt32BE(bufferIdx) - 4; // Subtract itself.
				bufferIdx += 4;
				jsonLength = binaryOffset;
			}

			// Read the JSON part.
			let json = null;
			if (messageType === MessageType.Json || messageType === MessageType.JsonWithBinary) {
				const jsonString = data.toString("utf8", bufferIdx, bufferIdx+jsonLength).replace(/\0+$/g,"");
				json = JSON.parse(jsonString);
			} else {
				throw new Error("PANIC: Unknown messageType at socket " + JSON.stringify(this._socket.address()));
			}

			// Read the binary part.
			let binary = undefined;
			if (binaryOffset) {
				binary = data.subarray(bufferIdx + binaryOffset, messageLength - binaryOffset -8);
			}

			this.onDidReceiveData.fire(json); // TODO: Pass in binary data too.

			bufferIdx += messageLength;
		}
	}
}