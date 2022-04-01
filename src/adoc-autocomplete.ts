import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getActiveToolchain } from './extension';
import { formatCommand } from './utils/vscode';

type AdocType = "namespace" | "function" | "constant" | "object" | "enumeration" | "enumerator";

/** Signature of a function. */
type AdocSignature = {
	types: string[];
	rets: string[];
	args: string[];
};

type AdocValue = {
	// Properties present in the lua_api_stingray3d file.
	type: AdocType;
	desc: string;
	signatures: AdocSignature[];
	members: { [name: string]: AdocValue };
	// Properties added in this file.
	label: string;
	kind: string;
};

const adocToCompletionKind: { [key: string]: string } = {
	namespace: 'Module',
	function: 'Function',
	constant: 'Field',
	object: 'Class',
	enumeration: 'Enum',
	enumerator: 'Value'
};

const identifierLegalCharacters = /[a-zA-Z._0-9]/;


class AdocCompletionFeatures implements
		vscode.CompletionItemProvider,
		vscode.HoverProvider,
		vscode.SignatureHelpProvider {

	private content: AdocValue;

	constructor(adocFile: string) {
		if (!fs.existsSync(adocFile)) {
			throw new Error(`Adoc file doesn't exist at path: ${adocFile}`);
		}

		const buffer = fs.readFileSync(adocFile, 'utf8');
		this.content = JSON.parse(buffer);
	}

	getExactMatch(tokens: string[], fuzzyNs: string = 'stingray') : AdocValue | undefined {
		const adocContent = this._getAdoc(tokens);
		if (!adocContent && fuzzyNs) {
			return this._getAdoc([fuzzyNs].concat(tokens));
		}

		return adocContent;
	}

	getPossibleCompletions(tokens: string[]): AdocValue[] {
		const completions = this._getPossibleCompletions(tokens);
		if (completions.length === 0 && tokens.length > 0 && tokens[0] !== 'stingray') {
			return this._getPossibleCompletions(['stingray'].concat(tokens));
		}
		return completions;
	}

	_getPossibleCompletions(tokens: string[]): AdocValue[] {
		const completions = [];
		const completeTokens = tokens.slice(0, -1);
		const lastToken = tokens[tokens.length - 1];
		const currentAdoc = completeTokens.length > 0 ? this._getAdoc(completeTokens) : this.content;
		if (currentAdoc && currentAdoc.members) {
			for (const [key, adocValue] of Object.entries(currentAdoc.members)) {
				if (key.startsWith(lastToken)) {
					// Best matching of the last token:
					completions.push(Object.assign({label: key}, adocValue));
				}
			}
		}

		return completions;
	}

	_getAdoc(tokens: string[]) : AdocValue | undefined {
		if (tokens.length === 0) {
			return;
		}

		let currentAdoc = this.content;
		for (const token of tokens) {
			currentAdoc = currentAdoc.members?.[token];
			if (!currentAdoc) {
				return;
			}
		}
		return currentAdoc;
	}

	private getExpression(text: string, pos: number, fixedEndPos: boolean) : string {
		// Start at the aucompletion position, and go back until we find a character
		// that is NOT part of the identifier chains (a word boundary, an operator symbol)
		let startPos = pos;
		while (startPos >= 0) {
			if (!text.charAt(startPos).match(identifierLegalCharacters)) {
				startPos++;
				break;
			}
			--startPos;
		}

		let endPos = pos;
		if (!fixedEndPos) {
			while (endPos < text.length) {
				if (!text.charAt(endPos).match(/[\w_]/)) {
					--endPos;
					break;
				}
				++endPos;
			}
		}

		return text.substring(startPos, 1+endPos);
	}

	private getExpressionOfInterest(document: vscode.TextDocument, position: vscode.Position, fixedPosition: boolean, startPos : number = -1) : string {
		const line = document.lineAt(position.line);
		const lineText = line.text;
		startPos = startPos === -1 ? position.character - 1 : startPos;

		return this.getExpression(lineText, startPos, fixedPosition);
	}

	private getFunctionExpression(document: vscode.TextDocument, position: vscode.Position): [string,number] {
		const { text } = document.lineAt(position.line);
		let startPos = position.character - 1;
		let nbClosingParens = 0;
		let commaCount = 0;

		while (startPos >= 0) {
			const char = text[startPos];
			if (char === ')' || char === '}') {
				nbClosingParens++;
			} else if (char === '(' || char === '{') {
				nbClosingParens--;
				if (nbClosingParens < 0) {
					// Position ourselves on the previous non ( character
					--startPos;
					break;
				}
			} else if (char === ',' && nbClosingParens === 0) {
				++commaCount;
			}
			--startPos;
		}

		let endPos = startPos;
		while (startPos >= 0) {
			if (!text[startPos].match(identifierLegalCharacters)) {
				startPos++;
				break;
			}
			--startPos;
		}

		if (endPos === startPos || startPos >= endPos || startPos < 0) {
			return [ '', -1 ];
		}

		return [ text.substring(startPos, 1+endPos), commaCount ];
	}

	private functionToString(name: string, signature: AdocSignature) {
		const args = signature.args.map((arg, i) => {
			return `${arg} : ${signature.types[i]}`;
		}).join(', ');
		const rets = signature.rets ? ` : ${signature.rets.join('|')}` : '';
		return `${name}(${args})${rets}`;
	}

	provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CompletionItem[]> {
		const expression = this.getExpressionOfInterest(document, position, true);
		const tokens = expression.split('.');
		const possibleCompletions = this.getPossibleCompletions(tokens);
		if (possibleCompletions.length === 0) {
			return;
		}

		return possibleCompletions.map((completion: AdocValue) => {
				const item = new vscode.CompletionItem(completion.label);
				const kind = adocToCompletionKind[completion.type];
				if (kind) {
					item.kind = (vscode.CompletionItemKind as any)[kind];
					item.detail = `(${completion.type})`;
				}
				if (completion.desc) {
					item.documentation = completion.desc;
				}
				return item;
			});
	}

	provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
		const expression = this.getExpressionOfInterest(document, position, false);
		const tokens = expression.split('.');
		const info = this.getExactMatch(tokens);
		if (!info) {
			return;
		}

		const mdString = new vscode.MarkdownString();
		if (info.type === 'function') {
			for (let signature of info.signatures) {
				mdString.appendCodeblock(this.functionToString(expression, signature));
				if (signature.args.length > 0) {
					mdString.appendMarkdown(`\n\n` + signature.args.map((arg) => `_@param_ \`${arg}\``).join('\n\n'));
				}
				mdString.appendMarkdown('\n\n---\n\n');
			}
			mdString.appendMarkdown(info.desc);
		} else { // if (info.type === 'namespace' || info.type === 'object')
			mdString.appendCodeblock(`--[[ ${info.type} ]] ${expression} = {…}`);
			if (info.desc) {
				mdString.appendMarkdown('\n\n---\n\n' + info.desc);
			}
		}

		const dotIndex = expression.indexOf(".");
		if (dotIndex > -1) {
			const object = expression.substring(0, dotIndex);
			const method = expression.substring(dotIndex+1);
			const command = formatCommand("fatshark-code-assist._openDocumentation", { object, method });
			mdString.appendMarkdown(`\n\n\n[$(link-external) Open local documentation](${command})`);
			mdString.supportThemeIcons = true;
			mdString.isTrusted = true;
		}

		return new vscode.Hover(mdString);
	}

	provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.SignatureHelp> {
		const [ expression, commaCount ] = this.getFunctionExpression(document, position);
		const tokens = expression.split('.');
		const info = this.getExactMatch(tokens);
		if (info?.type !== 'function') {
			return;
		}

		const help = new vscode.SignatureHelp();
		help.signatures = info.signatures.map((signature: AdocSignature) => {
			const label = this.functionToString(tokens[tokens.length - 1], signature);
			const sig = new vscode.SignatureInformation(label, info.desc);
			sig.parameters = signature.args.map((arg, i) => {
				return new vscode.ParameterInformation(`${arg} : ${signature.types[i]}`);
			});
			return sig;
		});
		help.activeParameter = commaCount;

		return help;
	}
}

export function activate(context: vscode.ExtensionContext) {
	const toolchain = getActiveToolchain();
	if (!toolchain) {
		return;
	}
	const apiDoc = path.join(toolchain.path, 'tools_external', 'lua_api_stingray3d.json');
	if (!fs.existsSync(apiDoc)) {
		return;
	}

	const selector = 'lua';
	const adocCompletionFeatures = new AdocCompletionFeatures(apiDoc);

	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider(selector, adocCompletionFeatures, '.', '\"')
	);

	context.subscriptions.push(
		vscode.languages.registerHoverProvider(selector, adocCompletionFeatures)
	);

	context.subscriptions.push(
		vscode.languages.registerSignatureHelpProvider(selector, adocCompletionFeatures, ',', '(')
	);
}