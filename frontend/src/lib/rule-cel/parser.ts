/**
 * Text to condition tree: a hand-written recursive-descent parser, in the
 * manner of `ExpressionParser` in `lib/format.ts`. It reads only the subset of
 * CEL that maps one to one onto the tree, and refuses everything else with the
 * position of the part it does not accept.
 *
 * Grammar (the operators bind in this order, tightest first):
 *
 *   expression := or
 *   or         := and { "||" and }
 *   and        := unary { "&&" unary }
 *   unary      := "!" unary | primary
 *   primary    := "(" expression ")"
 *               | "true" | "false"
 *               | ("all" | "any") "(" expression ")"
 *               | "isEmpty" "(" field ")"
 *               | field ( cmp value | "in" list | "." method "(" args ")" )
 *   field      := "transaction" "." NAME
 *   cmp        := "==" | "!=" | "<" | "<=" | ">" | ">="
 *   method     := "contains" | "startsWith" | "matchesGlob" | "inSubtree"
 *               | "between" | "hasAny" | "hasAll" | "hasNone"
 *   value      := STRING | NUMBER | "true" | "false" | reference | "_"
 *   reference  := ("account" | "payee" | "category" | "tag") "(" STRING [ "," INTEGER ] ")"
 *               | "missing" "(" STRING ")"
 *   list       := "[" [ value { "," value } ] "]"
 *
 * `matchesGlob` is a glob (`*`), never a regular expression. There is no
 * evaluation and no arithmetic: the text only ever becomes a tree.
 */
import { EntityIndex } from '@/lib/rule-cel/catalog';
import { Cursor, failAt } from '@/lib/rule-cel/cursor';
import { tokenize, type Token } from '@/lib/rule-cel/lexer';
import { checkLimits } from '@/lib/rule-cel/limits';
import { readList, readRange, readScalar, type ValueContext } from '@/lib/rule-cel/parser-values';
import { COMPARISON_TOKENS, METHOD_NAMES } from '@/lib/rule-cel/printer';
import {
  CelSyntaxError,
  MAX_EXPRESSION_LENGTH,
  MAX_EXPRESSION_NESTING,
  celError,
  type CelError,
} from '@/lib/rule-cel/types';
import { RULE_CONDITION_FIELDS, RULE_OPERATOR_SHAPES, isRuleField } from '@/lib/rule-fields';
import { createGroup, newUid, type EditorGroup, type EditorLeaf, type EditorNode, type EditorValue } from '@/lib/rule-tree';
import type { RuleField, RuleOperator } from '@/types/transaction-rule';

export type CelParseResult =
  | { readonly ok: true; readonly root: EditorGroup }
  | { readonly ok: false; readonly error: CelError };

interface Parsed {
  readonly node: EditorNode;
  /** True for a group written as a list, `all(...)`, `true` or `!( ... )`; false for a parenthesised one. */
  readonly group: boolean;
}

const COMPARISON_OF_TOKEN = new Map<string, RuleOperator>(
  Object.entries(COMPARISON_TOKENS).map(([op, token]) => [token as string, op as RuleOperator]),
);
const OPERATOR_OF_METHOD = new Map<string, RuleOperator>(
  Object.entries(METHOD_NAMES).map(([op, name]) => [name as string, op as RuleOperator]),
);
const EXPRESSION_ENDS = new Set([')', ']', ',', '&&', '||']);

class Parser {
  private readonly cursor: Cursor;
  private readonly positions = new Map<EditorNode, number>();
  private nesting = 0;

  constructor(
    tokens: readonly Token[],
    private readonly index: EntityIndex,
  ) {
    this.cursor = new Cursor(tokens);
  }

  parse(): EditorGroup {
    let result: Parsed;
    if (this.cursor.peek().kind === 'eof') {
      result = { node: this.mark(createGroup('all'), 0), group: true };
    } else {
      result = this.parseOr();
      const rest = this.cursor.peek();
      if (rest.kind !== 'eof') throw failAt(rest, 'unexpectedToken', { token: rest.text });
    }
    // A group written out is the root; a lone condition or a parenthesised group sits inside one.
    const root =
      result.group && result.node.kind === 'group'
        ? result.node
        : this.mark(createGroup('all', [result.node]), this.at(result.node));
    checkLimits(root, (node) => this.at(node));
    return root;
  }

  private at(node: EditorNode): number {
    return this.positions.get(node) ?? 0;
  }

  private mark<T extends EditorNode>(node: T, position: number): T {
    this.positions.set(node, position);
    return node;
  }

  private group(match: 'all' | 'any', children: EditorNode[], position: number, not = false): Parsed {
    return { node: this.mark({ ...createGroup(match, children), not }, position), group: true };
  }

  private enter(at: Token): void {
    this.nesting += 1;
    if (this.nesting > MAX_EXPRESSION_NESTING) throw failAt(at, 'tooNested');
  }

  private parseOr(): Parsed {
    return this.parseList('||', 'any', () => this.parseAnd());
  }

  private parseAnd(): Parsed {
    return this.parseList('&&', 'all', () => this.parsePrimary());
  }

  private parseList(operator: string, match: 'all' | 'any', operand: () => Parsed): Parsed {
    const first = operand();
    if (!this.cursor.isPunct(operator)) return first;
    const operands = [first];
    while (this.cursor.isPunct(operator)) {
      this.cursor.next();
      operands.push(operand());
    }
    return this.group(match, operands.map((o) => o.node), this.at(first.node));
  }

  private parsePrimary(): Parsed {
    const token = this.cursor.peek();
    if (token.kind === 'punct') {
      if (token.text === '(') return this.parseParenthesised();
      if (token.text === '!') return this.parseNegation();
      throw EXPRESSION_ENDS.has(token.text) ? failAt(token, 'expectedExpression') : failAt(token, 'unsupported');
    }
    if (token.kind === 'eof') throw failAt(token, 'expectedExpression');
    if (token.kind !== 'ident') throw failAt(token, 'unsupported');
    switch (token.text) {
      case 'true':
      case 'false':
        this.cursor.next();
        return this.group(token.text === 'true' ? 'all' : 'any', [], token.start);
      case 'all':
      case 'any':
        if (this.cursor.isPunct('(', 1)) return this.parseGroupCall(token);
        break;
      case 'isEmpty':
        if (this.cursor.isPunct('(', 1)) return this.parseIsEmpty(token);
        break;
      case 'transaction':
        return this.parseCondition();
      default:
        break;
    }
    throw this.cursor.isPunct('(', 1) ? failAt(token, 'unknownFunction', { name: token.text }) : failAt(token, 'unsupported');
  }

  private parseParenthesised(): Parsed {
    this.enter(this.cursor.next());
    const inner = this.parseOr();
    this.cursor.expectPunct(')');
    this.nesting -= 1;
    return { node: inner.node, group: false };
  }

  private parseGroupCall(head: Token): Parsed {
    this.enter(head);
    this.cursor.next();
    this.cursor.next();
    const inner = this.parseOr();
    this.cursor.expectPunct(')');
    this.nesting -= 1;
    return this.group(head.text as 'all' | 'any', [inner.node], head.start);
  }

  /** `!x`: a negated group, or a condition negated inside a group of its own. */
  private parseNegation(): Parsed {
    const bang = this.cursor.next();
    this.enter(bang);
    const operand = this.parsePrimary();
    this.nesting -= 1;
    const { node } = operand;
    if (node.kind === 'group' && !node.not) {
      return { node: this.mark({ ...node, not: true }, bang.start), group: true };
    }
    // `!(x in [...])` is the operator "is none of", not a group around "is any of".
    if (node.kind === 'leaf' && node.op === 'in') {
      const spec = RULE_CONDITION_FIELDS[node.field];
      if (!spec.operators.includes('notIn')) {
        throw celError(this.at(node), 'operatorNotAllowed', { field: node.field, operator: '!(... in ...)' }, 2);
      }
      return { node: this.mark({ ...node, uid: newUid(), op: 'notIn' }, bang.start), group: false };
    }
    return this.group('all', [node], bang.start, true);
  }

  private parseIsEmpty(head: Token): Parsed {
    this.cursor.next();
    this.cursor.next();
    const field = this.readField();
    this.checkOperator(field.name, 'isEmpty', head, 'isEmpty');
    this.cursor.expectPunct(')');
    return { node: this.leaf(field.name, 'isEmpty', undefined, head.start), group: false };
  }

  private readField(): { name: RuleField; token: Token } {
    const root = this.cursor.next();
    if (root.text !== 'transaction') throw failAt(root, 'unsupported');
    this.cursor.expectPunct('.');
    const token = this.cursor.peek();
    if (token.kind !== 'ident') throw failAt(token, 'expectedField');
    this.cursor.next();
    if (!isRuleField(token.text)) throw failAt(token, 'unknownField', { name: token.text });
    return { name: token.text, token };
  }

  private checkOperator(field: RuleField, op: RuleOperator, at: Token, shown: string): void {
    if (!RULE_CONDITION_FIELDS[field].operators.includes(op)) {
      throw failAt(at, 'operatorNotAllowed', { field, operator: shown });
    }
  }

  private leaf(field: RuleField, op: RuleOperator, value: EditorLeaf['value'], position: number): EditorLeaf {
    return this.mark({ kind: 'leaf', uid: newUid(), field, op, value }, position);
  }

  /** `transaction.field` followed by a comparison, `in`, or a method call. */
  private parseCondition(): Parsed {
    const start = this.cursor.peek().start;
    const { name: field } = this.readField();
    const ctx: ValueContext = { field, index: this.index };
    const token = this.cursor.peek();
    const comparison = token.kind === 'punct' ? COMPARISON_OF_TOKEN.get(token.text) : undefined;
    if (comparison) {
      this.cursor.next();
      this.checkOperator(field, comparison, token, token.text);
      return { node: this.leaf(field, comparison, readScalar(this.cursor, ctx, true), start), group: false };
    }
    if (token.kind === 'ident' && token.text === 'in') {
      this.cursor.next();
      this.checkOperator(field, 'in', token, 'in');
      return { node: this.leaf(field, 'in', readList(this.cursor, ctx), start), group: false };
    }
    if (token.kind === 'punct' && token.text === '.') return this.parseMethod(field, ctx, start);
    throw failAt(token, 'expectedOperator');
  }

  private parseMethod(field: RuleField, ctx: ValueContext, start: number): Parsed {
    this.cursor.next();
    const name = this.cursor.peek();
    if (name.kind !== 'ident') throw failAt(name, 'expectedField');
    this.cursor.next();
    const op = OPERATOR_OF_METHOD.get(name.text);
    if (!op) throw failAt(name, 'unknownFunction', { name: name.text });
    this.checkOperator(field, op, name, name.text);
    this.cursor.expectPunct('(');
    const shape = RULE_OPERATOR_SHAPES[op];
    const value =
      shape === 'list' ? readList(this.cursor, ctx) : shape === 'range' ? (readRange(this.cursor, ctx) as EditorValue) : readScalar(this.cursor, ctx, true);
    this.cursor.expectPunct(')');
    return { node: this.leaf(field, op, value, start), group: false };
  }
}

/**
 * Reads an expression into the condition tree the editor holds. Never throws:
 * a text outside the subset comes back as an error with its position.
 */
export function parseCondition(text: string, index: EntityIndex = new EntityIndex()): CelParseResult {
  if (text.length > MAX_EXPRESSION_LENGTH) {
    return { ok: false, error: { position: MAX_EXPRESSION_LENGTH, length: 1, key: 'tooLong', args: { max: MAX_EXPRESSION_LENGTH } } };
  }
  try {
    return { ok: true, root: new Parser(tokenize(text), index).parse() };
  } catch (error) {
    if (error instanceof CelSyntaxError) return { ok: false, error: error.error };
    throw error;
  }
}
