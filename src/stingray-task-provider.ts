import { join as pathJoin } from "path";
import * as vscode from "vscode";
import { connectionHandler } from "./connection-handler";
import { getActiveToolchain } from "./extension";
import { StingrayConnection } from "./stingray-connection";
import { getTimestamp, uuid4 } from "./utils/functions";
import { Platform } from "./utils/stingray-config";
import { StingrayToolchain } from "./utils/stingray-toolchain";

const TASK_SOURCE = "stingray_lua";

/** Schema for a Stingray compile task.
 * Must be kept in sync with the "taskDefinitions" in the package.json file.
 */
type StingrayTaskDefinition = {
	type: typeof TASK_SOURCE,
	/** Target platform to compile for. */
	platform: Platform;
	/** If true, the result will be bundled. */
	bundle?: boolean;
	/** If true, sources will be reloaded in all open game connections. */
	refresh?: boolean;
};

enum StatusCode {
	Success = 0,
	Error = 1,
	Disconnect = 2,
}

class StingrayCompileTaskTerminal implements vscode.Pseudoterminal {
	private writeEmitter = new vscode.EventEmitter<string>();
	onDidWrite: vscode.Event<string> = this.writeEmitter.event;
	private closeEmitter = new vscode.EventEmitter<number>();
	onDidClose: vscode.Event<number> = this.closeEmitter.event;

	private id = uuid4();
	private compileInProgress = false;
	private compiler: StingrayConnection;
	private colorize = true;

	constructor(
		private toolchain: StingrayToolchain,
		private definition: StingrayTaskDefinition,
	) {
		this.compiler = connectionHandler.getCompiler();
		this.onData = this.onData.bind(this);
	}

	open(_initialDimensions: vscode.TerminalDimensions | undefined): void {
		this.startCompile();
	}

	close(): void {
		this.abortCompile();
	}

	private applyStyle(text: string, style: string) {
		return this.colorize ? `\x1B[${style}m${text}\x1B[0m` : text;
	}

	private write(type: string, message: string) {
		const timestamp = this.applyStyle(getTimestamp(), "2");
		if (type === "FSCodeAssist" || type === "compiler") {
			message = this.applyStyle(message, "1");
		} else if (type === "compile_progress" || type === "compile_done") {
			message = this.applyStyle("PROGRES:\t", "33") + this.applyStyle(message, "3");
		}
		this.writeEmitter.fire(`${timestamp}  ${message.replace(/\n/g, '\r\n')}\r\n`);
	}

	private static level2style: { [level: string]: string } = {
		info: "34",
		warning: "33",
		error: "31",
		command: "35",
	};

	private onData(data: any) {
		if (data.type === "compiler" && data.id === this.id) {
			if (data.start) {
				this.write("compiler", "Compilation started.");
				this.compileInProgress = true;
			} else if (data.finished) {
				this.write("compiler", "Compilation finished.");
				this.compileInProgress = false;
				this.closeEmitter.fire(data.status === "success" ? StatusCode.Success : StatusCode.Error);
				if (this.definition.refresh && data.status === "success") {
					vscode.commands.executeCommand('fatshark-code-assist.stingrayReloadSources');
				}
			}
		} else if (data.type === "compile_progress") {
			// Note: data.file is not necessarily a file.
			const count = data.count.toString();
			const i = data.i.toString().padStart(count.length, " ");
			this.write("compile_progress", `${i}/${count} - ${data.file ?? "<unknown file>"}`);
		} else if (data.type === "c") {
			this.write("compile_done", `status=${data.status}, file=${data.file}`);
		} else if (data.type === "message") {
			let message = data.message;
			if (/^Error compiling `([^`]+)`/.test(message)) {
				// This is a hack so we can capture the error message in the same line as the file.
				message = message.replace(/\n\n/, ": ");
			}
			if (data.error_context) {
				message += `\n${data.error_context}`;
			}
			const level = this.applyStyle(`[${data.level}]`, StingrayCompileTaskTerminal.level2style[data.level] ?? "0");
			if (data.system) {
				this.write("message", `${level}[${data.system}] ${message}`);
			} else {
				this.write("message", `${level} ${message}`);
			}
		}
	}

	private abortCompile() {
		const compiler = this.compiler;
		if (compiler.isReady && !compiler.isClosed) {
			compiler.onDidReceiveData.remove(this.onData);
			compiler.sendJSON({
				"id": this.id,
				"type" : "cancel",
			});
		}
	}

	private static validPlatforms = {
		"win32": true,
		"ps4": true,
		"xb1": true,
		"xb12": true,
	};

	private async startCompile() {
		const { toolchain, compiler, definition } = this;
		const platform = definition.platform;

		if (!StingrayCompileTaskTerminal.validPlatforms[platform]) {
			this.write("FSCodeAssist", `Unsupported platform ${platform}.`);
			this.closeEmitter.fire(StatusCode.Disconnect);
			return;
		}

		if (compiler.isClosed) {
			this.write("FSCodeAssist", `Could not connect to compile server.`);
			this.closeEmitter.fire(StatusCode.Disconnect);
			return;
		}

		compiler.onDidReceiveData.add(this.onData);
		compiler.onDidDisconnect.add(() => {
			this.closeEmitter.fire(StatusCode.Disconnect);
		});

		const config = await toolchain.config();
		const currentProject = config.Projects[config.ProjectIndex];
		const sourceDir = currentProject.SourceDirectory;
		const dataDir = pathJoin(currentProject.DataDirectoryBase, platform);

		const compileMessage: any = {
			"id": this.id,
			"type" : "compile",
			"source-directory" : sourceDir,
			"source-directory-maps" : [
				{ "directory" : "core", "root" : config.SourceRepositoryPath ?? toolchain.path }
			],
			"data-directory" : dataDir,
			"source-platform" : "win32",
			"destination-platform": platform,
		};

		if (definition.bundle) {
			let bundleDir = (platform !== "win32")
				? `${platform}_bundled`
				: `win32_${platform}_bundled`;
			compileMessage["bundle-directory"] = pathJoin(currentProject.DataDirectoryBase, bundleDir)
		}

		this.compiler.sendJSON(compileMessage);
		this.write("FSCodeAssist", `Compilation requested with id ${this.id}.`);
	}
}


const createExecution = (definition: StingrayTaskDefinition, toolchain: StingrayToolchain) => {
	return new vscode.CustomExecution(
		async (_resolvedDefinition: vscode.TaskDefinition): Promise<vscode.Pseudoterminal> => {
			return new StingrayCompileTaskTerminal(toolchain, definition);
		}
	);
};

export const createDefaultTask = (platform: Platform, toolchain: StingrayToolchain) => {
	const definition: StingrayTaskDefinition = {
		type: TASK_SOURCE,
		platform,
	};
	return new vscode.Task(
		definition,
		vscode.TaskScope.Workspace, // Should be Global, but currently not supported.
		`[${platform}] Compile`,
		TASK_SOURCE,
		createExecution(definition, toolchain),
		[
			"$stingray-build-lua-error",
			"$stingray-build-parse-error",
			"$stingray-build-sjson-error",
			"$stingray-build-generic-error",
		]
	);
};

export const activate = (context: vscode.ExtensionContext) => {
	context.subscriptions.push(vscode.tasks.registerTaskProvider(TASK_SOURCE, {
		// Provide a task for each platform.
		async provideTasks(_token: vscode.CancellationToken): Promise<vscode.Task[]> {
			const toolchain = getActiveToolchain();
			if (!toolchain) {
				return [];
			}
			const config = await toolchain.config();
			return config.Targets.map((target) => {
				return createDefaultTask(target.Platform, toolchain);
			});
		},
		// Check that the task is valid, and if it is fill out the execution field.
		resolveTask(task: vscode.Task, _token: vscode.CancellationToken): vscode.Task | undefined {
			const toolchain = getActiveToolchain();
			if (!toolchain) {
				return undefined;
			}
			const definition = task.definition;
			const platform = definition.platform;
			if (definition.type !== TASK_SOURCE || platform !== "win32") {
				return undefined; // Invalid task definition.
			}
			task.execution = createExecution(definition as StingrayTaskDefinition, toolchain);
			return task;
		},
	}));
};