/* eslint-disable @typescript-eslint/naming-convention */

export type FrameId = number;

/** A callstack. */
export type EngineCallstack = CallFrame[];

/** A single frame in the callstack. */
export type CallFrame = {
	/** A reasonable name for the given function.
	 *
	 * It checks how the function was called to find a suitable name.
	 */
	function?: string;
	/** The line number where the definition of the function starts. */
	function_start_line?: number;
	/** The current line where the given function is executing */
	line?: number;
	/** A list of locals. */
	local: VariableRecord[];
	/** The resource path in which this function was defined.
	 *
	 * This is `=[C]` for C functions.
	 */
	source: string;
	/** A list of upvalues. */
	up_values: VariableRecord[];
};

/** The record of a live variable in the stack or in a table. */
export type VariableRecord = {
	/** `The  */
	key?: string;
	/** The Lua type name. */
	type: string;
	/** The value, represented as a string. */
	value: string;
	/** The name of the variable */
	var_name?: string;
};
