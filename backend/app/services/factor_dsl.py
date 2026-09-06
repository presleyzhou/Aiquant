"""A small, safe expression language for formulaic alpha factors.

WorldQuant-Alpha101-style operators over an OHLCV panel. Expressions arrive
from an LLM, so nothing here ever calls eval(): a hand-rolled tokenizer and
recursive-descent parser produce an AST that is interpreted against pandas
frames, with hard caps on length, depth and window sizes.

Panel convention: every field/derived value is a DataFrame indexed by date
with one column per symbol. Time-series operators (`ts_*`, delay, delta) act
down the index; cross-sectional operators (rank, zscore) act across columns.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np
import pandas as pd

MAX_LEN = 240
MAX_DEPTH = 10
MAX_WINDOW = 120

FIELDS = ("open", "high", "low", "close", "volume", "returns", "vwap")

# name -> (arity, needs_window_positions)  — windows are validated as ints.
_TS_UNARY = {"ts_mean", "ts_std", "ts_sum", "ts_min", "ts_max", "ts_rank", "delay", "delta"}
_TS_BINARY = {"ts_corr"}
_ELEMENT = {"sign", "abs", "log", "sqrt", "neg"}
_CROSS = {"rank", "zscore"}

OPERATOR_DOC = """Fields: open, high, low, close, volume, returns (1-day pct change), vwap.
Time-series ops (window d = int bars, 1-120): ts_mean(x,d), ts_std(x,d), ts_sum(x,d),
ts_min(x,d), ts_max(x,d), ts_rank(x,d) (rank of today within trailing window, 0-1),
delay(x,d) (value d bars ago), delta(x,d) (x - delay(x,d)), ts_corr(x,y,d).
Cross-sectional ops: rank(x) (percentile across symbols, 0-1), zscore(x).
Elementwise: sign(x), abs(x), log(x) (log of |x|+1e-9, sign preserved), sqrt(|x|), neg(x).
Arithmetic: + - * / and numeric literals; division is NaN-safe.
Example: neg(ts_corr(rank(delta(log(volume), 1)), rank((close - open) / open), 6))"""


class FactorError(ValueError):
    """Anything wrong with an expression: syntax, unknown name, bad window."""


# ------------------------------------------------------------------ tokens

_TOKEN_RE = re.compile(
    r"\s*(?:(?P<num>\d+\.\d*|\.\d+|\d+)|(?P<name>[A-Za-z_][A-Za-z_0-9]*)|(?P<op>[()+\-*/,]))"
)


def _tokenize(text: str) -> list[tuple[str, str]]:
    tokens, pos = [], 0
    while pos < len(text):
        m = _TOKEN_RE.match(text, pos)
        if not m or m.end() == pos:
            raise FactorError(f"unexpected character at position {pos}: {text[pos:pos + 10]!r}")
        if m.group("num"):
            tokens.append(("num", m.group("num")))
        elif m.group("name"):
            tokens.append(("name", m.group("name")))
        else:
            tokens.append(("op", m.group("op")))
        pos = m.end()
    return tokens


# --------------------------------------------------------------------- AST


@dataclass
class Node:
    kind: str  # "field" | "num" | "call" | "bin" | "neg"
    value: str | float = ""
    args: tuple[Node | int, ...] = ()

    def depth(self) -> int:
        child = [a.depth() for a in self.args if isinstance(a, Node)]
        return 1 + (max(child) if child else 0)


class _Parser:
    def __init__(self, tokens: list[tuple[str, str]]):
        self.tokens = tokens
        self.i = 0

    def peek(self) -> tuple[str, str] | None:
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def take(self) -> tuple[str, str]:
        tok = self.peek()
        if tok is None:
            raise FactorError("unexpected end of expression")
        self.i += 1
        return tok

    def expect(self, op: str) -> None:
        tok = self.take()
        if tok != ("op", op):
            raise FactorError(f"expected {op!r}, got {tok[1]!r}")

    # expr := term (("+"|"-") term)*
    def expr(self) -> Node:
        node = self.term()
        while self.peek() in (("op", "+"), ("op", "-")):
            op = self.take()[1]
            node = Node("bin", op, (node, self.term()))
        return node

    # term := factor (("*"|"/") factor)*
    def term(self) -> Node:
        node = self.factor()
        while self.peek() in (("op", "*"), ("op", "/")):
            op = self.take()[1]
            node = Node("bin", op, (node, self.factor()))
        return node

    # factor := "-" factor | num | name | name "(" args ")" | "(" expr ")"
    def factor(self) -> Node:
        kind, text = self.take()
        if (kind, text) == ("op", "-"):
            return Node("neg", args=(self.factor(),))
        if (kind, text) == ("op", "("):
            node = self.expr()
            self.expect(")")
            return node
        if kind == "num":
            return Node("num", float(text))
        if kind == "name":
            if self.peek() == ("op", "("):
                return self.call(text)
            if text not in FIELDS:
                raise FactorError(f"unknown field {text!r}; fields: {', '.join(FIELDS)}")
            return Node("field", text)
        raise FactorError(f"unexpected token {text!r}")

    def call(self, name: str) -> Node:
        self.expect("(")
        args: list[Node] = [self.expr()]
        while self.peek() == ("op", ","):
            self.take()
            args.append(self.expr())
        self.expect(")")

        def window(node: Node, pos: int) -> int:
            if node.kind != "num" or not float(node.value).is_integer():
                raise FactorError(f"{name}: argument {pos} must be an integer window")
            w = int(node.value)
            if not 1 <= w <= MAX_WINDOW:
                raise FactorError(f"{name}: window must be 1-{MAX_WINDOW}, got {w}")
            return w

        if name in _TS_UNARY:
            if len(args) != 2:
                raise FactorError(f"{name} takes (x, window)")
            return Node("call", name, (args[0], window(args[1], 2)))
        if name in _TS_BINARY:
            if len(args) != 3:
                raise FactorError(f"{name} takes (x, y, window)")
            return Node("call", name, (args[0], args[1], window(args[2], 3)))
        if name in _ELEMENT or name in _CROSS:
            if len(args) != 1:
                raise FactorError(f"{name} takes exactly one argument")
            return Node("call", name, (args[0],))
        raise FactorError(f"unknown function {name!r}")


def parse(expression: str) -> Node:
    expression = expression.strip()
    if not expression:
        raise FactorError("empty expression")
    if len(expression) > MAX_LEN:
        raise FactorError(f"expression longer than {MAX_LEN} characters")
    parser = _Parser(_tokenize(expression))
    node = parser.expr()
    if parser.peek() is not None:
        raise FactorError(f"trailing tokens from {parser.peek()[1]!r}")
    if node.depth() > MAX_DEPTH:
        raise FactorError(f"expression deeper than {MAX_DEPTH} levels")
    if node.kind in ("num",):
        raise FactorError("expression is a constant")
    return node


def complexity(node: Node) -> int:
    """Node count — the regularizer that keeps factors human-readable."""
    return 1 + sum(complexity(a) for a in node.args if isinstance(a, Node))


# ------------------------------------------------------------------- eval


def evaluate(node: Node, panel: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Interpret an AST against the panel. Returns a date × symbol frame."""
    if node.kind == "field":
        return panel[str(node.value)]
    if node.kind == "num":
        template = next(iter(panel.values()))
        return pd.DataFrame(float(node.value), index=template.index, columns=template.columns)
    if node.kind == "neg":
        return -evaluate(node.args[0], panel)  # type: ignore[arg-type]

    if node.kind == "bin":
        left = evaluate(node.args[0], panel)  # type: ignore[arg-type]
        right = evaluate(node.args[1], panel)  # type: ignore[arg-type]
        op = str(node.value)
        if op == "+":
            return left + right
        if op == "-":
            return left - right
        if op == "*":
            return left * right
        return left / right.replace(0, np.nan)

    name = str(node.value)
    x = evaluate(node.args[0], panel)  # type: ignore[arg-type]

    if name in _TS_UNARY:
        d = int(node.args[1])  # type: ignore[arg-type]
        if name == "ts_mean":
            return x.rolling(d).mean()
        if name == "ts_std":
            return x.rolling(d).std()
        if name == "ts_sum":
            return x.rolling(d).sum()
        if name == "ts_min":
            return x.rolling(d).min()
        if name == "ts_max":
            return x.rolling(d).max()
        if name == "ts_rank":
            return x.rolling(d).rank(pct=True)
        if name == "delay":
            return x.shift(d)
        if name == "delta":
            return x - x.shift(d)

    if name == "ts_corr":
        y = evaluate(node.args[1], panel)  # type: ignore[arg-type]
        d = int(node.args[2])  # type: ignore[arg-type]
        return x.rolling(d).corr(y)

    if name == "rank":
        return x.rank(axis=1, pct=True)
    if name == "zscore":
        mean = x.mean(axis=1)
        std = x.std(axis=1).replace(0, np.nan)
        return x.sub(mean, axis=0).div(std, axis=0)
    if name == "sign":
        return np.sign(x)
    if name == "abs":
        return x.abs()
    if name == "log":
        return np.sign(x) * np.log(x.abs() + 1e-9)
    if name == "sqrt":
        return np.sqrt(x.abs())
    if name == "neg":
        return -x

    raise FactorError(f"unhandled node {name!r}")  # unreachable if parse() ran


def compute(expression: str, panel: dict[str, pd.DataFrame]) -> tuple[pd.DataFrame, Node]:
    """Parse + evaluate; replaces inf with NaN so metrics stay finite."""
    node = parse(expression)
    values = evaluate(node, panel)
    if not isinstance(values, pd.DataFrame) or values.dropna(how="all").empty:
        raise FactorError("expression produced no usable values")
    values = values.replace([np.inf, -np.inf], np.nan)
    spread = float(values.std().sum())
    # NaN spread (all-NaN columns) is as useless as zero spread — both mean
    # the expression carries no cross-sectional information.
    if not (spread > 1e-12):
        raise FactorError("expression is constant (or undefined) across the panel")
    return values, node
