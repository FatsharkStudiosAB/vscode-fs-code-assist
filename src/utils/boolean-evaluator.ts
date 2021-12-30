
export class BooleanEvaluator {
	static binaryOperators: any = {
		'or': { prec: 1, func: (a: boolean, b: boolean) => a || b },
		'and': { prec: 2, func: (a: boolean, b: boolean) => a && b },
	};
	static unaryOperators: any = {
		'not': { prec: 3, func: (a: boolean) => !a },
	};

	private tokens: string[] = [];
	public error?: any;
	constructor(
		private symbols: { [symbol: string]: boolean; } = {}
	) { }

	eval(text: string): boolean | null {
		try {
			this.tokens = [...text.matchAll(/\w+|[()]/g)].flat();
			return this._expr(0);
		} catch (err) {
			this.error = err;
			return null;
		}
	};

	_atom(): boolean {
		const tok = this.tokens.shift();
		if (tok === '(') {
			const val = this._expr(0);
			const close = this.tokens.shift();
			if (close !== ')') {
				throw new Error(`')' expected near '${close || '<eol>'}'`);
			}
			return val;
		} else if (!tok || BooleanEvaluator.binaryOperators[tok]) {
			throw new Error(`unexpected symbol near '${tok || '<eol>'}'`);
		} else if (tok) {
			const op = BooleanEvaluator.unaryOperators[tok];
			return op.func(this._expr(op.prec));
		} else {
			return !!(this.symbols[tok]);
		}
	}

	_expr(limit: number): boolean {
		let lhs = this._atom();
		while (true) {
			const op = BooleanEvaluator.binaryOperators[this.tokens[0]];
			const prec = op?.prec || -1;
			if (prec < limit) {
				break;
			}
			this.tokens.shift();
			lhs = op.func(lhs, this._expr(prec + 1));
		}
		return lhs;
	}
}
