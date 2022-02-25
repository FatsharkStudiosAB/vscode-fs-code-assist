import * as vscode from 'vscode';

/**
 * Create a URI that executes a given VSCode command.
 * @param commandName Name of the command to execute.
 * @param commandArg Arguments to the command. Must be JSON serializable.
 * @returns An URI that executes the given command.
 */
export const formatCommand = (commandName: string, commandArg: any) => {
	return vscode.Uri.parse(
		`command:${commandName}?${encodeURIComponent(JSON.stringify(commandArg))}`
	);
};
