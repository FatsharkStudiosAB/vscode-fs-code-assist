import { assert } from 'console';
import * as net from 'net';
import * as utils from './utils';

type EventType = "close" | "connect" | "data";

export class StingrayConnection {
    _socket : net.Socket;
    _ready : boolean = false;
    _closed : boolean = false;
    _error : boolean = false;

    _onCloseCallbacks: ((had_error: boolean) => void)[];
    _onConnectCallbacks: (() => void)[];
    _onDataCallbacks: ((data: any) => void)[];

    constructor(port:number, ip?:string) {
        this._onCloseCallbacks = [];
        this._onConnectCallbacks = [];
        this._onDataCallbacks = [];

        this._socket = new net.Socket();
        
        this._socket.on("close", this._onClose.bind(this));
        this._socket.on("connect", this._onConnect.bind(this));
        this._socket.on("data", this._onData.bind(this));

        this._connect(port, ip);
    }

    close() {
        this._socket.destroy();
    }

    on(event: EventType, listener: (...args: any[]) => void) {
        if (event === "data") {
            this._onDataCallbacks.push(listener);
        } else if (event === "connect") {
            this._onConnectCallbacks.push(listener);
        } else if (event === "close") {
            this._onCloseCallbacks.push(listener);
        }
    }

    off(event: EventType, listener: (...args: any[]) => void) {
        if (event === "data") {
            let idx = this._onDataCallbacks.indexOf(listener);
            this._onDataCallbacks.splice(idx, 1);
        } else if (event === "connect") {
            let idx = this._onConnectCallbacks.indexOf(listener);
            this._onConnectCallbacks.splice(idx, 1);
        } else if (event === "close") {
            let idx = this._onCloseCallbacks.indexOf(listener);
            this._onCloseCallbacks.splice(idx, 1);
        }
    }

    sendCommand(command:string, ...args:any) {
        let guid = utils.guid();
        this._send({
            id : guid,
            type : "command",
            command : command,
            arg : [...args]
        });
        return guid;
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

    _connect(port:number, ip?:string) {
        this._socket.connect(port, ip || '127.0.0.1');
    }

    _send(data: any) {
        const payload = JSON.stringify(data);
        const buffer = new Uint8Array(8 + payload.length);
        buffer[0] = 0;
        buffer[1] = 0;
        buffer[2] = 0;
        buffer[3] = 0;
    
        const len = payload.length;
        buffer[7] = len & 0xFF;
        buffer[6] = (len >> 8) & 0xFF;
        buffer[5] = (len >> 16) & 0xFF;
        buffer[4] = (len >> 24) & 0xFF;
        
        for (let i = 0; i < payload.length; i++ ) {
            buffer[8+i] = payload.charCodeAt(i);
        }
        this._socket.write(buffer);
    }

    _onConnect() {
        this._ready = true;
        this._onConnectCallbacks.forEach(callback => callback());
    }

    _onClose(hadError:boolean) {
        this._ready = false;
        this._closed = true;
        this._error = hadError;
        this._onCloseCallbacks.forEach(callback => callback(hadError));
    }

    _onData(data:Buffer) {
        let bufferIdx = 0;
        let bufferLen = data.length;
        while (bufferIdx < bufferLen) {
            let responseType = data.readInt32BE(bufferIdx);
            bufferIdx += 4;
            let bufferLen = data.readInt32BE(bufferIdx);
            bufferIdx += 4;
        
            if (responseType === 0) {
                let responseType = data.toString("binary", bufferIdx, bufferIdx+bufferLen).replace(/\0+$/g,"");
                let response = JSON.parse(responseType);
                this._onDataCallbacks.forEach(callback => callback(response));
            } else {
                assert(false, "PANICKKCKCKCKCK: "+ JSON.stringify(this._socket.address()));
            }

            bufferIdx += bufferLen;
        }
    }
}