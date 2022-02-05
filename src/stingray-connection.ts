import { Socket } from 'net';
import * as utils from './utils/functions';
import Multicast from './utils/multicast';

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
	readonly onDidConnect = new Multicast();
	readonly onDidDisconnect = new Multicast();
	readonly onDidReceiveData = new Multicast();

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

	private _send(data: any) {
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

	private _onConnect() {
		this.isReady = true;
		this.onDidConnect.fire();
	}

	private _onClose(hadError: boolean) {
		this.isReady = false;
		this.isClosed = true;
		this.hadError = hadError;
		this.onDidDisconnect.fire(hadError);
	}

	private _onError(err: Error) {
		console.error(err.toString());
	}

	private sink?: {
		bytes: number,
		resolve: (data: Buffer) => void,
		reject: () => void,
	} | null;

	private async _readBytes(bytes: number) : Promise<Buffer> {
		const maxChunkSize = this.socket.readableHighWaterMark;
		if (bytes <= maxChunkSize) {
			return new Promise((resolve, reject) => {
				this.sink = { resolve, reject, bytes };
				this._pump();
			});
		} else {
			const buf = Buffer.alloc(bytes);
			let pos = 0;
			while (bytes > 0) {
				const chunk = await this._readBytes(Math.min(bytes, maxChunkSize));
				chunk.copy(buf, pos);
				pos += chunk.length;
				bytes -= chunk.length;
			}
			return buf;
		}
	}

	private _pump() {
		const { sink, socket } = this;
		if (sink) {
			const buf: Buffer | null = socket.read(sink.bytes);
			if (buf) {
				if (buf.length === sink.bytes) {
					sink.resolve(buf);
				} else {
					sink.reject(); // Stream has ended.
				}
				this.sink = null;
			}
		}
	}

	private async _startMessagePump(): Promise<never> {
		this.socket.on('readable', () => this._pump());

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

			// For some reason, messages can include trailing garbage. We clean it up before parsing.
			const jsonBuffer = await this._readBytes(jsonLength);
			const jsonString = jsonBuffer.toString('utf8').replace(/\0+$/g, '');
			const json = JSON.parse(jsonString);

			// Read the binary.
			let binary;
			if (binaryLength) {
				binary = await this._readBytes(binaryLength);
			}

			this.onDidReceiveData.fire(json, binary);
		}
	}
}