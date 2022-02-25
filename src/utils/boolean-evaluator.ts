/**
 * A boolean algebra evaluator implemented via precedence climbing.
 * https://en.wikipedia.org/wiki/Operator-precedence_parser#Precedence_climbing_method
 */
export class BooleanEvaluator {
	/**
	 * Create a new boolean evaluator with the given symbol values.
	 * @param symbols A map that assigns boolean values to symbol names.
	 */
	constructor(
		private symbols: { [symbol: string]: boolean; } = {}
	) { }

	/**
	 * Evaluate a boolean expression in the context of this evaluator.
	 * @param text An expression to evaluate.
	 * @returns The result of evaluating the expression, or null if an error ocurred.
	 */
	eval(text: string): boolean | null {
		try {
			this.tokens = [...text.matchAll(/\w+|[()]/g)].flat();
			return this._expr(0);
		} catch (err: any) {
			this.error = err;
			return null;
		}
	};

	/**
	 * The error object from the last evaluation that failed.
	 */
	public error?: Error;
	private tokens: string[] = [];

	private static binaryOperators: any = {
		'or': { prec: 1, func: (a: boolean, b: boolean) => a || b },
		'and': { prec: 2, func: (a: boolean, b: boolean) => a && b },
	};
	private static unaryOperators: any = {
		'not': { prec: 3, func: (a: boolean) => !a },
	};

	_atom(): boolean {
		const tok = this.tokens.shift();
		if (tok === '(') {
			const val = this._expr(0);
			const close = this.tokens.shift();
			if (close !== ')') {
				throw new EvalError(`')' expected near '${close || '<eol>'}'`);
			}
			return val;
		} else if (!tok || BooleanEvaluator.binaryOperators[tok]) {
			throw new EvalError(`unexpected symbol near '${tok || '<eol>'}'`);
		} else if (BooleanEvaluator.unaryOperators[tok]) {
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
