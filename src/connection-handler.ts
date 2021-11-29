import * as vscode from 'vscode';
import { StingrayConnection } from "./stingray-connection";

export class ConnectionHandler {
    _compiler?: StingrayConnection;
    _game: Map<number, StingrayConnection>;

    constructor(){
        this._game = new Map();
    }

    closeAll() {
        this._compiler?.close();
        for (let [port, game] of this._game) {
            console.log(port);
            game.close();
        }
    }

    getCompiler() {
        if (!this._compiler || this._compiler.isClosed()) {
            this._compiler = new StingrayConnection(14032);
            this._addOutputChannel("Stingray Compiler", this._compiler);
        }
        return this._compiler;        
    }

    getGame(port:number) {
        let game = this._game.get(port);
        if (!game || game.isClosed()) {
            game = new StingrayConnection(port);
            this._game.set(port, game);
            this._addOutputChannel(`Stingray (${port})`, game);
        }
        return game;
    }

    connectAllGames(portStart:number, range:number) {
        
    }

    getAllGames() {
        let allGameConnections = [];
        for (let i = 0; i < 32; i++){
            allGameConnections[i] = this.getGame(14000+i);
        }
        // for (let [port, game] of this._game) {
        //     if (!game.isClosed()) {
        //         allGameConnections.push(game);
        //     }
        // }
        return allGameConnections;
    }

    _addOutputChannel(name:string, connection:StingrayConnection) {
        const outputChannel = vscode.window.createOutputChannel(name);
        connection.on("data", (response:any)=>{
            if (response.message) {
                outputChannel.appendLine(`[${response.level}][${response.system}] ${response.message}`);
            }
        });
        connection.on("connect", ()=>{
            outputChannel.show();
        });
        connection.on("close", (hadError:boolean)=>{
            outputChannel.hide();
            outputChannel.dispose();
        });
    }
}

export let connectionHandler = new ConnectionHandler;