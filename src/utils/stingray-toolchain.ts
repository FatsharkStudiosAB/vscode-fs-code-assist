import { existsSync as fileExists } from 'fs';
import { readFile, stat } from 'fs/promises';
import { join as pathJoin } from 'path';
import * as SJSON from 'simplified-json';

export class StingrayToolchain {
	public configPath: string;
	constructor(
		public path: string
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
}
