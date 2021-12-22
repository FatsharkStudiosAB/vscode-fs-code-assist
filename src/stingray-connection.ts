import { Socket } from 'net';
import * as utils from './utils';

enum MessageType { // Must be the same as in engine.
	json = 0,
	jsonWithBinary = 1,
}

export class StingrayConnection {
	// Internal state.
	private _socket : Socket;
	private _ready : boolean = false;
	private _closed : boolean = false;
	private _error : boolean = false;

	// Public properties & read-only accessors.
	readonly name : string;
	get isReady() { return this._ready; }
	get isClosed() { return this._closed; }
	get hadError() { return this._error; }
	readonly onDidConnect = new utils.Multicast();
	readonly onDidDisconnect = new utils.Multicast();
	readonly onDidReceiveData = new utils.Multicast();

	constructor(readonly port: number, readonly ip: string = '127.0.0.1') {
		this.port = port;
		this.name = `Stingray (${this.ip}:${port})`;

		this._socket = new Socket();
		this._socket.on("close", this._onClose.bind(this));
		this._socket.on("connect", this._onConnect.bind(this));
		this._socket.connect(this.port, this.ip);
		this._socket.pause(); // Pull mode.
		this._pumpMessages();
	}

	close() {
		this._socket.destroy();
	}

	sendCommand(command: string, ...args: any) {
		let guid = utils.uuid4();
		this._send({
			id : guid,
			type : "command",
			command : command,
			arg : [...args]
		});
		return guid;
	}

	sendDebuggerCommand(command: string, data?: any) {
		this._send(Object.assign({
			type: "lua_debugger",
			command: command
		}, data));
	}

	sendJSON(object: any) {
		this._send(object);
	}

	sendLua(text: string) {
		this._send({
			type : "script",
			script: text
		});
	}

	_send(data: any) {
		// 2021-12-21: TCP fragmentation crashes the engine so we try to
		// prevent it by sending a datagram in a single .write() call.
		const payload = JSON.stringify(data);
		const length = Buffer.byteLength(payload, "utf8");
		const buffer = Buffer.alloc(length + 8);
		buffer.writeInt32BE(MessageType.json, 0);
		buffer.writeInt32BE(length, 4);
		buffer.subarray(8).write(payload, 'utf8');
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

	async _readBytes(n: number) : Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const socket = this._socket;
			if (!socket.readable) {
				return reject();
			}
			socket.once("end", () => reject());

			socket.on("readable", function onReadable() {
				if (socket.readableLength >= n) {
					resolve(socket.read(n));
					socket.off("readable", onReadable);
				}
			});
		});
	}

	async _pumpMessages() {
		while (true) {
			// Read and process the header.
			const header = await this._readBytes(8);
			const messageType = header.readUInt32BE(0) as MessageType;
			const messageLength = header.readUInt32BE(4);

			// Calculate the length of the JSON and binary payloads.
			let jsonLength;
			let binaryLength;
			if (messageType === MessageType.json) {
				jsonLength = messageLength;
				binaryLength = 0;
			} else if (messageType === MessageType.jsonWithBinary) {
				let binaryOffset = (await this._readBytes(4)).readUInt32BE(0);
				jsonLength = binaryOffset - 4;
				binaryLength = messageLength - binaryOffset;
			} else {
				throw new Error(`Unknown messageType ${messageType} at socket ${this._socket.remoteAddress}`);
			}

			// Read the JSON.
			const jsonBuffer = await this._readBytes(jsonLength);
			const json = JSON.parse(jsonBuffer.toString("utf8").replace(/\0+$/g, ""));
			// For some reason, messages can include trailing garbage. We clean it up.

			// Read the binary.
			let binary;
			if (binaryLength) {
				binary = await this._readBytes(binaryLength);
			}

			this.onDidReceiveData.fire(json, binary);
		}
	}
}