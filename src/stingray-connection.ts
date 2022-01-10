import { Socket } from 'net';
import * as utils from './utils/functions';
import * as Multicast from './utils/multicast';

enum MessageType { // Must be the same as in engine.
	Json = 0,
	JsonWithBinary = 1,
}

export class StingrayConnection {
	private socket : Socket;
	public isReady : boolean = false;
	public isClosed : boolean = false;
	public hadError : boolean = false;
	readonly name : string;
	readonly onDidConnect = new Multicast.Multicast();
	readonly onDidDisconnect = new Multicast.Multicast();
	readonly onDidReceiveData = new Multicast.Multicast();

	constructor(readonly port: number, readonly ip: string = '127.0.0.1') {
		this.port = port;
		this.name = `Stingray (${this.ip}:${port})`;

		this.socket = new Socket();
		this.socket.on('close', this._onClose.bind(this));
		this.socket.on('ready', this._onConnect.bind(this));
		this.socket.on('error', this._onError.bind(this));
		this.socket.connect(this.port, this.ip);
		this.socket.pause(); // Pull mode.
		this._startMessagePump().finally(() => {
			this.socket.destroy();
		});
	}

	close() {
		this.socket.destroy();
	}

	sendCommand(command: string, ...args: any) {
		let guid = utils.uuid4();
		this._send({
			id : guid,
			type : 'command',
			command : command,
			arg : [...args]
		});
		return guid;
	}

	sendDebuggerCommand(command: string, data?: any) {
		this._send(Object.assign({
			type: 'lua_debugger',
			command: command
		}, data));
	}

	sendJSON(object: any) {
		this._send(object);
	}

	sendLua(text: string) {
		this._send({
			type : 'script',
			script: text
		});
	}

	_send(data: any) {
		// 2021-12-21: TCP fragmentation crashes the engine so we try to
		// prevent it by sending a datagram in a single .write() call.
		const payload = JSON.stringify(data);
		const length = Buffer.byteLength(payload, 'utf8');
		const buffer = Buffer.alloc(length + 8);
		buffer.writeInt32BE(MessageType.Json, 0);
		buffer.writeInt32BE(length, 4);
		buffer.subarray(8).write(payload, 'utf8');
		this.socket.write(buffer);
	}

	_onConnect() {
		this.isReady = true;
		this.onDidConnect.fire();
	}

	_onClose(hadError: boolean) {
		this.isReady = false;
		this.isClosed = true;
		this.hadError = hadError;
		this.onDidDisconnect.fire(hadError);
	}

	_onError(err: Error) {
		console.error(err.toString());
	}

	private sink?: {
		bytes: number,
		resolve: (data: Buffer) => void,
		reject: () => void,
	} | null;

	async _readBytes(bytes: number) : Promise<Buffer> {
		return new Promise((resolve, reject) => {
			this.sink = { resolve, reject, bytes };
			this._pump();
		});
	}

	_pump() {
		const { sink, socket } = this;
		if (sink && socket.readable && socket.readableLength >= sink.bytes) {
			sink.resolve(socket.read(sink.bytes));
			this.sink = null;
		}
	}

	async _startMessagePump() {
		this.socket.on('readable', () => this._pump());
		this.socket.on('end', () => this.sink?.reject());

		while (true) {
			// Read and process the header.
			const header = await this._readBytes(8);
			const messageType = header.readUInt32BE(0) as MessageType;
			const messageLength = header.readUInt32BE(4);

			// Calculate the length of the JSON and binary payloads.
			let jsonLength;
			let binaryLength;
			if (messageType === MessageType.Json) {
				jsonLength = messageLength;
				binaryLength = 0;
			} else if (messageType === MessageType.JsonWithBinary) {
				let binaryOffset = (await this._readBytes(4)).readUInt32BE(0);
				jsonLength = binaryOffset - 4;
				binaryLength = messageLength - binaryOffset;
			} else {
				throw new Error(`Unknown messageType ${messageType} at socket ${this.socket.remoteAddress}`);
			}

			// Read the JSON.
			const jsonBuffer = await this._readBytes(jsonLength);
			const json = JSON.parse(jsonBuffer.toString('utf8').replace(/\0+$/g, ''));
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