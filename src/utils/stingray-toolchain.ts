import { existsSync as fileExists } from 'fs';
import { readFile, stat } from 'fs/promises';
import { join as pathJoin } from 'path';
import * as SJSON from 'simplified-json';
import { ToolchainConfig } from './stingray-config';

/** A Stingray toolchain represents an installation of the engine and its associated tools. */
export class StingrayToolchain {
	/** Path to the toolchain's SJSON configuration file. */
	public configPath: string;
	constructor(
		/** Path to the toolchain root directory. */
		public readonly path: string
	) {
		this.configPath = pathJoin(this.path, 'settings', 'ToolChainConfiguration.config');
		if (!fileExists(this.configPath)) {
			throw new Error('Invalid toolchain');
		}
	}

	private configCacheTime: number = 0;
	private configCacheData: ToolchainConfig | undefined;
	async config(): Promise<ToolchainConfig> {
		const stats = await stat(this.configPath);
		if (stats.mtimeMs > this.configCacheTime) {
			const buffer = await readFile(this.configPath, 'utf8');
			this.configCacheData = SJSON.parse(buffer);
			this.configCacheTime = stats.mtimeMs;
		}
		return this.configCacheData!;
	}
}
