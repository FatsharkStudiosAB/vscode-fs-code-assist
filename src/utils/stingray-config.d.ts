/**
 * The schema of the `ToolChainConfiguration.config` SJSON file.
 *
 * This file usually located at `C:/BitSquidBinaries/<project>/settings/`.
 */
export type ToolchainConfig = {
	/** The selected engine build (PC-only). */
	Build: 'debug' | 'dev' | 'release';
	/** The index of the selected project. */
	ProjectIndex: number;
	/** A list of all configured projects. */
	Projects: Project[];
	/** The selected render backend (PC-only). */
	Renderer: 'D3D11' | 'D3D12';
	/** The ID of the selected run set. */
	RunId: string;
	/** A list of configured run sets. */
	RunSets: RunSet[];
	/** The path to the engine sources, if this toolchain was compiled locally.
	 *
	 * Whenever this is set, the core/ directory used in the source directory
	 * is used instead of the one in the installed toolchain directory.
	 */
	SourceRepositoryPath?: string;
	/** Configured targets to run the project in. */
	Targets: Target[];
};

/** A project. */
export type Project = {
	/** The arguments passed to the compiler. */
	CompileArguments: string;
	/** The directory containing compiled assets for all platforms. */
	DataDirectoryBase: string;
	/** A unique identifier, usually UUID4. */
	Id: string;
	/** The user-given name of the project. */
	Name: string;
	/** The directory containing source assets. */
	SourceDirectory: string;
	/** The toolcenter background color. */
	WantedBackgroundColor: Color;
	/** The text color used for targets. */
	WantedTargetColor: Color;
};

/** A color specification */
export type Color = {
	/** Red (0-255) */
	R: number;
	/** Green (0-255) */
	G: number;
	/** Blue (0-255) */
	B: number;
	/** Alpha (0-255) */
	A: number;
	/** Red (0.0-1.0) */
	ScR: number;
	/** Green (0.0-1.0) */
	ScG: number;
	/** Blue (0.0-1.0) */
	ScB: number;
	/** Alpha (0.0-1.0) */
	ScA: number;
};

export type RunSet = {
	/** A unique identifier, usually UUID4. */
	Id: string;
	/** The name of the run set. */
	Name: string;
	/** A list specifying the instances this set will launch.  */
	RunItems: Array<{
		/** Parameters to provide to the engine. */
		ExtraLaunchParameters?: string;
		/** Target in which to launch this item. */
		Target: string;
	}>;
};

export type Target = {
	/** A unique identifier, usually UUID4. */
	Id: string;
	/** IP address of the target. */
	Ip: string;
	/** User-given name of the target. */
	Name: string;
	/** The platform type */
	Platform: Platform;
	/** Port number of the target. */
	Port: number;
	/** Port at which the profiler will try to bind. */
	ProfilerPort: number;
};

export type Platform = 'win32' | 'ps4' | 'xb1' | 'xb12';
