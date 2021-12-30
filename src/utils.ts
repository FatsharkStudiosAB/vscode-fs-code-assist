import { existsSync as fileExists } from 'fs';
import { readFile, stat } from 'fs/promises';
import { join as pathJoin } from 'path';
import * as SJSON from 'simplified-json';

/**
 * Returns a GUID
 * RFC 4122 Version 4 Compliant solution:
 * http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript
 * @memberOf stingray
 * @return {string}
 */
export function uuid4(): string {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = Math.random()*16|0;
		const v = c === "x" ? r : (r&0x3|0x8);
		return v.toString(16);
	});
};

export function getTimestamp(): string {
	const date = new Date();
	const hh = date.getHours().toString().padStart(2,"0");
	const mm = date.getMinutes().toString().padStart(2,"0");
	const ss = date.getSeconds().toString().padStart(2,"0");
	const ms = date.getMilliseconds().toString().padStart(3,"0");
	return `${hh}:${mm}:${ss}.${ms}`;
}

export class Multicast {
	private listeners: Function[] = [];

	add(func: Function) {
		this.listeners.push(func);
	};

	remove(func: Function) {
		this.listeners = this.listeners.filter((f) => func === f);
	}

	fire(...args: any[]) {
		this.listeners.forEach((func: Function) => func.apply(null, args));
	}
};

export class StingrayToolchain {
	public configPath: string;
	constructor(
		public path: string, // Eg, C:/BitsquidBinaries/vermintide2
	) {
		this.configPath = pathJoin(this.path, 'settings', 'ToolChainConfiguration.config');
		if (!fileExists(this.configPath)) {
			throw new Error('Invalid toolchain');
		}
	}

	private configCacheTime: number = 0;
	private configCacheData: any;
	async config() {
		const stats = await stat(this.configPath);
		if (stats.mtimeMs > this.configCacheTime) {
			const buffer = await readFile(this.configPath, 'utf8');
			this.configCacheData = SJSON.parse(buffer);
			this.configCacheTime = stats.mtimeMs;
		}
		return this.configCacheData;
	}

	/*
	private projectsCache?: StingrayProject[] = undefined;
	async projects() {
		if (!this.projectsCache) {
			const config = await this.config();
			this.projectsCache = config.Projects.map((def: any) => {
				const { Name, SourceDirectory, DataDirectoryBase } = def;
				return new StingrayProject(Name, SourceDirectory, DataDirectoryBase);
			});
		}
		return this.projectsCache;
	}
	*/
}

export class BooleanEvaluator {
	static binaryOperators: any = {
		'or': { prec: 1, func: (a: boolean, b: boolean) => a || b },
		'and': { prec: 2, func: (a: boolean, b: boolean) => a && b },
	};
	static unaryOperators: any = {
		'not': { prec: 3, func: (a: boolean) => !a },
	};

	private tokens: string[] = [];
	public error?: any;
	constructor(
		private symbols: { [ symbol: string ]: boolean } = {}
	) {}

	eval(text: string): boolean | null {
		try {
			this.tokens = [...text.matchAll(/\w+|[()]/g)].flat();
			return this._expr(0);
		} catch (err) {
			this.error = err;
			return null;
		}
	};

	_atom(): boolean {
		const tok = this.tokens.shift();
		if (tok === '(') {
			const val = this._expr(0);
			const close = this.tokens.shift();
			if (close !== ')') {
				throw new Error(`')' expected near '${close || '<eol>'}'`);
			}
			return val;
		} else if (!tok || BooleanEvaluator.binaryOperators[tok]) {
			throw new Error(`unexpected symbol near '${tok || '<eol>'}'`);
		} else if (tok) {
			const op = BooleanEvaluator.unaryOperators[tok];
			return op.func(this._expr(op.prec));
		} else {
			return !!(this.symbols[tok]);
		}
	}

	_expr(limit: number): boolean {
		let lhs = this._atom();
		while (true) {
			const op = BooleanEvaluator.binaryOperators[this.tokens[0]];
			const prec = op?.prec || -1;
			if (prec < limit) {
				break;
			}
			this.tokens.shift();
			lhs = op.func(lhs, this._expr(prec+1));
		}
		return lhs;
	}
}
