import * as vscode from 'vscode';
import * as SJSON from 'simplified-json';
import * as fs from 'fs';
import { LoggingDebugSession, DebugSession, Breakpoint, Source, OutputEvent, InitializedEvent, StoppedEvent, Thread, BreakpointEvent, StackFrame } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { StingrayConnection } from './stingray-connection';
import { connectionHandler } from './connection-handler';
import { join } from 'path';
import { privateEncrypt } from 'crypto';

interface StingrayBreakpoints {
    [key: string]: number[];
}

const THREAD_ID = 1;
class StingrayDebugSession extends LoggingDebugSession {

    connection?: StingrayConnection;
    breakpoints: Map<string, DebugProtocol.Breakpoint[]>;
    lastBreakpointId: number;
    callstack: any | null;
    projectRoot: string;

    constructor() {
        super('');
        this.breakpoints = new Map<string, DebugProtocol.Breakpoint[]>();
        this.lastBreakpointId = 0;
        this.projectRoot = "d:/vt2/";
    }

    /**
     * The 'initialize' request is the first request called by the frontend
     * to interrogate the features the debug adapter provides.
     */
    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        // Set supported features
        if (!response.body) {
            return;
        }

        response.body.supportsEvaluateForHovers = false;
        response.body.supportsConfigurationDoneRequest = false;
        response.body.supportsRestartRequest = false;
        response.body.supportsSetVariable = false;
        response.body.exceptionBreakpointFilters = [
            {
                filter: "error",
                label: "Uncaught Exception",
                default: true,
            }
        ];

        this.sendResponse(response);
    }

    /**
     * Attach to the engine console server using web sockets.
     */
    protected attachRequest(response: DebugProtocol.AttachResponse, args:any): void {
        this.connection = new StingrayConnection(14000);
        
        // this.connection = connectionHandler.getGame(14000);
        // // var ip = args.ip;
        // // var port = args.port;

        // // let toolchainPath = this.getToolchainPath(args.toolchain);
        // // if (toolchainPath == null)
        // //     return;

        // // //Initiate project paths and id string lookup
        // // this.initProjectPaths(toolchainPath);
        // // // Establish web socket connection with engine.
        // // this.connectToEngine(ip, port, response);
        this.connection.on("data", this.onStingrayMessage.bind(this));
        this.connection.on("connect", ()=>{ 
            this.log("We are connected!"); 
            this.connection?.sendDebuggerCommand('report_status');
            this.sendEvent(new InitializedEvent());
            this.sendResponse(response);
        });
    }

    public shutdown(): void {
        this.connection?.sendDebuggerCommand('set_breakpoints', {breakpoints: {}});
        this.connection?.sendDebuggerCommand('continue');
	}

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
        this.shutdown();
        this.connection?.close();
        this.connection = undefined;

        this.sendResponse(response);
    }

    private log(message:string) {
        this.sendEvent(new OutputEvent(message + '\r\n'));
    }

    protected onStingrayMessage(data:any) {
        // if (e.requestId) {
        //     let pendingRequest = this._requests.get(e.requestId);
        //     if (pendingRequest) {
        //         this._requests.delete(e.node_index);
        //         pendingRequest.resolve([e, data]);
        //         return;
        //     }
        // }

       if (data.type === "lua_debugger"){
            this.log(JSON.stringify(data));
            if (data.message === 'halted') {
                let line = data.line;
                let isMapped = data.source[0] === '@';
                let resourcePath = isMapped ? data.source.slice(1) : data.source;
                let haltReason = 'paused';
                if (this.breakpoints.has(resourcePath)) {
                    let fileBreakpoints = this.breakpoints.get(resourcePath);
                    let bp = fileBreakpoints?.find(bp => bp.line === line);
                    if (bp) {
                        this.log("breakpoint halt");
                        bp.verified = true;
                        this.sendEvent(new BreakpointEvent("update", bp));
                        haltReason = 'breakpoint';
                    }
                }

                this.sendEvent(new StoppedEvent(haltReason, THREAD_ID));
            } else if (data.message === 'callstack') {
                this.callstack = data.stack;
            }
        }
    }

    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
        let filePath = args.source.path;
        let clientLines = args.lines;
        let validScript = true;

        // Find resource root looking for settings.ini or .stingray-asset-server-directory
        let resourcePath = filePath;
        const resourceName = resourcePath?.replace(/\\/g, '/').replace(this.projectRoot, "") || "???";
        this.log(resourceName);

        // Verify breakpoint locations
        if (clientLines && resourceName){
            var vsBreakpoints = new Array<Breakpoint>();
            let breakpointId = this.lastBreakpointId;
            clientLines.forEach(line => {
                let bp = <DebugProtocol.Breakpoint> new Breakpoint(validScript, line, 0, new Source(resourceName, filePath));
                bp.id = breakpointId;
                vsBreakpoints.push(bp);
                breakpointId += 1;
            });
            this.lastBreakpointId = breakpointId;
            this.breakpoints.set(resourceName, validScript ? vsBreakpoints : []);
            response.body = { breakpoints: vsBreakpoints };
            this.sendResponse(response);

            // need to send all of them at once since it clears them every time new ones are sent
            let stingrayBreakpoints = <StingrayBreakpoints>{};
            this.breakpoints.forEach((breakpoints, resourceName) => {
                if (vsBreakpoints.length > 0) {
                    let bpLines = <number[]>[];
                    breakpoints.forEach(bp => {
                        if (bp.line) {
                            bpLines.push(bp.line);
                        }
                    });
                    this.log(resourceName + bpLines.toString());
                    stingrayBreakpoints[resourceName] = bpLines;
                }
            });
            this.log("set breakpoints: " + JSON.stringify({ breakpoints: stingrayBreakpoints }));
            this.connection?.sendDebuggerCommand('set_breakpoints', { breakpoints: stingrayBreakpoints });
        }
    }

    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
        this.log("configurationDoneRequest");

        // In case the engine is waiting for the debugger, let'S tell him we are ready.
        // if (this._waitingForBreakpoints) {
        //     this._conn.sendDebuggerCommand('continue');
        //     this._waitingForBreakpoints = false;
        // }

        this.sendResponse(response);
    }

    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
        this.log("break");
        this.connection?.sendDebuggerCommand('break');
        this.sendResponse(response);
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        this.log("continue");
        this.connection?.sendDebuggerCommand('continue');
        this.sendResponse(response);
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        this.log("step_over");

        this.connection?.sendDebuggerCommand('step_over');
        this.sendResponse(response);
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
        this.log("step_into");

        this.connection?.sendDebuggerCommand('step_into');
        this.sendResponse(response);
    }

    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
        this.log("step_out");

        this.connection?.sendDebuggerCommand('step_out');
        this.sendResponse(response);
    }

    // protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
    //     this.sendResponse(response);
    // }

    // protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
    //     this.sendResponse(response);
    // }

    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
        // if (!this.callstack) {
        //     return this.sendErrorResponse(response, 1000, "No callstack available");
        // }

        // const scopeContent = this._scopesContent.get(args.variablesReference);
        // if (!scopeContent) {
        //     throw new Error('Unknown variablesReference ' + args.variablesReference);
        // }

        // if (scopeContent.dataReady()) {
        //     response.body = {
        //         variables: scopeContent.getVariables()
        //     };
        //     return this.sendResponse(response);
        // }

        // this.fetchScopeData(scopeContent).then(() => {
        //     response.body = {
        //         variables: scopeContent.getVariables()
        //     };
        //     this.sendResponse(response);
        // });
        this.sendResponse(response);
    }

    // protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
    //     this.sendResponse(response);
    // }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        response.body = { threads: [ new Thread(THREAD_ID, "thread 1") ] };
        this.sendResponse(response);
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
        if (!this.callstack) {
            return this.sendErrorResponse(response, 1000, "No callstack available");
        }

        let i = 0;
        let stack = this.callstack;
        const frames = new Array<StackFrame>();
        for (let frame of stack) {
            let isMapped = frame.source[0] === '@';
            let resourcePath = isMapped ? frame.source.slice(1) : frame.source;
            // TODO: read and parse lua at line of function start.
            let name = frame.function ? `${frame.function} @ ${resourcePath}:${frame.line}` :
                                        `${resourcePath}:${frame.line}`;
            let filePath = this.getResourceFilePath(frame.source);
            this.log(filePath);

            frames.push(new StackFrame(i++, name, new Source(frame.source, filePath), frame.line, 0));
        }
        response.body = {
            stackFrames: frames,
            totalFrames: frames.length
        };
        this.sendResponse(response);
    }

    private getResourceFilePath(source: string) {
        let isMapped = source[0] === '@';
        let resourcePath = isMapped ? source.slice(1) : source;
        
        return join(this.projectRoot, resourcePath);
    }
}

DebugSession.run(StingrayDebugSession);