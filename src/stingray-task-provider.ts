import { join as pathJoin } from "path";
import * as vscode from "vscode";
import { connectionHandler } from "./connection-handler";
import { getActiveToolchain } from "./extension";
import { StingrayConnection } from "./stingray-connection";
import { getTimestamp, uuid4 } from "./utils/functions";
import type { Platform } from "./utils/stingray-config";
import { StingrayToolchain } from "./utils/stingray-toolchain";

// Documentation links:
// https://code.visualstudio.com/docs/editor/tasks
// https://github.com/microsoft/vscode-extension-samples/blob/main/task-provider-sample
// https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/tasks/common/problemMatcher.ts

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
	/** If true, on a successful compile all connected game instances will be reloaded. */
	refresh?: boolean;
	/** An optional list of filesystem patterns to watch. */
	watch?: string[];
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

	private id: string = "<not set>";
	private compileInProgress = false;
	private compileQueued = false;
	private compiler: StingrayConnection;
	private colorize = true;
	private fsWatchers: vscode.FileSystemWatcher[] = [];

	constructor(
		private toolchain: StingrayToolchain,
		private definition: StingrayTaskDefinition,
	) {
		this.compiler = connectionHandler.getCompiler();
		this.onData = this.onData.bind(this);
		this.onDisconnect = this.onDisconnect.bind(this);

		this.compiler.onDidReceiveData.add(this.onData);
		this.compiler.onDidDisconnect.add(this.onDisconnect);
	}

	open(_initialDimensions: vscode.TerminalDimensions | undefined): void {
		this.startCompile();
		let watch = this.definition.watch;
		if (watch) {
			const queueCompile = (_uri: vscode.Uri) => {
				this.tryStartCompile(true);
			};
			for (const pattern of watch) {
				const watcher = vscode.workspace.createFileSystemWatcher(pattern);
				watcher.onDidChange(queueCompile);
				watcher.onDidCreate(queueCompile);
				watcher.onDidDelete(queueCompile);
				this.fsWatchers.push(watcher);
			}
		}
	}

	close(): void {
		this.doClose();
	}

	private doClose(code?: StatusCode) {
		if (this.compileInProgress && this.compiler.isReady) {
			this.compiler.sendJSON({
				"id": this.id,
				"type" : "cancel",
			});
			this.compileInProgress = false;
		}
		this.compiler.onDidReceiveData.remove(this.onData);
		this.compiler.onDidDisconnect.remove(this.onData);

		if (this.fsWatchers) {
			this.fsWatchers.forEach((w) => w.dispose());
			this.fsWatchers = [];
		}

		if (code !== undefined) {
			this.closeEmitter.fire(code);
		}
	}

	private applyStyle(text: string, style: string) {
		return this.colorize ? `\x1B[${style}m${text}\x1B[0m` : text;
	}

	private write(type: string, message: string) {
		const timestamp = this.applyStyle(getTimestamp(), "2");
		if (type === "StingrayCompile" || type === "compiler") {
			message = this.applyStyle(message, "1");
		} else if (type === "compile_progress" || type === "compile_done") {
			message = this.applyStyle(message, "3");
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
				//this.compileInProgress = true; // Set when requested.
			} else if (data.finished) {
				this.write("compiler", "Compilation finished.");
				this.compileInProgress = false;
				const success = data.status === "success";
				if (this.definition.refresh && success) {
					vscode.commands.executeCommand('fatshark-code-assist.Connection.reloadResources');
				}
				if (this.fsWatchers.length > 0) {
					this.tryStartCompile();
					this.write("compiler", "Waiting for changes...");
				} else {
					this.doClose(success ? StatusCode.Success : StatusCode.Error);
				}
			}
		} else if (data.type === "compile_progress") {
			// Note: data.file is not necessarily a file.
			const count = data.count.toString();
			const i = (data.i + 1).toString().padStart(count.length, " ");
			const progress = this.applyStyle(`[progress]`, "33");
			const file = this.applyStyle(`${data.file ?? "<unknown file>"}`, "3");
			this.write("compile_progress", `${progress} ${i} / ${count} ${file}`);
		} else if (data.type === "compile_done") {
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

	private onDisconnect() {
		const compiler = this.compiler;
		this.write("StingrayCompile", `Lost connection to ${compiler.ip}:${compiler.port}.`);
		this.doClose(StatusCode.Disconnect);
	}

	private tryStartCompile(queue: boolean = false) {
		if (this.compileInProgress) {
			this.compileQueued = true;
		} else if (queue || this.compileQueued) {
			this.compileQueued = false;
			this.startCompile();
		}
	}

	private async startCompile() {
		const { toolchain, compiler, definition } = this;
		const platform = definition.platform;

		if (compiler.isClosed) {
			this.write("StingrayCompile", `Could not connect to compile server at ${compiler.ip}:${compiler.port}.`);
			this.doClose(StatusCode.Disconnect);
			return;
		}

		const config = await toolchain.config();
		const currentProject = config.Projects[config.ProjectIndex];
		const sourceDir = currentProject.SourceDirectory;
		const dataDir = pathJoin(currentProject.DataDirectoryBase, platform);

		this.id = uuid4();

		const compileMessage: any = {
			"id": this.id,
			"type": "compile",
			"source-directory": sourceDir,
			"source-directory-maps": [
				{ "directory": "core", "root" : config.SourceRepositoryPath ?? toolchain.path }
			],
			"data-directory": dataDir,
			"source-platform": platform,
			"destination-platform": "win32",
		};

		if (definition.bundle) {
			let bundleDir = (platform !== "win32")
				? `${platform}_bundled`
				: `win32_${platform}_bundled`;
			compileMessage["bundle-directory"] = pathJoin(currentProject.DataDirectoryBase, bundleDir);
		}

		this.compiler.sendJSON(compileMessage);
		this.write("StingrayCompile", `Compilation requested with id ${this.id}.`);
		this.compileInProgress = true;
	}
}


const createExecution = (toolchain: StingrayToolchain, definition: StingrayTaskDefinition) => {
	return new vscode.CustomExecution(
		async (_resolvedDefinition: vscode.TaskDefinition): Promise<vscode.Pseudoterminal> => {
			return new StingrayCompileTaskTerminal(toolchain, definition);
		}
	);
};

const DEFAULT_PROBLEM_MATCHERS = [
	"$stingray-build-lua-error",
	"$stingray-build-parse-error",
	"$stingray-build-sjson-error",
	"$stingray-build-generic-error",
];

export const createDefaultTask = (toolchain: StingrayToolchain, platform: Platform) => {
	const definition: StingrayTaskDefinition = {
		type: TASK_SOURCE,
		platform,
	};
	return new vscode.Task(
		definition,
		vscode.TaskScope.Workspace, // Should be Global, but currently not supported.
		`stingray_lua: ${platform}`,
		TASK_SOURCE,
		createExecution(toolchain, definition),
		DEFAULT_PROBLEM_MATCHERS
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
				return createDefaultTask(toolchain, target.Platform);
			});
		},
		// Check that the task is valid, and if it is fill out the execution field.
		resolveTask(task: vscode.Task, _token: vscode.CancellationToken): vscode.Task | undefined {
			const toolchain = getActiveToolchain();
			if (!toolchain) {
				return undefined;
			}
			const definition = task.definition;
			if (definition.type !== TASK_SOURCE) {
				return undefined; // Invalid task definition.
			}
			return new vscode.Task(
				definition, // Must be unchanged according to the docs.
				vscode.TaskScope.Workspace, // Can be undefined for some reason?
				task.name,
				task.source,
				createExecution(toolchain, definition as StingrayTaskDefinition),
				task.problemMatchers.length > 0 ? task.problemMatchers : DEFAULT_PROBLEM_MATCHERS
			);
		},
	}));
};

export const compileForPlatform = async (toolchain: StingrayToolchain, platform: Platform) => {
	const task = createDefaultTask(toolchain, platform);
	const taskExecution = await vscode.tasks.executeTask(task);
	return new Promise<boolean>((resolve) => {
		const disposable = vscode.tasks.onDidEndTaskProcess((taskEndEvent) => {
			if (taskEndEvent.execution === taskExecution) {
				disposable.dispose();
				resolve(taskEndEvent.exitCode === StatusCode.Success);
			}
		});
	});
};