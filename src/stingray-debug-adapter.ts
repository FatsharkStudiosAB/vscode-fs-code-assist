import { existsSync as fileExists } from 'fs';
import * as readline from 'readline';
import { readFile } from 'fs/promises';
import * as path from 'path';
import * as DebugAdapter from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { StingrayConnection } from './stingray-connection';
import { uuid4 } from './utils/functions';
import { StingrayToolchain } from "./utils/stingray-toolchain";
import { ChildProcess, exec } from 'child_process';
import { killProcessTree } from './utils/process';

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
class StingrayVariable extends DebugAdapter.Variable {
	static refIdIncrementingCounter: RefId = 0;
	public type?: string;
	public path?: number[];
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
	id: string;
	toolchain: string;
	wait_for_debugger?: number;
	loggingEnabled?: boolean;
};

const THREAD_ID = 1;

class StingrayDebugSession extends DebugAdapter.DebugSession {
	connection?: StingrayConnection;
	children: ChildProcess[] = [];

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
	projectFolderMaps = new Map<string, string>();
	projectMapFolder = '';
	coreMapFolder = '';

	constructor() {
		super();
	}

	private command(type: string, args?: any): Promise<any> {
		return new Promise((resolve) => {
			const request_id = uuid4();
			const request = { ...args, request_type: type, request_id };
			this.callbacks.set(request_id, resolve);
			this.connection?.sendLua(`VSCodeDebugAdapter[===[${JSON.stringify(request)}]===]`);
		});
	}

	private handleLegacyMessage(data: any) {
		if (data.message === 'halted') {
			const resourcePath = this.toResourcePath(data.source);
			if (this.breakpoints.has(resourcePath)) {
				const line = data.line;
				const bp = this.breakpoints.get(resourcePath)?.find((bp) => (bp.line === line));
				if (bp) {
					bp.verified = true;
					this.sendEvent(new DebugAdapter.BreakpointEvent('update', bp));
				}
			}
			const reason = data.reason ?? 'bishop';
			this.sendEvent(new DebugAdapter.StoppedEvent(reason, THREAD_ID, data.error));
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
		response.body.supportsFunctionBreakpoints = false;
		response.body.supportsConditionalBreakpoints = false;
		response.body.supportsHitConditionalBreakpoints = false;
		response.body.exceptionBreakpointFilters = [
			{
				filter: "error",
				label: "Uncaught Exception",
				default: true,
			}
		];
		this.sendResponse(response);
	}

	protected async completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): Promise<void> {
		const expression = args.text.match(/^\s*[\w_\[\].]+$/)?.[0].replace(/\.[\w_]*$/, '');
		if (expression) {
			const reply = await this.command('eval', { expression: expression, level: args.frameId, completion: true });
			if (reply.ok) {
				const targets: DebugProtocol.CompletionItem[] = [];
				reply.result.children?.forEach((child: any) => {
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
			const source = new DebugAdapter.Source(reply.result.source, this.getResourceFilePath(reply.result.source));
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

	private async connect(toolchain: StingrayToolchain, ip: string, port: number): Promise<StingrayConnection> {
		const config = await toolchain.config();
		const currentProject = config.Projects[config.ProjectIndex];
		this.projectMapFolder = currentProject.SourceDirectory;

		// Add core map folder to resolve core scripts
		// If SourceRepositoryPath is in the toolchain config use this for core folder instead of default toolchain
		const coreMapFolder = config.SourceRepositoryPath ?? toolchain.path;
		this.coreMapFolder = path.join(coreMapFolder, 'core');
		if (fileExists(this.coreMapFolder)) {
			this.projectFolderMaps.set('core', path.dirname(this.coreMapFolder));
		}

		return new Promise((resolve, reject) => {
			const connection = new StingrayConnection(port, ip);

			connection.onDidReceiveData.add(this.onStingrayMessage.bind(this));
			connection.onDidDisconnect.add(() => {
				this.breakpoints.clear();
				this.callbacks.clear();
				this.sendEvent(new DebugAdapter.OutputEvent(`Disconnected from ${ip}:${port}`));
				this.sendEvent(new DebugAdapter.TerminatedEvent()); // Debugging ended.
				this.sendEvent(new DebugAdapter.ExitedEvent(0)); // Debuggee is "dead".
				reject();
			});
			connection.onDidConnect.add(async () => {
				this.log(`Successfully connected to ${ip}:${port}`);
				connection.sendDebuggerCommand('report_status');
				const snippets = await readFile(path.join(__dirname, '../snippets.lua'), 'utf8');
				connection.sendLua(snippets);
				this.sendEvent(new DebugAdapter.InitializedEvent());
				this.connection = connection;
				resolve(connection);
			});
		});
	}

	protected attachRequest(response: DebugProtocol.AttachResponse, args: StingrayAttachRequestArguments) {
		let toolchain: StingrayToolchain;
		try {
			toolchain = new StingrayToolchain(args.toolchain);
		} catch (err) {
			this.sendErrorResponse(response, 1000, `Error creating Toolchain: ${err}`);
			return;
		}

		const connectResult = this.connect(toolchain, args.ip, args.port);
		connectResult.then(() => {
			this.sendResponse(response);
		}).catch((err) => {
			this.sendErrorResponse(response, 1000, err.toString());
		});
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: StingrayLaunchRequestArguments) {
		let toolchain: StingrayToolchain;
		try {
			toolchain = new StingrayToolchain(args.toolchain);
		} catch (err) {
			this.sendErrorResponse(response, 1000, `Error creating Toolchain: ${err}`);
			return;
		}

		const wait_for_debugger = args.wait_for_debugger || 15;

		const runSetId = args.id;
		const config = await toolchain.config();
		const runSet = config.RunSets.find((runSet) => {
			return (runSetId === runSet.Id);
		});
		if (!runSet) {
			this.sendErrorResponse(response, 1000, `Run set ${runSetId} does not exist`);
			return;
		}
		if (runSet.RunItems.length !== 1) {
			this.sendErrorResponse(response, 1000, `Run set ${runSetId} must have exactly 1 item`);
			return;
		}
		const runItem = runSet.RunItems[0];

		if (runItem.Target !== '00000000-1111-2222-3333-444444444444') {
			this.sendErrorResponse(response, 1000, `Run set ${runSetId} must launch on localhost`);
			return;
		}

		const enginePath = path.join(toolchain.path, 'engine', 'win64', config.Build, 'stingray_win64_dev_x64.exe');
		const engineCommonParams = `--wait-for-debugger ${wait_for_debugger} --toolchain ${toolchain.path} --no-compile`;
		const options: any = { // Type must be any because otherwise stdio isn't recognized.
			stdio: [ 'ignore', 'pipe', 'ignore '],
		};

		// This next thing is an array because in the future we might want to make it that way.
		runSet.RunItems.forEach(async (item) => {
			const child = exec(`${enginePath} ${engineCommonParams} ${item.ExtraLaunchParameters}`, options);

			child.on('error', () => {
				this.sendErrorResponse(response, 1000, `Could not spawn child process.`);
				killProcessTree(child);
			});

			let port = 0;
			const rl = readline.createInterface({
				input: child.stdout!,
				crlfDelay: Infinity,
			});
			for await (const line of rl) {
				const match = /Started console server \((\d+)\)/.exec(line);
				if (match) {
					port = parseInt(match[1], 10);
					break;
				}
			}
			rl.close();
			child.stdout!.destroy();

			const connectResult = this.connect(toolchain, 'localhost', port);
			connectResult.then(() => {
				this.children.push(child);
				this.sendEvent(new DebugAdapter.OutputEvent(`Connected to '${runSet.Name}' at localhost:${port}`));
				this.sendResponse(response);
			}).catch((err) => {
				this.sendErrorResponse(response, 1000, `Could not connect to child process: ${err.toString()}`);
				killProcessTree(child);
			});
		});
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
				this.sendEvent(new DebugAdapter.OutputEvent(`${reply.result}\r\n`, 'stderr'));
				this.sendEvent(new DebugAdapter.InvalidatedEvent(['variables'], THREAD_ID, args.frameId));
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

	protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments): void {
		this.connection?.sendCommand('reboot');
		this.sendResponse(response);
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, _args: DebugProtocol.DisconnectArguments): void {
		this.shutdown();
		this.connection?.close();
		this.connection = undefined;
		this.children.forEach((child) => {
			killProcessTree(child);
		});
		this.children.length = 0;
		this.sendResponse(response);
	}

	private log(message:string) {
		if (this.loggingEnabled) {
			this.sendEvent(new DebugAdapter.OutputEvent(`${message}\r\n`, 'console'));
		}
	}

	protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): void {
		const status = args.filters.includes('error');
		this.connection!.sendDebuggerCommand('set_break_on_error', { status });
		this.sendResponse(response);
	}

	protected setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments, request?: DebugProtocol.Request): void {
		const vsBreakpoints = args.breakpoints.map((fBp) => {
			const bp = new DebugAdapter.Breakpoint(false) as DebugProtocol.Breakpoint;
			bp.message = "NYI";
			return bp;
		});
		response.body = { breakpoints: vsBreakpoints };
		this.sendResponse(response);
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		// We rely on a deprecated API, so we ensure we have the required attributes.
		const filePath = args.source.path;
		const clientLines = args.lines;
		if (!filePath || !clientLines) {
			this.sendErrorResponse(response, 1000, ".source.path and .lines must both be present.");
			return;
		}

		// Try to translate from the filesystem path to a stingray resource path.
		let resourcePath = path.relative(this.projectMapFolder, filePath).replace(/\\/g, '/');
		let validScript = !!resourcePath && !resourcePath.startsWith('..') && !path.isAbsolute(resourcePath);
		if (!validScript) {
			resourcePath = path.join('core', path.relative(this.coreMapFolder, filePath)).replace(/\\/g, '/');
			validScript = !!resourcePath && !resourcePath.startsWith('..') && !path.isAbsolute(resourcePath);
		}

		// Reply with information about the breakpoints to the client.
		const source = new DebugAdapter.Source(resourcePath, filePath);
		const adapterBreakpoints = clientLines.map(line => {
			const bp = new DebugAdapter.Breakpoint(validScript, line, 0, source);
			bp.setId(this.lastBreakpointId++);
			return bp;
		});
		response.body = { breakpoints: adapterBreakpoints };
		this.sendResponse(response);

		// If the path was valid, update the breakpoints.
		if (validScript) {
			this.breakpoints.set(resourcePath, adapterBreakpoints);

			// Need to send all of them at once since it clears them every time new ones are sent.
			const stingrayBreakpoints: StingrayBreakpoints = {};
			this.breakpoints.forEach((breakpoints, resourceName) => {
				stingrayBreakpoints[resourceName] = breakpoints.map((bp) => bp.line!);
			});
			this.connection?.sendDebuggerCommand('set_breakpoints', { breakpoints: stingrayBreakpoints });
		}
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
				new DebugAdapter.Scope("Locals", locals.variablesReference, false),
				new DebugAdapter.Scope("Upvalues", upvals.variablesReference, false),
			]
		};
		this.sendResponse(response);
	}

	private expandScope(name: string, frameId: FrameId, records: EngineCallstackRecord[]): StingrayVariable {
		const v = new StingrayVariable(name, "n/a", (resolve) => {
			const children: StingrayVariable[] = [];
			records.forEach((record) => {
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

				/* eslint-disable @typescript-eslint/naming-convention */
				const expandTableArg: EngineExpandTable = {
					node_index: requestIndex,
					local_num: -1, // Unused by engine.
					table_path: {
						level: frameId,
						local: localName,
						path: path,
					}
				};
				/* eslint-enable @typescript-eslint/naming-convention */

				this.connection?.sendDebuggerCommand('expand_table', expandTableArg);
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

	private expandEval(record: any, evalId: number, path: number[], internal?: boolean): StingrayVariable {
		let executor;
		if (record.type === 'table' || record.type === 'function') {
			executor = async (resolve: any) => {
				const expandResponse = await this.command('expandEval', {
					id: evalId,
					path: path,
				});
				const children: StingrayVariable[] = expandResponse.result.children.map((child: any, index: number) => {
					if (child.name.startsWith('(')) {
						index = -1; // Special magic index.
					}
					return this.expandEval(child, evalId, [...path, index], (record.type === 'function'));
				});
				children.sort(StingrayVariable.compare);
				resolve(children);
			};
		}
		const name = record.name;
		const v = new StingrayVariable(name, record.value, executor);
		v.type = record.type;
		v.presentationHint = {
			visibility: (internal || name.startsWith('(')) ? 'internal' : name.startsWith('_') ? 'private' : 'public',
		};
		const ref = v.variablesReference;
		if (ref) {
			this.evalRegistry.set(ref, v);
		}
		return v;
	}

	/** Retrieves all child variables for the given variable reference. */
	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
		const parent = this.variables.get(args.variablesReference) || this.evalRegistry.get(args.variablesReference);
		if (parent) {
			const variables = await parent.children();
			response.body = { variables: variables };
			this.sendResponse(response);
		} else {
			this.sendErrorResponse(response, 1000, 'Expanding variable without children.');
		}
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		response.body = { threads: [ new DebugAdapter.Thread(THREAD_ID, "Main thread") ] };
		this.sendResponse(response);
	}

	/** Send all the stack frames for the `Call Stack` tree view. */
	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, _args: DebugProtocol.StackTraceArguments): void {
		if (!this.callstack) {
			return this.sendErrorResponse(response, 1000, "No callstack available");
		}

		const frames = this.callstack.map((frame, i) => {
			const name = frame.function ?? 'λ';
			let source;
			if (frame.source !== '=') {
				const filePath = this.getResourceFilePath(frame.source);
				source = new DebugAdapter.Source(frame.source, filePath);
				if (!filePath) {
					(source as DebugProtocol.Source).presentationHint = 'deemphasize';
				}
			}
			const sf = new DebugAdapter.StackFrame(i, name, source, frame.line);
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

	private getResourceFilePath(source: string): string | undefined {
		let isMapped = source[0] === '@';
		let resourcePath = isMapped ? source.slice(1) : source;
		const projectPath = this.projectMapFolder;
		const filePath = projectPath ? path.join(projectPath, resourcePath) : resourcePath;
		if (fileExists(filePath)) {
			return filePath;
		}

		if (isMapped) {
			const mapName = resourcePath.split('/')[0];
			if (mapName) {
				const mappedPath = this.projectFolderMaps.get(mapName);
				if (mappedPath) {
					return path.join(mappedPath, resourcePath);
				}
			}
		}

		return undefined;
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

DebugAdapter.DebugSession.run(StingrayDebugSession);
