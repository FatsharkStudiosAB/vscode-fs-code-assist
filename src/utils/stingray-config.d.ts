type ToolchainConfigColor = {
	A: number; B: number; G: number; R: number;
	ScA: number; ScB: number; ScG: number; ScR: number;
};

type ToolchainConfigProject = {
	CompileArguments: string;
	DataDirectoryBase: string;
	Id: string;
	Name: string;
	SourceDirectory: string;
	WantedBackgroundColor: ToolchainConfigColor;
	WantedTargetColor: ToolchainConfigColor;
};

type ToolchainConfigRunSet = {
	Id: string;
	Name: string;
	RunItems: Array<{
		ExtraLaunchParameters: string;
		Target: string;
	}>;
};

type ToolchainConfigTarget = {
	Id: string;
	Ip: string;
	Name: string;
	Platform: 'win32' | 'ps4' | 'xb1' | 'xb1';
	Port: number;
	ProfilerPort: number;
};

export type ToolchainConfig = {
	Build: 'debug' | 'dev' | 'release';
	ProjectIndex: number;
	Projects: ToolchainConfigProject[];
	Renderer: 'D3D11' | 'D3D12';
	RunId: string;
	RunSets: ToolchainConfigRunSet[];
	SourceRepositoryPath: string;
	Targets: ToolchainConfigTarget[];
};