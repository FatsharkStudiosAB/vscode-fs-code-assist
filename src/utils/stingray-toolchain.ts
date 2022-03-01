import { ChildProcess, exec, ExecOptions } from 'child_process';
import { existsSync as fileExists } from 'fs';
import { readFile, stat } from 'fs/promises';
import * as path from 'path';
import { join as pathJoin } from 'path';
import * as SJSON from 'simplified-json';
import { ToolchainConfig } from './stingray-config';

type LaunchOptions = {
	/** The UUID of the target to launch the instance on.*/
	targetId: string;
	/** Extra arguments to the Stingray process */
	arguments?: string;
};

/**
 * A Stingray toolchain represents an installation of the engine and its associated tools.
 */
export class StingrayToolchain {
	/** Path to the toolchain's SJSON configuration file. */
	public configPath: string;

	/**
	 * Create a toolchain data object.
	 * @param path 
	 */
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

	/**
	 * Retrieve the toolchain configuration.
	 * @returns The toolchain configuration data.
	 */
	async config(): Promise<ToolchainConfig> {
		const stats = await stat(this.configPath);
		if (stats.mtimeMs > this.configCacheTime) {
			const buffer = await readFile(this.configPath, 'utf8');
			this.configCacheData = SJSON.parse(buffer);
			this.configCacheTime = stats.mtimeMs;
		}
		return this.configCacheData!;
	}

	private static buildToExecutableName = {
		'debug': 'stingray_win64_dev_x64.exe',
		'dev': 'stingray_win64_dev_x64.exe',
		'release': 'vermintide2',
	};

	/**
	 * Launch an instance of Stingray with the given toolchain.
	 * @param options Launch options.
	 * @returns A newly created ChildProcess.
	 */
	async launch(options: LaunchOptions): Promise<ChildProcess> {
		const config = await this.config();

		const target = config.Targets.find((target) => target.Id === options.targetId);
		if (!target) {
			throw new Error(`Target ${options.targetId} not found`);
		}

		if (target.Platform !== 'win32') {
			throw new Error(`Platform ${target.Platform} currently not supported in the VSCode extension`);
			// Unsupported platforms: linux_server ps4 win64_dx12 win64_server xb12
		}
		const platformDirectory = 'win64';

		const engineExe = path.join(this.path, 'engine', platformDirectory, config.Build, StingrayToolchain.buildToExecutableName[config.Build]);
		const engineArguments = `--toolchain ${this.path} ${options.arguments ?? ''} `;
		return exec(`${engineExe} ${engineArguments}`);
	}
}
