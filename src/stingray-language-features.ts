import { Color, ColorInformation, ColorPresentation, Disposable, DocumentLink, DocumentSymbol, FoldingRange, FoldingRangeKind, languages, Range, SemanticTokensBuilder, SymbolKind, Uri } from "vscode";

const LANGUAGE_SELECTOR = "lua";

const disposables: Disposable[] = [];

export function activate() {
	const IF_BEGIN_REGEX = /^\s*--IF_BEGIN/;
	const IF_END_REGEX = /^\s*--IF_END/;

	languages.registerFoldingRangeProvider(LANGUAGE_SELECTOR, {
		provideFoldingRanges(document, context, token) {
			const foldingRanges = [];
			const regionStack = [];

			for (let i=0; i < document.lineCount; ++i) {
				const line = document.lineAt(i);
				// if (line.isEmptyOrWhitespace) continue;
				const text = line.text;

				if (IF_BEGIN_REGEX.test(text)) {
					regionStack.push(i);
				} else if (IF_END_REGEX.test(text)) {
					const start = <number> regionStack.pop();
					foldingRanges.push(new FoldingRange(start, i, FoldingRangeKind.Region));
				}
			}

			if (regionStack.length !== 0) {
				//console.log("Unbalanced preprocessor directives!");
			}

			return foldingRanges;
		}
	});

	const CLASS_REGEX = /^(\w+)\s*=\s*class/;
	const OBJECT_REGEX = /^(\w+)\s*=\s*\1/;
	const METHOD_REGEX = /^function\s+(\w+)[:.]([\w_]+)\(/;
	const FUNCTION_REGEX = /^function\s+([\w_]+)\(/;
	const ENUM_REGEX = /([\w_]+)\s*=\s*table\.enum\(/;
	const CONST_REGEX = /^(?:local\s+)?([A-Z_]+)\s*=/;
	const LOCAL_REGEX = /^local(?:\s+function)?\s+([\w_]+)\b/;
	languages.registerDocumentSymbolProvider(LANGUAGE_SELECTOR, {
		provideDocumentSymbols(document, token) {
			const symbols = [];
			const symbolLookup = new Map<string, DocumentSymbol>();

			for (let i=0; i < document.lineCount; ++i) {
				const line = document.lineAt(i);
				const text = line.text;
				const range = new Range(i, 0, i, 0);
				const selectionRange = new Range(i, 0, i, 0);

				const methodMatches = METHOD_REGEX.exec(text);
				if (methodMatches) {
					const [_, mClass, mMethod] = methodMatches;
					const kind = (mMethod === "init") ? SymbolKind.Constructor : SymbolKind.Method;					
					const symbol = new DocumentSymbol(mMethod, mClass, kind, range, selectionRange);
					const parent = symbolLookup.get(mClass);
					if (parent) {
						parent.children.push(symbol);
					} else {
						symbols.push(symbol);
					}
					continue;
				}

				const functionMatches = FUNCTION_REGEX.exec(text);
				if (functionMatches) {
					const [_, mFunc] = functionMatches;
					symbols.push(new DocumentSymbol(mFunc, "", SymbolKind.Function, range, selectionRange));
					continue;
				}

				const classMatches = CLASS_REGEX.exec(text);
				if (classMatches) {
					const [_, mClass] = classMatches;
					const symbol = new DocumentSymbol(mClass, "", SymbolKind.Class, range, selectionRange);
					symbols.push(symbol);
					symbolLookup.set(mClass, symbol);
					continue;
				}

				const objectMatches = OBJECT_REGEX.exec(text);
				if (objectMatches) {
					const [_, mObj] = objectMatches;
					const symbol = new DocumentSymbol(mObj, "", SymbolKind.Object, range, selectionRange);
					symbols.push(symbol);
					symbolLookup.set(mObj, symbol);
					continue;
				}

				const enumMatches = ENUM_REGEX.exec(text);
				if (enumMatches) {
					const [_, mEnum] = enumMatches;
					symbols.push(new DocumentSymbol(mEnum, "", SymbolKind.Enum, range, selectionRange));
					continue;
				}

				const constMatches = CONST_REGEX.exec(text);
				if (constMatches) {
					const [_, mConst] = constMatches;
					symbols.push(new DocumentSymbol(mConst, "", SymbolKind.Constant, range, selectionRange));
					continue;
				}

				const localMatches = LOCAL_REGEX.exec(text);
				if (localMatches) {
					const [_, mLocal] = localMatches;
					symbols.push(new DocumentSymbol(mLocal, "", SymbolKind.Variable, range, selectionRange));
					continue;
				}
			}
			return symbols;
		}
	});

	const COLOR_REGEX = /\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/d;
	languages.registerColorProvider(LANGUAGE_SELECTOR, {
		provideColorPresentations(color, context, token) {
			const cA = (255*color.alpha).toFixed(0);
			const cR = (255*color.red).toFixed(0);
			const cG = (255*color.green).toFixed(0);
			const cB = (255*color.blue).toFixed(0);
			const presentation = new ColorPresentation(`{${cA}, ${cR}, ${cG}, ${cB}}`);
			// presentation.textEdit = new TextEdit()
			return [ presentation ];
		},
		provideDocumentColors(document, token) {
			const colors = [];

			for (let i=0; i < document.lineCount; ++i) {
				const line = document.lineAt(i);
				const text = line.text;

				const colorMatches = COLOR_REGEX.exec(text);
				if (colorMatches) {
					const [_, cA, cR, cG, cB] = colorMatches;
					const color = new Color(parseInt(cR, 10)/255, parseInt(cG, 10)/255, parseInt(cB, 10)/255, parseInt(cA, 10)/255);
					const indices = (<any> colorMatches).indices; // Ugly hack to shut up TypeScript.
					const range = new Range(i, indices[0][0], i, indices[0][1]);
					colors.push(new ColorInformation(range, color));
				}
				
			}

			return colors;
		}
	});

	const LINK_REGEX = /@?([\w_/]+\.lua)(?::(\d+))?/d;
	languages.registerDocumentLinkProvider("stingray-output", {
		provideDocumentLinks(document, token) {
			const links = [];

			for (let i=0; i < document.lineCount; ++i) {
				const line = document.lineAt(i);
				const text = line.text;

				const linkMatches = LINK_REGEX.exec(text);
				if (linkMatches) {
					const indices = (<any> linkMatches).indices;
					const range = new Range(i, indices[0][0], i, indices[0][1]);
					const line = linkMatches[2] ? parseInt(linkMatches[2], 10) : 1;
					const uri = Uri.parse(`vscode://file/d:/vt2/${linkMatches[1]}:${line}:1`);
					links.push(new DocumentLink(range, uri));
				}
			}

			return links;
		}
	});

	/*
	const SEMANTIC_TOKENS_LEGEND = {
		tokenModifiers: [],
		tokenTypes: [],
	};
	languages.registerDocumentSemanticTokensProvider(LANGUAGE_SELECTOR, {
		provideDocumentSemanticTokens(document, token,) {
			const builder = new SemanticTokensBuilder(SEMANTIC_TOKENS_LEGEND);

			for (let i=0; i < document.lineCount; ++i) {
				const line = document.lineAt(i);
				const text = line.text;
				const regionStack: number[] = [];

				if (IF_BEGIN_REGEX.test(text)) {
					regionStack.push(i);
				} else if (IF_END_REGEX.test(text)) {
					const start = <number> regionStack.pop();
					builder.push(i, pos, token.length, token.type);
				}
			}

			return builder.build();
		}
	}, SEMANTIC_TOKENS_LEGEND);
	*/
}

export function deactivate() {
	disposables.forEach((d) => d.dispose());
}