import { DebugProtocol } from 'vscode-debugprotocol';
import { DebugSession, Breakpoint, Source, OutputEvent, InitializedEvent, StoppedEvent, Thread, BreakpointEvent, StackFrame, Scope, Variable } from 'vscode-debugadapter';
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
				this._promise = Promise.reject("Object does not have children.");
			}
			this._promise = this._promise.then((children) => {
				children.sort(StingrayVariable.compare); // In-place! Dirty!
				return children;
			});
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

	static _collator = new Intl.Collator();
	static _visibilityIndex: ({ [visibility: string]: number; }) = {
		public: 1,
		private: 2,
		internal: 3,
	};
	static compare(a: StingrayVariable, b: StingrayVariable): number {
		const aVisibility = StingrayVariable._visibilityIndex[a.presentationHint?.visibility ?? 'public'] ?? 99;
		const bVisibility = StingrayVariable._visibilityIndex[b.presentationHint?.visibility ?? 'public'] ?? 99;
		if (aVisibility !== bVisibility) {
			return aVisibility - bVisibility;
		}
		return StingrayVariable._collator.compare(a.name, b.name);
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
	repl = new Map<RefId, StingrayVariable>();
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

	private doRequest(request_type: string, request_args: any): Promise<any> {
		return new Promise((resolve, reject) => {
			const request_id = uuid4();
			// eslint-disable-next-line @typescript-eslint/naming-convention
			const request = { ...request_args, request_type, request_id };
			this.callbacks.set(request_id, resolve);
			this.connection?.sendLua(`VSCodeDebugAdapter[===[${JSON.stringify(request)}]===]`);
		});
	}

	private handleLegacyMessage(data: any) {
		if (data.message === 'halted') {
			let haltReason = 'paused';
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
		response.body.supportsDisassembleRequest = true;
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

	protected async disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments, request?: DebugProtocol.Request): Promise<void> {
		const disassemble = await this.doRequest("disassemble", {});
		const instructions = disassemble.result.map((bytecode:any, index:number) => {
			return {
				address: index.toString(),
				instructionBytes: "abc",
				instruction: "ADD a, b, c",
				location: new Source('a', 'b'),
				line: 0,
			};
		});
		response.body = { instructions: instructions };
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
		this.connection.onDidReceiveData.add(this.onStingrayMessage.bind(this));
		this.connection.onDidConnect.add(()=>{
			this.log(`Successfully connected to ${ip}:${port}`);
			const snippets = readFileSync(path.join(__dirname, '../snippets.lua'), 'utf8');
			this.connection?.sendLua(snippets);
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
		switch (args.context) {
		case 'watch':
			break;
		case 'repl':
			const repl = await this.doRequest('repl', { expression: args.expression, level: args.frameId });
			if (repl.ok) {
				const variable = this.expandRepl(repl.result, repl.result.id, []);
				response.body = {
					result: variable.value,
					type: variable.type,
					variablesReference: variable.variablesReference,
				};
			} else {
				this.sendEvent(new OutputEvent(`${repl.result}\r\n`, 'stderr'));
			}

			break;
		case 'hover':
			const scopes = args.frameId !== undefined ? this.frames.get(args.frameId) : undefined;
			const path = args.expression.split(/[.:]/);
			const variable = await scopes?.[0].resolve(path);
			if (variable) {
				response.body = {
					result: variable.value,
					type: variable.type,
					variablesReference: variable.variablesReference,
				};
			}
			break;
		default:
			return;
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

	protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments, request?: DebugProtocol.Request): void {
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
				children.push(this.expandValue(frameId, record, name, []));
			});
			resolve(children);
		});
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
					resolve(table.map((childRecord, index) => {
						return this.expandValue(frameId, childRecord, localName, [...path, index+1]);
					}));
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

	private expandRepl(record: any, replId: number, path: number[]): StingrayVariable {
		let executor;
		if (record.type === 'table') {
			executor = async (resolve: any) => {
				const expandResponse = await this.doRequest('expandRepl', {
					id: replId,
					path: path,
				});
				const children: StingrayVariable[] = expandResponse.result.children.map((child: any, index: number) => {
					return this.expandRepl(child, replId, [...path, index]);
				});
				const metatable = expandResponse.result.metatable;
				if (metatable) {
					children.push(this.expandRepl(metatable, replId, [...path, -1]));
				}
				resolve(children);
			};
		}
		const name = record.name;
		const v = new StingrayVariable(name, record.value, executor);
		v.type = record.type;
		v.presentationHint = {
			visibility: name === '__metatable' ? 'internal' : name.startsWith('_') ? 'private' : 'public',
		};
		const ref = v.variablesReference;
		if (ref) {
			this.repl.set(ref, v);
		}
		return v;
	}

	/** Retrieves all child variables for the given variable reference. */
	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
		const parent = this.variables.get(args.variablesReference) || this.repl.get(args.variablesReference);
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
				sf.instructionPointerReference = 'dummy';
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
