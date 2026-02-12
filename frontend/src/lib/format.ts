/**
 * Get the narrow currency symbol for a given currency code (e.g., '$', '€', '£').
 * Uses Intl.NumberFormat so it works for any valid ISO 4217 currency code.
 */
export function getCurrencySymbol(currencyCode: string): string {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currencyCode,
      currencyDisplay: 'narrowSymbol',
    }).formatToParts(0).find(p => p.type === 'currency')?.value || '$';
  } catch {
    return '$';
  }
}

/**
 * Format a number as currency with the specified currency code
 */
export function formatCurrency(amount: number, currencyCode: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Round a number to 2 decimal places (cents)
 * Uses multiply-round-divide to avoid floating point errors
 */
export function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Format a number to exactly 2 decimal places for display in inputs
 */
export function formatAmount(value: number | undefined | null): string {
  if (value === undefined || value === null || isNaN(value)) {
    return '';
  }
  return roundToCents(value).toFixed(2);
}

/**
 * Format a number to exactly 2 decimal places with comma thousands separators
 * Used for display when input is not focused
 */
export function formatAmountWithCommas(value: number | undefined | null): string {
  if (value === undefined || value === null || isNaN(value)) {
    return '';
  }
  const rounded = roundToCents(value);
  // Use Intl.NumberFormat for proper comma formatting
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rounded);
}

/**
 * Parse a string input value to a number, filtering out non-numeric characters
 * Allows: digits, decimal point, minus sign
 * Returns undefined if the result is not a valid number
 */
export function parseAmount(input: string): number | undefined {
  // Filter to only valid characters
  const filtered = input.replace(/[^0-9.-]/g, '');
  if (filtered === '' || filtered === '-' || filtered === '.') {
    return undefined;
  }
  const parsed = parseFloat(filtered);
  if (isNaN(parsed)) {
    return undefined;
  }
  return roundToCents(parsed);
}

/**
 * Filter input string to only allow valid currency input characters
 * Preserves the user's typing while removing invalid characters
 * Strips commas (they're only for display, not editing)
 */
export function filterCurrencyInput(input: string): string {
  // First strip commas, then filter to valid characters
  return input.replace(/,/g, '').replace(/[^0-9.-]/g, '');
}

/**
 * Filter input string to allow calculator expressions
 * Allows: digits, decimal point, minus, plus, multiply, divide, parentheses
 */
export function filterCalculatorInput(input: string): string {
  // Strip commas and filter to valid calculator characters
  return input.replace(/,/g, '').replace(/[^0-9.+\-*/()x×÷ ]/gi, '')
    // Normalize multiplication symbols
    .replace(/[x×]/gi, '*')
    // Normalize division symbol
    .replace(/÷/g, '/');
}

/**
 * Check if a string contains calculator operators
 */
export function hasCalculatorOperators(input: string): boolean {
  // Check for operators (excluding leading minus for negative numbers)
  const withoutLeadingMinus = input.replace(/^-/, '');
  return /[+\-*/()]/.test(withoutLeadingMinus);
}

/**
 * Recursive-descent parser for basic arithmetic expressions.
 * Supports +, -, *, /, unary minus, and parentheses.
 * Eliminates the need for new Function() / eval().
 */
class ExpressionParser {
  private pos = 0;
  private readonly expr: string;

  constructor(expr: string) {
    this.expr = expr;
  }

  parse(): number | undefined {
    try {
      const result = this.parseAddSub();
      if (this.pos < this.expr.length) return undefined;
      if (!isFinite(result)) return undefined;
      return result;
    } catch {
      return undefined;
    }
  }

  private parseAddSub(): number {
    let left = this.parseMulDiv();
    while (this.pos < this.expr.length) {
      const ch = this.expr[this.pos];
      if (ch === '+') { this.pos++; left = left + this.parseMulDiv(); }
      else if (ch === '-') { this.pos++; left = left - this.parseMulDiv(); }
      else break;
    }
    return left;
  }

  private parseMulDiv(): number {
    let left = this.parseUnary();
    while (this.pos < this.expr.length) {
      const ch = this.expr[this.pos];
      if (ch === '*') { this.pos++; left = left * this.parseUnary(); }
      else if (ch === '/') {
        this.pos++;
        const right = this.parseUnary();
        if (right === 0) throw new Error('Division by zero');
        left = left / right;
      }
      else break;
    }
    return left;
  }

  private parseUnary(): number {
    if (this.pos < this.expr.length && this.expr[this.pos] === '-') {
      this.pos++;
      return -this.parseUnary();
    }
    if (this.pos < this.expr.length && this.expr[this.pos] === '+') {
      this.pos++;
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    if (this.pos < this.expr.length && this.expr[this.pos] === '(') {
      this.pos++; // skip '('
      const result = this.parseAddSub();
      if (this.pos >= this.expr.length || this.expr[this.pos] !== ')') {
        throw new Error('Unmatched parenthesis');
      }
      this.pos++; // skip ')'
      return result;
    }
    return this.parseNumber();
  }

  private parseNumber(): number {
    const start = this.pos;
    while (this.pos < this.expr.length && (this.expr[this.pos] >= '0' && this.expr[this.pos] <= '9' || this.expr[this.pos] === '.')) {
      this.pos++;
    }
    if (this.pos === start) throw new Error('Expected number');
    return parseFloat(this.expr.substring(start, this.pos));
  }
}

/**
 * Safely evaluate a mathematical expression using a recursive-descent parser.
 * Only allows basic arithmetic: +, -, *, /, and parentheses.
 * Returns undefined if the expression is invalid.
 */
export function evaluateExpression(input: string): number | undefined {
  const cleaned = input
    .replace(/,/g, '')
    .replace(/[x×]/gi, '*')
    .replace(/÷/g, '/')
    .replace(/\s+/g, '')
    .trim();

  if (!cleaned) return undefined;

  // Validate: only allow digits, operators, decimal points, and parentheses
  if (!/^[-+]?[\d.+\-*/()]+$/.test(cleaned)) {
    return undefined;
  }

  const parser = new ExpressionParser(cleaned);
  const result = parser.parse();
  if (result === undefined) return undefined;

  return roundToCents(result);
}
