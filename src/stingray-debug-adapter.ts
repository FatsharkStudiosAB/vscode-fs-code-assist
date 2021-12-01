import * as vscode from 'vscode';
import * as SJSON from 'simplified-json';
import * as fs from 'fs';
import { DebugSession, Breakpoint, Source, OutputEvent, InitializedEvent, StoppedEvent, Thread, BreakpointEvent, StackFrame, Scope, Variable } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { StingrayConnection } from './stingray-connection';
import { join } from 'path';

interface StingrayBreakpoints {
    [key: string]: number[];
}

interface StingrayScopeContent {
    variablesReference: number;
    frameId: number;
    scopeId: string;
    variables: Variable[];
}

interface StingrayTableValue {
    type: string;
    value: string;
    var_name: string;
}

class ScopeContent {
    tableVarName?: string;
    tablePath?: Array<number>;
    variables?: Variable[];

    constructor(
        public variablesReference: number,
        public frameId: number,
        public scopeId: string
    ) {
        
    }

    public dataReady () : boolean {
        return this.variables !== null;
    }

    public isTable() : boolean {
        return !!this.tableVarName;
    }

    public getVariables() : any {
        if (!this.dataReady()) {
            throw new Error('Data not ready');
        }

        return this.variables;
    }

    public getVariable(name: string) : any {
        if (!this.dataReady()) {
            throw new Error('Data not ready');
        }

        return this.variables?.find((variable: { name: string; }) => variable.name === name);
    }

    public toString() {
        let path = this.tablePath ? this.tablePath.join(',') : "";
        return `Scope[
            id: ${this.variablesReference},
            scopeId: ${this.scopeId},
            tableVarName: ${this.tableVarName},
            tablePath: ${path}
        ]`;
    }
}

const THREAD_ID = 1;
const SCOPE_DESCS : { [key:string] : string; } = {
    local: 'Local',
    up_values: 'Up Values',
};

class StingrayDebugSession extends DebugSession {

    connection?: StingrayConnection;
    breakpoints: Map<string, DebugProtocol.Breakpoint[]>;
    lastBreakpointId: number;
    lastVariableReferenceId: number;
    callstack: any | null;
    projectRoot: string;

    /// yarhar
    private _requestId : number = 1;
    private _topLevelScopes = new Array<ScopeContent>();
    private _scopesContent = new Map<number, ScopeContent>();
    private _variableReferenceId : number = 1;
    private _requests: Map<number, any> = new Map<number, any>();
    ///

    allScopesContent = new Map<number, StingrayScopeContent>();
    // topLevelScopes = new Array<ScopeContent>();

    constructor() {
        super();
        this.breakpoints = new Map<string, DebugProtocol.Breakpoint[]>();
        this.allScopesContent = new Map<number, StingrayScopeContent>();
        this.lastBreakpointId = 0;
        this.lastVariableReferenceId = 0;
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
            if (data.node_index || data.requestId) {
                this.log("maybe pending");

                let pendingRequest = this._requests.get(data.node_index || data.requestId);
                if (pendingRequest) {
                    this.log("resplve pending " + data.node_index || data.requestId);

                    this._requests.delete(data.node_index);
                    pendingRequest.resolve([data, data]);
                }
            } else if (data.message === 'halted') {
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

    // protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
    //     if (!this.callstack) {
    //         return this.sendErrorResponse(response, 1000, "No callstack available");
    //     }
        
    //     const scopes = new Array<Scope>();
    //     for (const scopeId in SCOPE_DESCS) {
    //         const scopeName = SCOPE_DESCS[scopeId];
    //         let scopeContent = this.createScopeContent(args.frameId, scopeId);
    //         scopeContent.variables = this.translateStingrayVariables(this.callstack[args.frameId][scopeId]);
    //         scopes.push(new Scope(scopeName, scopeContent.variablesReference, false));
    //     }

    //     response.body = { scopes: scopes };
    //     this.sendResponse(response);
    // }

    // protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
    //     if (!this.callstack) {
    //         return this.sendErrorResponse(response, 1000, "No callstack available");
    //     }

    //     const scopeContent = this.getScopeContent(args.variablesReference);
    //     if (!scopeContent) {
    //         throw new Error('Unknown variablesReference ' + args.variablesReference);
    //     }

    //     // if (scopeContent.dataReady()) {
    //     //     response.body = {
    //     //         variables: scopeContent.getVariables()
    //     //     };
    //     //     return this.sendResponse(response);
    //     // }

    //     // this.fetchScopeData(scopeContent).then(() => {
    //     //     response.body = {
    //     //         variables: scopeContent.getVariables()
    //     //     };
    //     //     this.sendResponse(response);
    //     // });

    //     response.body = {
    //         variables : scopeContent.variables,
    //     };
    //     this.sendResponse(response);
    // }

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

    // private createScopeContent (frameId : number, scopeId : string) : any {
    //     let scopeContent = {
    //         variablesReference: this.lastVariableReferenceId,
    //         frameId: frameId,
    //         scopeId: scopeId,
    //         variables: [],
    //     };
    //     this.allScopesContent.set(scopeContent.variablesReference, scopeContent);
    //     this.lastVariableReferenceId += 1;

    //     return scopeContent;
    // }

    // private getScopeContent(variablesReferenceId: number) : StingrayScopeContent | undefined {
    //     return this.allScopesContent.get(variablesReferenceId);
    // }

    // private translateStingrayVariables(stingrayVariables:StingrayTableValue[]) : Variable[] {
    //     let variables: Variable[] = [];

    //     stingrayVariables.forEach(stingrayValue => {
    //         if (stingrayValue.var_name !== "(*temporary)") {
    //             if (stingrayValue.type === 'table') {
    //                 let tableItems = stingrayValue.value.split('\n');
    //                 let tableScopeContent = this.createScopeContent(scope.frameId, scope.scopeId);

    //                 variables.push({
    //                     name: stingrayValue.var_name,
    //                     value: "{table}",
    //                     variablesReference: 0,
    //                 });
    //             } else {
    //                 variables.push({
    //                     name: stingrayValue.var_name,
    //                     value: stingrayValue.value,
    //                     variablesReference: 0,
    //                 });
    //             }
    //         }
    //     });


    //     return variables;
    // }

    //////////////// YARHAR
    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
        if (!this.callstack) {
            return this.sendErrorResponse(response, 1000, "No callstack available");
        }

        const scopeContent = this._scopesContent.get(args.variablesReference);
        if (!scopeContent) {
            throw new Error('Unknown variablesReference ' + args.variablesReference);
        }

        if (scopeContent.dataReady()) {
            response.body = {
                variables: scopeContent.getVariables()
            };
            return this.sendResponse(response);
        }

        this.fetchScopeData(scopeContent).then(() => {
            response.body = {
                variables: scopeContent.getVariables()
            };
            this.sendResponse(response);
        });
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
        if (!this.callstack) {
            return this.sendErrorResponse(response, 1000, "No callstack available");
        }

        const scopes = new Array<Scope>();

        for (const scopeId in SCOPE_DESCS) {
            const scopeDisplayName = SCOPE_DESCS[scopeId];
            const scopeContent = this.createScopeContent(args.frameId, scopeId);
            this.populateVariables(scopeContent, this.callstack[args.frameId][scopeId]);
            this._topLevelScopes.push(scopeContent);
            scopes.push(new Scope(scopeDisplayName, scopeContent.variablesReference, false));
        }

        response.body = { scopes: scopes };
        this.sendResponse(response);
    }

    private createScopeContent (frameId : number, scopeId : string) : ScopeContent {
        let scopeContent = new ScopeContent(
            this._variableReferenceId,
            frameId,
            scopeId
        );
        this._scopesContent.set(scopeContent.variablesReference, scopeContent);
        this._variableReferenceId += 1;
        return scopeContent;
    }
    private populateVariables(scope: ScopeContent, stingrayTableValues: Array<any>) : void {
        const variables = [];
        let duplicatesCounter = 0;
        for (let i = 0; i < stingrayTableValues.length; ++i) {
            let tableValue = stingrayTableValues[i];
            let varName = tableValue.var_name || tableValue.key;
            if (varName === "(*temporary)") {
                continue;
            }
            if (tableValue.value === "C function") {
                continue;
            }

            // Add (n) at the end of a element in the table if one with the same name is already inserted
            if(tableValue.key){
                variables.forEach(element => {
                    if(element.name === tableValue.key){
                        varName = varName + "(" + ++duplicatesCounter + ")";
                    }
                });
            }
            let displayName = tableValue.key;
            let value = tableValue.value;
            let type = tableValue.type;
            if (tableValue.type === 'table') {
                let tableItems = value.split('\n');
                let tableScopeContent = this.createScopeContent(scope.frameId, scope.scopeId);
                tableScopeContent.tableVarName = scope.tableVarName || varName;
                if (!scope.tablePath) {
                    tableScopeContent.tablePath = [];
                } else {
                    tableScopeContent.tablePath = scope.tablePath.concat([i + 1]);
                }

                variables.push({
                    name: varName,
                    type: type,
                    value: "{table}",
                    namedVariables: tableItems.length,
                    variablesReference: tableScopeContent.variablesReference,
                    tableIndex: i
                });

            } else if (tableValue.type === 'userdata') {
                let _value = tableValue.value;
                // if (_value.includes("#ID"))
                // {
                //     _value = this.translateVariableIdSring(_value);
                // }

                variables.push({
                    name: varName,
                    type: type,
                    value: _value,
                    variablesReference: 0,
                    tableIndex: i
                });
            }else {
                variables.push({
                    name: varName,
                    type: type,
                    value: value,
                    variablesReference: 0,
                    tableIndex: i
                });
            }
        }
        scope.variables = variables;
    }

    private fetchScopeData(scopeContent: ScopeContent) : Promise<any> {
        this.log("Fetch data");
        if (scopeContent.dataReady()) {
            return Promise.resolve(scopeContent);
        }

        return this.sendDebuggerRequest('expand_table', {
            local_num: 0,
            table_path: {
                level: scopeContent.frameId,
                local: scopeContent.tableVarName,
                path: scopeContent.tablePath
            }
        }, 'node_index').then(result => {
            let message = result[0];
            let tableValues = message.table !== 'nil' ? message.table : [];
            this.populateVariables(scopeContent, tableValues);
        });
    }

    private setupRequest() : any {
        let request = {resolve: <any>null, reject: <any>null};
        let requestId = this._requestId++;
        this._requests.set(requestId, request);
        let p = new Promise<any>((resolve, reject) => {
            request.resolve = resolve;
            request.reject = reject;
        });

        return {promise: p, id: requestId};
    }

    private sendDebuggerRequest (command: string, data : any, requestIdName: string = 'requestId') : Promise<any> {
        let request = this.setupRequest();

        data = data || {};
        data[requestIdName] = request.id;

        this.log("command requested " + request.id + " " +command);
        this.connection?.sendDebuggerCommand(command, data);

        return request.promise;
    }
}
//     private getScopeVariables(stingrayScopeContent: StingrayScopeContent) : Variable[] {
//         interface Variable {
//             /** The variable's name. */
//             name: string;
//             /** The variable's value. This can be a multi-line text, e.g. for a function the body of a function. */
//             value: string;
//             /** The type of the variable's value. Typically shown in the UI when hovering over the value. */
//             type?: string;
//             /** Properties of a variable that can be used to determine how to render the variable in the UI. */
//             presentationHint?: VariablePresentationHint;
//             /** Optional evaluatable name of this variable which can be passed to the 'EvaluateRequest' to fetch the variable's value. */
//             evaluateName?: string;
//             /** If variablesReference is > 0, the variable is structured and its children can be retrieved by passing variablesReference to the VariablesRequest. */
//             variablesReference: number;
//             /** The number of named child variables.
//                 The client can use this optional information to present the children in a paged UI and fetch them in chunks.
//             */
//             namedVariables?: number;
//             /** The number of indexed child variables.
//                 The client can use this optional information to present the children in a paged UI and fetch them in chunks.
//             */
//             indexedVariables?: number;
//         }
//         let variables = [];
        
//     }
// }

DebugSession.run(StingrayDebugSession);