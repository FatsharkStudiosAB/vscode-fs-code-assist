// implements tree view UI for connected clients
import { join } from 'path';
import * as vscode from 'vscode';
import { } from './extension';
import { getToolchainSettings, getToolchainSettingsPath } from './utils';

export class ConnectionTargetsNodeProvider implements vscode.TreeDataProvider<ConnectionTargetTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ConnectionTargetTreeItem | undefined | void> = new vscode.EventEmitter<ConnectionTargetTreeItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<ConnectionTargetTreeItem | undefined | void> = this._onDidChangeTreeData.event;

    getTreeItem(element: ConnectionTargetTreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
        return element;
    }
    getChildren(element?: ConnectionTargetTreeItem): vscode.ProviderResult<ConnectionTargetTreeItem[]> {
        return Promise.resolve(this._gatherConnectionTargets());
    }
    refresh(): void {
		this._onDidChangeTreeData.fire();
	}

    private _gatherConnectionTargets() {
        const config = vscode.workspace.getConfiguration("stingray_lua");
        const toolchainRootPath = <string|undefined>config.get("toolchainPath");
        const toolchainName = <string|undefined>config.get("toolchainName");
        if (!toolchainRootPath || !toolchainName) {
            return;
        }

        const toolchainPath = join(toolchainRootPath, toolchainName);
        let tcPath = getToolchainSettingsPath(toolchainPath);
        if (!tcPath) {
            return;
        }
        
        let tcSettings = getToolchainSettings(tcPath);
        let treeItems: ConnectionTargetTreeItem[] = [];
        tcSettings.Targets.forEach((target: { Name: string; Platform: any; Ip: any; Port: any; }) => {
            let newItem = new ConnectionTargetTreeItem( target.Name, target.Platform, target.Ip, target.Port );
            treeItems.push( newItem ); 
        });
        return treeItems;
    }
}

export class ConnectionTargetTreeItem extends vscode.TreeItem {
	constructor(
        public readonly name: string,
        public readonly platform: string,
        public readonly ip: string,
        public readonly port: number,
	) {
        super(`${name} ${platform} ${ip}:${port}`, vscode.TreeItemCollapsibleState.None);
	}

	contextValue = 'connection-target';
}