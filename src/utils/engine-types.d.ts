/* eslint-disable @typescript-eslint/naming-convention */

type EngineCallstack = EngineCallstackFrame[];

type EngineCallstackFrame = {
	local: EngineCallstackRecord[];
	up_values: EngineCallstackRecord[]; 
	source: string;
	line: number;
	function_start_line: number;
	function?: string;
};

type EngineCallstackRecord = {
	type: string;
	value: string;
	var_name: string;
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
