import { cpus } from "os";
import { parentPort, workerData, isMainThread, Worker } from "worker_threads";
import { performance } from "perf_hooks";
import { readFile } from "fs/promises";

const WORKER_THREAD_COUNT = Math.min(5, Math.ceil(cpus().length / Math.PI));
const WORKER_PATH = __filename;

const OBJECT_DEFINITION_REGEX = /^\s*([A-Z][\w_]*)\s*=\s*/d;
const FUNCTION_SIGNATURE_REGEX = /^\s*function\s+(?:(\w+)[:.])?([\w_]+)\(([^)]*)\)/d;

export type RawSymbolInformation = {
	kind: "Object" | "Method" | "Class" | "Method" | "Enum",
	name: string,
	parent?: string,
	path: string,
	line: number,
	char: number,
};

export const parseFileSymbols = async function*(path: string) {
	const contents = await readFile(path, { encoding: 'utf8' });

	let line = -1;
	for (const lineString of contents.split(/\r?\n/)) {
		++line;

		const functionMatches = FUNCTION_SIGNATURE_REGEX.exec(lineString);
		if (functionMatches) {
			const [_, object, method] = functionMatches;
			yield ({
				kind: object ? "Method" : "Function",
				name: method,
				parent: object,
				path,
				line,
				char: (functionMatches as any).indices[2][0],
			} as RawSymbolInformation);
			continue;
		}

		const objectMatches = OBJECT_DEFINITION_REGEX.exec(lineString);
		if (objectMatches) {
			const indices: number[][] = (objectMatches as any).indices;
			const [_, object] = objectMatches;
			const rest = lineString.slice(indices[0][1]);
			let kind = "Object";
			if (rest.startsWith("class")) {
				kind = "Class";
			} else if (rest.startsWith("table.enum")) {
				kind = "Enum";
			} else if (rest.startsWith("\"")) {
				kind = "String";
			}
			yield ({
				kind: kind,
				name: object,
				path,
				line,
				char: indices[1][0],
			} as RawSymbolInformation);
			continue;
		}
	}
};

if (!isMainThread) {
	if (!parentPort) {
		throw new Error("No parentPort");
	}
	//parentPort.on("message", (path: string) => parseFileSymbols(path));
	workerData?.forEach(async (path: string) => {
		for await (const symbol of parseFileSymbols(path)) {
			parentPort?.postMessage(symbol);
		}
	});
}

export class Indexer {
	readonly path = WORKER_PATH;
	readonly threadCount = WORKER_THREAD_COUNT;
	private _workers: Worker[] = [];

	constructor(private _data: any[], private _onMessage: { (result: any): void }) {
	}

	abort() {
		for (const worker of this._workers) {
			worker.terminate();
		}
	}

	toChunks(list: Array<any>) {
		const stride = Math.floor(list.length / this.threadCount);
		const chunks = [];
		for (let i=0; i < this.threadCount; ++i) {
			let end = (i !== this.threadCount-1) ? (1+i)*stride : list.length;
			chunks[i] = list.slice(i*stride, end);
		}
		return chunks;
	}

	run() {
		return new Promise<number>((resolve, reject) => {
			const startTime = performance.now();
			const chunks = this.toChunks(this._data);
			let activeThreads = chunks.length;
			for (const chunk of chunks) {
				const worker = new Worker(this.path, { workerData: chunk, });
				this._workers.push(worker);
				worker.on("error", (err) => {
					reject(err);
				});
				worker.on("message", (msg) => this._onMessage(msg));
				worker.on("exit", (code) => {
					if (--activeThreads === 0) {
						resolve(performance.now() - startTime);
					}
				});
			}
		});
	}
}
