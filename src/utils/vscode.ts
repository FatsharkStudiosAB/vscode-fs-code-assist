import * as vscode from 'vscode';

export const formatCommand = (commandName: string, commandArg: any) => {
	return vscode.Uri.parse(
		`command:${commandName}?${encodeURIComponent(JSON.stringify(commandArg))}`
	);
};
