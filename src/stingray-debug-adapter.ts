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
    // eslint-disable-next-line @typescript-eslint/naming-convention
    var_name: string;
    key?: string;
}

interface StingrayTableContext {
    frameId: number,
    varName: string,
    varIndex: number,
    parentRefId: number
}

interface StingrayCommandRequset {
    id: number,
    promise: Promise<any>
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
    lastCommandRequestId: number;
    variableRefMap: Map<number, Variable[]>;
    tableContextMap: Map<number,StingrayTableContext>;
    commandRequests: Map<number, any>;

    callstack: any | null;
    projectRoot: string;

    constructor() {
        super();
        this.breakpoints = new Map<string, DebugProtocol.Breakpoint[]>();
        this.variableRefMap = new Map<number, Variable[]>();
        this.tableContextMap = new Map<number, StingrayTableContext>();
        this.commandRequests = new Map<number, any>();

        this.lastBreakpointId = 0;
        this.lastVariableReferenceId = 0;
        this.lastCommandRequestId = 0;
        this.projectRoot = "d:/vt2/";
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        // Set supported features
        if (!response.body) {
            return;
        }

        response.body.supportsEvaluateForHovers = true;
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsRestartRequest = true;
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

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
        this.sendResponse(response);
    }

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
        this.connection.onDidReceiveData.add(this.onStingrayMessage.bind(this));
        this.connection.onDidConnect.add(()=>{
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
                this.variableRefMap.clear();
            } else if (data.message === 'expand_table') {
                const pendingRequest = this.commandRequests.get(data.node_index);
                if (pendingRequest) {
                    const parentTableContext = this.tableContextMap.get(data.local_num);
                    if (parentTableContext && data.table !== "nil") {
                        const varRefId = this.translateStingrayFrameData(data.table_path.level, data.table, data.local_num);
                        const variables = this.variableRefMap.get(varRefId) || [];
                        pendingRequest.resolve(variables);
                    } else { // register empty so we don't bother re evaluating
                        const varRefId = this.generateVariableRefId();
                        this.variableRefMap.set(varRefId, []);
                        pendingRequest.reject();
                    }

                    this.commandRequests.delete(data.node_index);
                }
            } else if (data.node_index || data.requestId) {
                const pendingRequest = this.commandRequests.get(data.node_index);
                if (pendingRequest) {
                    this.log("Unhandled request: "+ data.node_index + " ... " + JSON.stringify(data));
                    this.commandRequests.delete(data.node_index);
                }
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
    
    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
        this.log(`scopesRequest ${args.frameId}`);
        let scopes : Scope[] = [];
        for (const scopeId in SCOPE_DESCS) {
            const scopeName = SCOPE_DESCS[scopeId];
            let variablesRefId = this.translateStingrayFrameData(args.frameId, this.callstack[args.frameId][scopeId]);
            scopes.push(new Scope(scopeName, variablesRefId, false));
        }

        response.body = { scopes: scopes };
        this.sendResponse(response);
    }

    private translateStingrayFrameData(frameId: number, stingrayFrameData: StingrayTableValue[], parentRefId?:number) : number {
        const refId = this.generateVariableRefId();
        let variables : Variable[] = [];
        
        let varIdx = 1;
        stingrayFrameData.forEach(stingrayValue => {
            let varName = stingrayValue.key || stingrayValue.var_name;
            if (varName !== "(*temporary)") {
                if (stingrayValue.type === 'table') {
                    let tableItems = stingrayValue.value.split('\n\t');
                    if (tableItems.length > 1) {
                        let tableRefId = this.generateVariableRefId();
                        this.translateStingrayTableData(tableItems, tableRefId);

                        variables.push({
                            name: varName,
                            value: "{table}",
                            variablesReference: tableRefId,
                        });
                    } else {
                        let reservedTableRefId = this.generateVariableRefId();
                        this.tableContextMap.set(reservedTableRefId, {
                            frameId,
                            varName: varName,
                            varIndex: varIdx,
                            parentRefId: parentRefId || -1,
                        });
                        variables.push({
                            name: varName,
                            value: stingrayValue.value,
                            variablesReference: reservedTableRefId,
                        });
                    }
                    
                } else {
                    variables.push({
                        name: varName,
                        value: stingrayValue.value,
                        variablesReference: 0,
                    });
                }
            }
            varIdx++;
        });

        this.variableRefMap.set(refId, variables);
        return refId;
    }

    private makeCommandRequest() : StingrayCommandRequset {
        let request = {resolve: <any>null, reject: <any>null};
        let requestId = this.lastCommandRequestId++;
        let p = new Promise<any>((resolve, reject) => {
            request.resolve = resolve;
            request.reject = reject;
        });
        this.commandRequests.set(requestId, request);

        return {promise: p, id: requestId};
    }

    private requestTableExpand(variableRefId: number) : Promise<Variable[]> {
        const tableContext = this.tableContextMap.get(variableRefId);
        if (tableContext) {
            let tablePath = this.getTablePath(tableContext);
            if (tablePath){
                let request = this.makeCommandRequest();
                this.connection?.sendDebuggerCommand('expand_table', {
                    local_num: variableRefId, 
                    node_index: request.id,
                    table_path: {
                        level: tableContext.frameId,
                        local: tablePath[0],
                        path: tablePath[1]
                    }
                });
                return request.promise;
            }
        }
        this.log("No table context for ref id: " + variableRefId);
        return Promise.reject();
    }

    private getTablePath(tableContext: StingrayTableContext) : [string, number[]] {
        let path: number[] = [];
        this.log("start: " + tableContext.varIndex);
        while (tableContext.parentRefId >= 0) {
            path.push(tableContext.varIndex);
            let next = this.tableContextMap.get(tableContext.parentRefId);
            this.log("next: " + next?.varIndex || "???");
            if (next) {
                tableContext = next;
            }
        }
        
        this.log(path.reverse().toString());
        return [tableContext.varName, path];
    }

    private translateStingrayTableData(tableItems: string[], tableRefId: number) {
        let variables : Variable[] = [];
        tableItems.forEach(stringVal =>{
            if (stringVal !== "") {
                variables.push({
                    name: stringVal,
                    value: "{unknown}",
                    variablesReference: 0,
                });
            }
        });
        this.variableRefMap.set(tableRefId, variables);
    }

    private generateVariableRefId() : number {
        return ++this.lastVariableReferenceId;
    }

    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
        this.log("variablesRequest " + args.variablesReference);

        const variables = this.variableRefMap.get(args.variablesReference);
        if (variables) {
            response.body = {
                variables : variables,
            };
            this.sendResponse(response);
        } else {
            this.requestTableExpand(args.variablesReference).then((variables)=>{
                response.body = {
                    variables : variables,
                };
                this.sendResponse(response);
            }, () => {
                this.sendResponse(response);
            });
        }
    }

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