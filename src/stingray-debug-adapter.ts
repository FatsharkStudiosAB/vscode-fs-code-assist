import { DebugProtocol } from 'vscode-debugprotocol';
import { DebugSession, Breakpoint, Source, OutputEvent, InitializedEvent, StoppedEvent, Thread, BreakpointEvent, StackFrame, Scope, Variable, InvalidatedEvent, CompletionItem } from 'vscode-debugadapter';
import { StingrayConnection } from './stingray-connection';
import { getCurrentToolchainSettings, getToolchainSettingsPath, uuid4 } from './utils';
import * as path from 'path';
import { readFileSync, existsSync as fileExists } from 'fs';
import * as SJSON from 'simplified-json';

/** Map of file paths to line numbers with breakpoints. */
type StingrayBreakpoints = {
	[filePath: string]: number[];
};

type RefId = number;
type FrameId = number;

const compareWith = (sortOrder: { [key:string]: number; }, a?: string, b?: string, ) => {
	return (a && sortOrder[a] || 0) - (b && sortOrder[b] || 0);
};

/** A variable or scope pseudo-variable that can be lazily recursively expanded. */
class StingrayVariable extends Variable {
	static refIdIncrementingCounter: RefId = 0;
	public type?: string;
	public presentationHint?: DebugProtocol.VariablePresentationHint;
	private _promise?: Promise<StingrayVariable[]>;

	constructor(name: string, value: string, private executor?: (resolve: (value: StingrayVariable[]) => void) => void) {
		super(name, value, executor ? ++StingrayVariable.refIdIncrementingCounter : 0);
	}

	/** Returns a promise that will eventually resolve to its children (if any). */
	children(): Promise<StingrayVariable[]> {
		if (!this._promise) {
			const executor = this.executor;
			if (executor) {
				this._promise = new Promise(resolve => executor(resolve));
			} else {
				this._promise = Promise.resolve([]);
			}
		}
		return this._promise;
	};

	/** Convenience function to resolve a string path. */
	async resolve(path: string[]): Promise<StingrayVariable | undefined> {
		if (path.length === 0) {
			return this;
		}
		const children = await this.children();
		const child = children.find((child) => child.name === path[0]);
		return child?.resolve(path.slice(1));
	}

	static _collatorCompare = new Intl.Collator().compare;
	static _sortOrderVisibility: ({ [visibility: string]: number; }) = {
		public: 0,
		private: 1,
		internal: 2,
	};
	static compare(a: StingrayVariable, b: StingrayVariable): number {
		const c1 = compareWith(StingrayVariable._sortOrderVisibility, a.presentationHint?.visibility, b.presentationHint?.visibility);
		if (c1 !== 0) {
			return c1;
		}
		if (a.name.match(/^\d+$/) && b.name.match(/^\d+$/)) {
			return parseInt(a.name, 10) - parseInt(b.name, 10);
		}
		return StingrayVariable._collatorCompare(a.name, b.name);
	}
};

type StingrayAttachRequestArguments = DebugProtocol.AttachRequestArguments & {
	ip: string;
	port: number;
	toolchain: string;
	loggingEnabled?: boolean;
};

type StingrayLaunchRequestArguments = DebugProtocol.LaunchRequestArguments & {
	loggingEnabled?: boolean;
};

const THREAD_ID = 1;

class StingrayDebugSession extends DebugSession {
	connection?: StingrayConnection;

	// Breakpoints.
	breakpoints = new Map<string, DebugProtocol.Breakpoint[]>();
	lastBreakpointId = 0;

	// Callstack information.
	callstack: EngineCallstack = [];
	variables = new Map<RefId, StingrayVariable>();
	evalRegistry = new Map<RefId, StingrayVariable>();
	frames = new Map<FrameId, StingrayVariable[]>();

	callbacks = new Map<string, { (data: any): void }>();

	expandTableIndex = 0;
	expandTableCallbacks = new Map<number, { (data: any): void }>();

	// Debugging the debugger.
	loggingEnabled = false;

	// Project information.
	projectRoot = "";
	projectFolderMaps = new Map<string, string>();
	projectMapFolder = "";
	coreMapFolder  = "";

	constructor() {
		super();
	}

	/* eslint-disable @typescript-eslint/naming-convention */
	private command(request_type: string, request_args?: any): Promise<any> {
		return new Promise((resolve, reject) => {
			const request_id = uuid4();
			const request = { ...request_args, request_type, request_id };
			this.callbacks.set(request_id, resolve);
			this.connection?.sendLua(`VSCodeDebugAdapter[===[${JSON.stringify(request)}]===]`);
		});
	}
	/* eslint-enable @typescript-eslint/naming-convention */

	private handleLegacyMessage(data: any) {
		if (data.message === 'halted') {
			let haltReason = 'pause';
			const resourcePath = this.toResourcePath(data.source);
			if (this.breakpoints.has(resourcePath)) {
				const line = data.line;
				const bp = this.breakpoints.get(resourcePath)?.find((bp) => (bp.line === line));
				if (bp) {
					bp.verified = true;
					haltReason = 'breakpoint';
					this.sendEvent(new BreakpointEvent('update', bp));
				}
			}
			this.sendEvent(new StoppedEvent(haltReason, THREAD_ID));
		} else if (data.message === 'callstack') {
			this.callstack = data.stack;
			this.variables.clear();
			this.frames.clear();
			this.expandTableCallbacks.clear();
		} else if (data.message === 'expand_table') {
			const callback = this.expandTableCallbacks.get(data.node_index);
			if (callback) {
				callback(data);
				this.expandTableCallbacks.delete(data.node_index);
			} else {
				this.log(`Received expand_table with id ${data.node_index}, but there was no pending request.`);
			}
		}
	}

	private onStingrayMessage(data: any) {
		if (data.type === 'lua_debugger') {
			this.handleLegacyMessage(data);
		} else if (data.type === 'vscode_debug_adapter') {
			const callback = this.callbacks.get(data.request_id);
			if (callback) {
				callback(data);
			} else {
				this.log(`Unhandled request with type:${data.request_type} and id:${data.request_id}.`);
			}
		} else {
			return;
		}
	}

	/** At initialize we reply with the capabilities of this debug adapter. */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		this.log(`Received initialize request from ${args.clientID} to ${args.adapterID}`);
		response.body = response.body || {};
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsRestartRequest = true;
		response.body.supportsSetVariable = false;
		response.body.supportsCompletionsRequest = true;
		response.body.supportsDisassembleRequest = false;
		response.body.exceptionBreakpointFilters = [
			{
				filter: "error",
				label: "Uncaught Exception",
				default: true,
			}
		];
		this.sendResponse(response);
		this.sendEvent(new InitializedEvent());
	}

	protected async completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): Promise<void> {
		const expression = args.text.match(/^\s*[\w_\[\].]+$/)?.[0].replace(/\.[\w_]*$/, '');
		if (expression) {
			const reply = await this.command('eval', { expression: expression, level: args.frameId, completion: true });
			if (reply.ok) {
				const targets: DebugProtocol.CompletionItem[] = [];
				reply.result.children.forEach((child: any)  => {
					const key = child.name;
					if (key.startsWith('(')) {
						if (key === '(metatable)') {
							targets.push({
								start: -args.column,
								length: args.column,
								label: '(metatable)',
								text: `getmetatable(${expression})`,
							});
						}
					} else if (key.match(/^\d+$/)) {
						targets.push({
							start: -1,
							length: 1,
							label: key.padStart(3), // To preserve ordering.
							text: `[${key}]`,
							type: child.type === 'function' ? 'method' : 'field',
						});
					} else {
						targets.push({
							start: args.column,
							label: key,
							type: child.type === 'function' ? 'method' : 'field',
						});
					}
				});
				response.body = { targets: targets };
			}
		}
		this.sendResponse(response);
	}

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
		this.sendResponse(response);
	}


	protected async disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments): Promise<void> {
		const frameId = args.memoryReference.match(/frame#(\d+)/)?.[1];
		if (frameId) {
			const reply = await this.command('disassemble', { level: parseInt(frameId, 10) });
			const source = new Source(reply.result.source, this.getResourceFilePath(reply.result.source));
			const instructions = reply.result.bc.map((entry:any, index:number) => {
				return {
					address: (index + 1).toFixed(),
					instructionBytes: entry.bytes,
					instruction: entry.ins,
					location: source,
					line: entry.line,
					endLine: entry.line,
					column: 1,
					endColumn: 1,
				};
			});
			response.body = { instructions: instructions };
		}
		this.sendResponse(response);
	}

	protected attachRequest(response: DebugProtocol.AttachResponse, args: StingrayAttachRequestArguments): void {
		const ip = args.ip;
		const port = args.port;
		const tcPath = args.toolchain;
		if (!tcPath) {
			this.sendErrorResponse(response, 1000, "No toolchain path.");
			return;
		}

		const tcSettingsPath = getToolchainSettingsPath(tcPath);
		if (!tcSettingsPath) {
			this.sendErrorResponse(response, 1000, "No toolchain settings path.");
			return;
		}

		this.initProjectPaths(tcPath);

		const currentTCSettings = getCurrentToolchainSettings(tcSettingsPath);
		this.projectRoot = currentTCSettings.SourceDirectory.replace(/\\/g, '/').toLowerCase() + '/';
		this.connection = new StingrayConnection(port, ip);
		this.connection.sendLua(readFileSync(path.join(__dirname, '../snippets.lua'), 'utf8'));
		this.connection.onDidReceiveData.add(this.onStingrayMessage.bind(this));
		this.connection.onDidConnect.add(()=>{
			this.log(`Successfully connected to ${ip}:${port}`);
			this.connection?.sendDebuggerCommand('report_status');
			this.sendEvent(new InitializedEvent());
			this.sendResponse(response);
		});
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: StingrayLaunchRequestArguments) {
		this.log('NYI');
		this.sendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
		let expression = args.expression;
		if (args.context === 'hover') {
			expression = expression.replace(/:/g, '.');
		}
		const reply = await this.command('eval', { expression: expression, level: args.frameId });
		if (reply.ok) {
			const variable = this.expandEval(reply.result, reply.result.id, []);
			response.body = {
				result: variable.value,
				type: variable.type,
				variablesReference: variable.variablesReference,
			};
		} else {
			if (args.context === 'repl') {
				this.sendEvent(new OutputEvent(`${reply.result}\r\n`, 'stderr'));
				this.sendEvent(new InvalidatedEvent(['variables'], THREAD_ID, args.frameId));
			} else if (args.context === 'watch') {
				response.body = { result: '#ERROR!', variablesReference: 0 };
			}
		}

		this.sendResponse(response);
	}

	public shutdown(): void {
		// Ensure the debuggee is not stopped.
		this.connection?.sendDebuggerCommand('set_breakpoints', { breakpoints: {} });
		this.connection?.sendDebuggerCommand('continue');
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, _args: DebugProtocol.DisconnectArguments): void {
		this.shutdown();
		this.connection?.close();
		this.connection = undefined;
		this.sendResponse(response);
	}

	private log(message:string) {
		if (this.loggingEnabled) {
			this.sendEvent(new OutputEvent(`${message}\r\n`, 'console'));
		}
	}

	protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): void {
		this.sendResponse(response);
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		const filePath = args.source.path;
		const clientLines = args.lines;
		if (!filePath || !clientLines) {
			this.sendErrorResponse(response, 1000, ".source.path and .lines must both be present.");
			return;
		}

		const resourcePath = path.relative(this.projectMapFolder, filePath).replace(/\\/g, '/');
		const validScript = !!resourcePath && !resourcePath.startsWith('..') && !path.isAbsolute(resourcePath);
		// @TODO: Add support for this.coreMapFolder.

		// Verify breakpoint locations
		const vsBreakpoints = clientLines.map(line => {
			const bp = new Breakpoint(validScript, line, 0, new Source(resourcePath, filePath));
			bp.setId(this.lastBreakpointId++);
			return bp;
		});
		this.breakpoints.set(resourcePath, validScript ? vsBreakpoints : []);
		response.body = { breakpoints: vsBreakpoints };
		this.sendResponse(response);

		// Need to send all of them at once since it clears them every time new ones are sent.
		let stingrayBreakpoints: StingrayBreakpoints = {};
		this.breakpoints.forEach((breakpoints, resourceName) => {
			if (vsBreakpoints.length > 0) {
				stingrayBreakpoints[resourceName] = breakpoints.map(bp => bp.line || 0);
			}
		});
		this.connection?.sendDebuggerCommand('set_breakpoints', { breakpoints: stingrayBreakpoints });
	}

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, _args: DebugProtocol.ConfigurationDoneArguments): void {
		this.sendResponse(response);
		// Can the engine stop wating here for the debugger?
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		const frameId = args.frameId;
		const locals = this.expandScope('Locals', frameId, this.callstack[frameId]['local']);
		const upvals = this.expandScope('Upvalues', frameId, this.callstack[frameId]['up_values']);
		this.frames.set(frameId, [ locals, upvals ]);
		response.body = {
			scopes: [
				new Scope("Locals", locals.variablesReference, false),
				new Scope("Upvalues", upvals.variablesReference, false),
			]
		};
		this.sendResponse(response);
	}

	private expandScope(name: string, frameId: FrameId, records: EngineCallstackRecord[]): StingrayVariable {
		const v = new StingrayVariable(name, "n/a", (resolve) => {
			const children: StingrayVariable[] = [];
			records.forEach((record, index) => {
				const name = record.key || record.var_name;
				if (name === '(*temporary)') {
					return;
				}
				const variable = this.expandValue(frameId, record, name, []);
				if (name.startsWith('(')) {
					variable.presentationHint!.visibility = 'internal';
				}
				children.push(variable);
			});
			resolve(children);
		});
		v.type = 'scope';
		const ref = v.variablesReference;
		if (ref) {
			this.variables.set(ref, v);
		}
		return v;
	}

	private expandValue(frameId: FrameId, record: EngineCallstackRecord, localName: string, path: number[]): StingrayVariable {
		let executor;
		if (record.type === 'table') {
			executor = (resolve: any) => {
				const requestIndex = this.expandTableIndex++;
				this.expandTableCallbacks.set(requestIndex, (data) => {
					if (data.table === "nil" || data.table.length === 0) {
						resolve([]);
					}
					const table = data.table as EngineCallstackRecord[];
					const children = table.map((childRecord, index) => {
						return this.expandValue(frameId, childRecord, localName, [...path, index+1]);
					});
					children.sort(StingrayVariable.compare);
					resolve(children);
				});

				this.connection?.sendDebuggerCommand('expand_table', {
					node_index: requestIndex,
					local_num: -1, // Unused by engine.
					table_path: {
						level: frameId,
						local: localName,
						path: path,
					}
				});
			};
		}
		const name = record.key || record.var_name;
		const v = new StingrayVariable(name, record.value, executor);
		v.type = record.type;
		v.presentationHint = {
			visibility: name.startsWith('_') ? 'private' : 'public',
		};
		const ref = v.variablesReference;
		if (ref) {
			this.variables.set(ref, v);
		}
		return v;
	}

	private expandEval(record: any, evalId: number, path: number[]): StingrayVariable {
		let executor;
		if (record.type === 'table') {
			executor = async (resolve: any) => {
				const expandResponse = await this.command('expandEval', {
					id: evalId,
					path: path,
				});
				const children: StingrayVariable[] = expandResponse.result.children.map((child: any, index: number) => {
					if (child.name.startsWith('(')) {
						index = -1; // Special magic index.
					}
					return this.expandEval(child, evalId, [...path, index]);
				});
				children.sort(StingrayVariable.compare);
				resolve(children);
			};
		}
		const name = record.name;
		const v = new StingrayVariable(name, record.value, executor);
		v.type = record.type;
		v.presentationHint = {
			visibility: name.startsWith('(') ? 'internal' : name.startsWith('_') ? 'private' : 'public',
		};
		const ref = v.variablesReference;
		if (ref) {
			this.evalRegistry.set(ref, v);
		}
		return v;
	}

	/** Retrieves all child variables for the given variable reference. */
	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
		const parent = this.variables.get(args.variablesReference) || this.evalRegistry.get(args.variablesReference);
		if (parent) {
			parent.children().then((variables) => {
				response.body = { variables: variables };
				this.sendResponse(response);
			});
		} else {
			this.sendErrorResponse(response, 1000, 'Expanding variable without children.');
		}
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		response.body = { threads: [ new Thread(THREAD_ID, "Main thread") ] };
		this.sendResponse(response);
	}

	/** Send all the stack frames for the `Call Stack` tree view. */
	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, _args: DebugProtocol.StackTraceArguments): void {
		if (!this.callstack) {
			return this.sendErrorResponse(response, 1000, "No callstack available");
		}

		const frames = this.callstack.map((frame, i) => {
			const name = frame.function ?? '<unknown>';
			const filePath = this.getResourceFilePath(frame.source);
			const sf = new StackFrame(i, name, new Source(frame.source, filePath), frame.line);
			if (frame.function) {
				sf.instructionPointerReference = `frame#${i}`;
			} else {
				sf.presentationHint = 'subtle';
			}
			return sf;
		});

		response.body = {
			stackFrames: frames,
			totalFrames: frames.length
		};
		this.sendResponse(response);
	}

	private toResourcePath(src: string): string {
		return (src[0] === '@') ? src.slice(1) : src;
	}

	private initProjectPaths(toolchainPath : string): void {
		const tccPath = getToolchainSettingsPath(toolchainPath);
		const tccSJSON = readFileSync(tccPath!, 'utf8');
		const tcc = SJSON.parse(tccSJSON);
		const projectData = tcc.Projects[tcc.ProjectIndex];
		this.projectMapFolder = projectData.SourceDirectory;

		// Add core map folder to resolve core scripts
		// If SourceRepositoryPath is in the toolchain config use this for core folder instead of default toolchain
		const coreMapFolder = tcc.SourceRepositoryPath ?? toolchainPath;
		this.coreMapFolder = path.join(coreMapFolder, 'core');

		if (fileExists(this.coreMapFolder)) {
			this.projectFolderMaps.set('core', path.dirname(this.coreMapFolder));
		}
	}

	private getResourceFilePath(source: string) {
		let isMapped = source[0] === '@';
		let resourcePath = isMapped ? source.slice(1) : source;
		const projectPath = this.projectMapFolder;
		let filePath = projectPath ? path.join(projectPath, resourcePath) : resourcePath;
		if (isMapped && !fileExists(filePath)) {
			let mapName = resourcePath.split('/')[0];
			if (mapName) {
				const mappedPath = this.projectFolderMaps.get(mapName);
				if (mappedPath) {
					filePath = path.join(mappedPath, resourcePath);
				}
			}
		}
		return filePath;
	}

	// STANDARD DEBUGGER REQUESTS //
	protected pauseRequest(response: DebugProtocol.PauseResponse, _args: DebugProtocol.PauseArguments): void {
		this.connection?.sendDebuggerCommand('break');
		this.sendResponse(response);
	}
	protected continueRequest(response: DebugProtocol.ContinueResponse, _args: DebugProtocol.ContinueArguments): void {
		this.connection?.sendDebuggerCommand('continue');
		this.sendResponse(response);
	}
	protected nextRequest(response: DebugProtocol.NextResponse, _args: DebugProtocol.NextArguments): void {
		this.connection?.sendDebuggerCommand('step_over');
		this.sendResponse(response);
	}
	protected stepInRequest(response: DebugProtocol.StepInResponse, _args: DebugProtocol.StepInArguments): void {
		this.connection?.sendDebuggerCommand('step_into');
		this.sendResponse(response);
	}
	protected stepOutRequest(response: DebugProtocol.StepOutResponse, _args: DebugProtocol.StepOutArguments): void {
		this.connection?.sendDebuggerCommand('step_out');
		this.sendResponse(response);
	}
}

DebugSession.run(StingrayDebugSession);
