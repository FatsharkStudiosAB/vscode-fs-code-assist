import { basename } from "path";
import * as SJSON from 'simplified-json';
import { TextDecoder } from "util";
import * as vscode from "vscode";
import { activate as activateAdocAutocomplete } from './adoc-autocomplete';
import { RawSymbolInformation, TaskRunner } from "./project-symbol-indexer";
import { BooleanEvaluator } from "./utils/boolean-evaluator";
import { formatCommand } from "./utils/vscode";

const LANGUAGE_SELECTOR = "lua";

class StingrayLuaLanguageServer {
	private _initialized = false;
	private _symbols = new Map<String, vscode.SymbolInformation[]>();
	private _textures = new Map<String, vscode.Uri>();

	constructor() {
		vscode.workspace.onWillSaveTextDocument(this.onWillSaveTextDocument.bind(this));
	}

	pushSymbolData(symbol: RawSymbolInformation) {
		const { name, path, line, char, kind, parent } = symbol;
		let list = this._symbols.get(name);
		if (!list) {
			list = [];
			this._symbols.set(name, list);
		}
		const location = new vscode.Location(vscode.Uri.file(path), new vscode.Position(line, char));
		list.push(new vscode.SymbolInformation(name, vscode.SymbolKind[kind], parent || "", location));
	}

	async symbols() {
		await this._ensureInitialized();
		return this._symbols;
	}

	async textures() {
		await this._ensureInitialized();
		return this._textures;
	}

	async _ensureInitialized() {
		if (!this._initialized) {
			this._initialized = true;
			await this.parseAllLuaFiles();
			await this.indexTextureFiles();
		}
	}

	async parseAllLuaFiles(token?: vscode.CancellationToken) {
		const uris = await vscode.workspace.findFiles("{foundation,scripts}/**/*.lua");
		const indexer = new TaskRunner("parseFileSymbols", uris.map((uri) => uri.fsPath), this.pushSymbolData.bind(this));
		token?.onCancellationRequested(() => {
			indexer.abort();
		});
		try {
			const elapsed = await indexer.run();
			vscode.window.showInformationMessage(`Indexed ${uris.length} files in ${Math.floor(elapsed)} ms using up to ${indexer.threadCount} worker threads.`);
		} catch (e) {
			vscode.window.showErrorMessage((e as Error).message);
		}
	}

	async indexTextureFiles() {
		const uris = await vscode.workspace.findFiles("{.gui_source_textures,gui/1080p/single_textures}/**/*.png");
		for (const uri of uris) {
			this._textures.set(basename(uri.path, ".png"), uri);
		}
	}

	onWillSaveTextDocument(event: vscode.TextDocumentWillSaveEvent) {
		if (event.document.languageId === "lua") {
			//this.parseLuaFile(event.document.uri);
		}
	}
}


export function activate(context: vscode.ExtensionContext) {
	const server = new StingrayLuaLanguageServer();

	context.subscriptions.push(vscode.languages.registerDefinitionProvider(LANGUAGE_SELECTOR, {
		async provideDefinition(document, position) {
			const wordRange = document.getWordRangeAtPosition(position, /[\w_]+/);
			if (!wordRange) {
				return undefined;
			}
			const word = document.getText(wordRange);
			const symbols = await server.symbols();
			return symbols.get(word)?.map((sym) => sym.location);
		}
	}));

	context.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider({
		async provideWorkspaceSymbols(query) {
			const symbols = await server.symbols();
			query = query.toLowerCase();
			let result: vscode.SymbolInformation[] = [];
			for (const [key, symbolList] of symbols) {
				if (key.toLowerCase().includes(query)) {
					result.push(...symbolList);
				}
			}
			return result;
		}
	}));

	const preprocessorDimDecoration = vscode.window.createTextEditorDecorationType({
		opacity: "0.62",
		//backgroundColor: backgroundColor,
		//color: color,
		rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen
	});

	const countIndent = (text: string, tabSize: number) => {
		let n = 0;
		for (const char of text) {
			if (char === ' ') {
				++n;
			} else if (char === '\t') {
				n += tabSize - n % tabSize;
			} else {
				return n;
			}
		}
		return -1;
	};

	const getFeatureTags = async () => {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return;
		}
		const preprocessorConfigPath = vscode.Uri.joinPath(folder.uri, 'lua_preprocessor_defines.config');
		const preprocessorConfigBuffer = await vscode.workspace.fs.readFile(preprocessorConfigPath);
		const decoder = new TextDecoder("utf-8");
		const preprocessorConfig = SJSON.parse(decoder.decode(preprocessorConfigBuffer));
		return preprocessorConfig.valid_tags;
	};

	context.subscriptions.push(vscode.languages.registerFoldingRangeProvider(LANGUAGE_SELECTOR, {
		async provideFoldingRanges(document, _context, _token) {
			const foldingRanges = [];
			const decoratorRanges = [];
			const regionStack: [number, boolean|null][] = [];
			const indentStack: number[] = [];
			let lastIndent = 0;

			const featureTags = await getFeatureTags();
			const evaluator = new BooleanEvaluator(featureTags);

			const editors = vscode.window.visibleTextEditors.filter(e => e.document.uri.toString() === document.uri.toString());
			const tabSize = (editors[0] || vscode.window.activeTextEditor)?.options.tabSize as number ?? 4;

			for (let i=0; i < document.lineCount; ++i) {
				const line = document.lineAt(i);
				const text = line.text;

				const indent = countIndent(text, tabSize);
				if (indent > lastIndent) {
					indentStack.push(i-1);
					lastIndent = indent;
				} else if (indent < lastIndent && indent !== -1) {
					const start = indentStack.pop() as number;
					foldingRanges.push(new vscode.FoldingRange(start, i-1, vscode.FoldingRangeKind.Region));
					lastIndent = indent;
				}

				const ifBeginIndex = text.indexOf("--IF_BEGIN");
				if (ifBeginIndex !== -1) {
					const isActive = evaluator.eval(text.substring(ifBeginIndex+10));
					regionStack.push([ i, isActive ]);
				} else if (text.indexOf("--IF_END") !== -1) {
					const region = regionStack.pop();
					if (region) {
						let [start, isActive] = region;
						foldingRanges.push(new vscode.FoldingRange(start, i-1, vscode.FoldingRangeKind.Region));
						if (!isActive) {
							decoratorRanges.push(new vscode.Range(start+1, 0, i, 0));
						}
					} else {
						//console.log('Stack underflow!');
					}
				} else if (regionStack.length === 0) {
					const ifLineIndex = text.indexOf("--IF_LINE");
					if (ifLineIndex !== -1) {
						const isActive = evaluator.eval(text.substring(ifLineIndex+9));
						if (!isActive) {
							decoratorRanges.push(new vscode.Range(i, 0, i, ifLineIndex));
						}
					}
				}
			}

			for (const e of editors) {
				e.setDecorations(preprocessorDimDecoration, decoratorRanges);
			}

			if (regionStack.length !== 0) {
				//console.log('Unbalanced region stack!');
			}

			if (indentStack.length !== 0) {
				//console.log('Unbalanced indent stack!');
				const lastLine = document.lineCount - 1;
				while (indentStack.length > 0) {
					const start = indentStack.pop() as number;
					foldingRanges.push(new vscode.FoldingRange(start, lastLine, vscode.FoldingRangeKind.Region));
				}
			}

			return foldingRanges;
		}
	}));

	type MethodData = {
		name: string;
		args: string[];
	};

	const methodList: MethodData[] = [];

	const CLASS_REGEX = /^(\w+)\s*=\s*class/;
	const OBJECT_REGEX = /^(\w+)\s*=\s*\1/;
	const METHOD_REGEX = /^function\s+(\w+)[:.]([\w_]+)\(([^)]*)\)/;
	const FUNCTION_REGEX = /^function\s+([\w_]+)\(/;
	const ENUM_REGEX = /([\w_]+)\s*=\s*table\.enum\(/;
	const CONST_REGEX = /^(?:local\s+)?([A-Z_]+)\s*=/;
	const LOCAL_REGEX = /^local(?:\s+function)?\s+([\w_]+)\b/;
	context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(LANGUAGE_SELECTOR, {
		provideDocumentSymbols(document, _token) {
			const symbols = [];
			const symbolLookup = new Map<string, vscode.DocumentSymbol>();

			methodList.length = 0; // Clear the array, JavaScript style.

			for (let i=0; i < document.lineCount; ++i) {
				const line = document.lineAt(i);
				const text = line.text;
				const range = new vscode.Range(i, 0, i, 0);
				const selectionRange = new vscode.Range(i, 0, i, 0);

				const methodMatches = METHOD_REGEX.exec(text);
				if (methodMatches) {
					const [_, mClass, mMethod, mArgs] = methodMatches;
					const kind = (mMethod === "init") ? vscode.SymbolKind.Constructor : vscode.SymbolKind.Method;
					const symbol = new vscode.DocumentSymbol(mMethod, mClass, kind, range, selectionRange);
					const parent = symbolLookup.get(mClass);
					if (parent) {
						parent.children.push(symbol);
					} else {
						symbols.push(symbol);
					}
					methodList.push({
						name: mMethod,
						args: mArgs.split(/\s*,\s*/),
					});
					continue;
				}

				const functionMatches = FUNCTION_REGEX.exec(text);
				if (functionMatches) {
					const [_, mFunc] = functionMatches;
					symbols.push(new vscode.DocumentSymbol(mFunc, "", vscode.SymbolKind.Function, range, selectionRange));
					continue;
				}

				const classMatches = CLASS_REGEX.exec(text);
				if (classMatches) {
					const [_, mClass] = classMatches;
					const symbol = new vscode.DocumentSymbol(mClass, "", vscode.SymbolKind.Class, range, selectionRange);
					symbols.push(symbol);
					symbolLookup.set(mClass, symbol);
					continue;
				}

				const objectMatches = OBJECT_REGEX.exec(text);
				if (objectMatches) {
					const [_, mObj] = objectMatches;
					const symbol = new vscode.DocumentSymbol(mObj, "", vscode.SymbolKind.Object, range, selectionRange);
					symbols.push(symbol);
					symbolLookup.set(mObj, symbol);
					continue;
				}

				const enumMatches = ENUM_REGEX.exec(text);
				if (enumMatches) {
					const [_, mEnum] = enumMatches;
					symbols.push(new vscode.DocumentSymbol(mEnum, "", vscode.SymbolKind.Enum, range, selectionRange));
					continue;
				}

				const constMatches = CONST_REGEX.exec(text);
				if (constMatches) {
					const [_, mConst] = constMatches;
					symbols.push(new vscode.DocumentSymbol(mConst, "", vscode.SymbolKind.Constant, range, selectionRange));
					continue;
				}

				const localMatches = LOCAL_REGEX.exec(text);
				if (localMatches) {
					const [_, mLocal] = localMatches;
					symbols.push(new vscode.DocumentSymbol(mLocal, "", vscode.SymbolKind.Variable, range, selectionRange));
					continue;
				}
			}
			return symbols;
		}
	}));

	const COLOR_REGEX = /\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/d;
	context.subscriptions.push(vscode.languages.registerColorProvider(LANGUAGE_SELECTOR, {
		provideColorPresentations(color, _context, _token) {
			const cA = (255*color.alpha).toFixed(0);
			const cR = (255*color.red).toFixed(0);
			const cG = (255*color.green).toFixed(0);
			const cB = (255*color.blue).toFixed(0);
			const presentation = new vscode.ColorPresentation(`{${cA},${cR},${cG},${cB}}`);
			// presentation.textEdit = new TextEdit()
			return [ presentation ];
		},
		provideDocumentColors(document, _token) {
			const colors = [];

			for (let i=0; i < document.lineCount; ++i) {
				const line = document.lineAt(i);
				const text = line.text;

				const colorMatches = COLOR_REGEX.exec(text);
				if (colorMatches) {
					const [_, cA, cR, cG, cB] = colorMatches;
					const color = new vscode.Color(parseInt(cR, 10)/255, parseInt(cG, 10)/255, parseInt(cB, 10)/255, parseInt(cA, 10)/255);
					const indices = (<any> colorMatches).indices; // Ugly hack to shut up TypeScript.
					const range = new vscode.Range(i, indices[0][0], i, indices[0][1]);
					colors.push(new vscode.ColorInformation(range, color));
				}
			}

			return colors;
		}
	}));

	// Texture preview.
	context.subscriptions.push(vscode.languages.registerHoverProvider(LANGUAGE_SELECTOR, {
		async provideHover(document, position) {
			const { text } = document.lineAt(position);
			let startPos = -1;
			for (let i = position.character-1; i > -1; --i) {
				const char = text[i];
				if (char === '"') {
					startPos = i + 1;
					break;
				} else if (!/\w/.test(char)) {
					return;
				}
			}
			let endPos = -1;
			for (let j = position.character; j < text.length; ++j) {
				const char = text[j];
				if (char === '"') {
					endPos = j;
					break;
				} else if (!/\w/.test(char)) {
					return;
				}
			}
			if (startPos === -1 || endPos === -1) {
				return;
			}
			const hoverRange = new vscode.Range(
				new vscode.Position(position.line, startPos),
				new vscode.Position(position.line, endPos)
			);
			const path = text.substring(startPos, endPos);
			const textures = await server.textures();
			const uri = textures.get(path);
			if (!uri) {
				return;
			}
			const mdString = new vscode.MarkdownString();
			mdString.supportHtml = true;
			mdString.isTrusted = true;
			const openExternalUri = formatCommand('fatshark-code-assist._goToResource', {
				external: true,
				file: uri.fsPath,
			});
			const openVSCodeUri = formatCommand('fatshark-code-assist._goToResource', {
				external: false,
				file: uri.fsPath,
			});
			mdString.appendCodeblock(path, 'plaintext');
			mdString.appendMarkdown([
				`---`,
				`\n<img src='${uri.toString()}'>\n`,
				`---`,
				`[Open externally](${openExternalUri}) | [Open in VSCode](${openVSCodeUri})`,
			].join('\n'));
			return new vscode.Hover(mdString, hoverRange);
		}
	}));

	activateAdocAutocomplete(context);

	context.subscriptions.push(vscode.languages.registerCompletionItemProvider(LANGUAGE_SELECTOR, {
		async provideCompletionItems(document, position, _token, _context) {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				return;
			}
			const { text } = document.lineAt(position);
			let endPos;
			for (endPos = position.character-1; endPos > -1; --endPos) {
				const char = text[endPos];
				if (char === '"') {
					return;
				} else if (char === '/') {
					break;
				}
			}
			let startPos = -1;
			for (startPos = endPos-1; startPos > -1; --startPos) {
				const char = text[startPos];
				if (char === '"') {
					++startPos;
					break;
				} else if (!/[\w/]/.test(char)) {
					return;
				}
			}
			if (startPos < 0) {
				return;
			}
			const base = text.slice(startPos, endPos);
			const uri = vscode.Uri.joinPath(folder.uri, base);
			const fileTuples = await vscode.workspace.fs.readDirectory(uri);
			const completions: vscode.CompletionItem[] = [];
			fileTuples.forEach(([fileName, fileType]) => {
				if (fileName.endsWith('.processed')) {
					return;
				}
				const kind = fileType === vscode.FileType.Directory ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File;
				const label = fileName.split('.')[0];
				const item = new vscode.CompletionItem(label, kind);
				item.detail = fileName;
				completions.push(item);
			});
			return completions;
		}
	}, '/'));

	context.subscriptions.push(vscode.languages.registerCompletionItemProvider(LANGUAGE_SELECTOR, {
		provideCompletionItems(document, position, _token, _context) {
			const range = new vscode.Range(position.line, position.character-5, position.line, position.character-1);
			const word = document.getText(range);
			if (word !== "self") {
				return null;
			}
			return methodList.map((method) => {
				const item = new vscode.CompletionItem(method.name, vscode.CompletionItemKind.Function);
				item.detail = "(method)";
				//item.documentation = "Tell me if you can see this.";
				return item;
			});
		}
	}, ":"));
	/*
	languages.registerSignatureHelpProvider(LANGUAGE_SELECTOR, {
		provideSignatureHelp(document, position, token, context) {
			const text = document.lineAt(position).text;
			const start = text.lastIndexOf("self:", position.character);
			if (start === -1) {
				return null;
			}
			return {
				signatures: [
					new SignatureInformation("label", "documentation")
				],
				activeSignature: 0,
				activeParameter: 0,
			};
		}
	}, "(,");
	*/
	const LUA_LINK_REGEX = /@?([\w/]+\.lua)(?::(\d+))?\b/d;
	const RESOURCE_LINK_REGEX = /\[(\w+) '([\w/]+)'\]/d;
	context.subscriptions.push(vscode.languages.registerDocumentLinkProvider("stingray-output", {
		provideDocumentLinks(document, _token) {
			const links: vscode.DocumentLink[] = [];

			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				return links;
			}
			const rootUri = folder.uri.fsPath;

			for (let i=0; i < document.lineCount; ++i) {
				const line = document.lineAt(i);
				const text = line.text;

				const luaMatches = LUA_LINK_REGEX.exec(text);
				if (luaMatches) {
					const indices = (<any> luaMatches).indices;
					const range = new vscode.Range(i, indices[0][0], i, indices[0][1]);
					const commandUri = formatCommand('fatshark-code-assist._goToResource', {
						external: false,
						file: `${rootUri}/${luaMatches[1]}`,
						line: luaMatches[2] ? parseInt(luaMatches[2], 10) : 1,
					});
					const link = new vscode.DocumentLink(range, commandUri);
					link.tooltip = 'Open in VSCode';
					links.push(link);
					continue;
				}

				const resMatches = RESOURCE_LINK_REGEX.exec(text);
				if (resMatches) {
					const indices = (<any> resMatches).indices;
					const range = new vscode.Range(i, indices[0][0], i, indices[0][1]);
					const commandUri = formatCommand('fatshark-code-assist._goToResource', {
						external: true,
						file: `${rootUri}/${resMatches[2]}.${resMatches[1].toLowerCase()}`,
					});
					const link = new vscode.DocumentLink(range, commandUri);
					link.tooltip = 'Open externally';
					links.push(link);
					continue;
				}
			}

			return links;
		}
	}));

	/*
	const SEMANTIC_TOKENS_LEGEND = {
		tokenModifiers: [],
		tokenTypes: [],
	};
	languages.registerDocumentSemanticTokensProvider(LANGUAGE_SELECTOR, {
		provideDocumentSemanticTokens(document, token,) {
			const builder = new SemanticTokensBuilder(SEMANTIC_TOKENS_LEGEND);
			const regionStack: boolean[] = []; // True signals that the line should be commented out.

			for (let i=0; i < document.lineCount; ++i) {
				const line = document.lineAt(i);
				const text = line.text;

				if (IF_BEGIN_REGEX.test(text)) {
					regionStack.push(Math.random() < 0.5);
				} else if (IF_END_REGEX.test(text)) {
					regionStack.pop();
				}

				if (regionStack[0]) {
					builder.push(i, 1, text.length, token.type);
				}
			}

			return builder.build();
		}
	}, SEMANTIC_TOKENS_LEGEND);
	//*/
}

/* Putting these links here as a dirty scratchpad:
https://regex101.com/
https://github.com/winlibs/oniguruma/blob/master/doc/RE
https://www.regular-expressions.info/lookaround.html
https://github.com/microsoft/vscode/blob/1e810cafb7461ca077c705499408ca838524c014/extensions/theme-monokai/themes/monokai-color-theme.json
*/