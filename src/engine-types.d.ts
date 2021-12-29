type EngineCallstack = EngineCallstackFrame[];

type EngineCallstackFrame = {
	local: EngineCallstackRecord[];
	up_values: EngineCallstackRecord[]; // eslint-disable-line @typescript-eslint/naming-convention
	source: string;
	line: number;
	function_start_line: number; // eslint-disable-line @typescript-eslint/naming-convention
	function?: string;
};

type EngineCallstackRecord = {
	type: string;
	value: string;
	var_name: string; // eslint-disable-line @typescript-eslint/naming-convention
	key?: string;
};


type EngineExpandTable = {
	node_index: number;
	local_num: number;
	table_path: {
		level: number;
		local: string;
		path: number[];
	};
};
