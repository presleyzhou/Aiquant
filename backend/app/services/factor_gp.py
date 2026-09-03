"""Genetic-programming factor evolution — a self-evolving miner that needs no
LLM and no API key, complementary to the Claude loop.

Grounded in the alpha-mining GP literature:
* gplearn-style symbolic regression: expression trees evolved by tournament
  selection, subtree crossover and mutation, fitness = |rank IC|;
* AutoAlpha (arXiv:2002.08245): diversity-preserving initialization and a
  redundancy penalty so the population doesn't collapse onto one idea;
* Warm-Start GP (arXiv:2412.00896): seed the population with known-good
  alphas (here: the user's factor zoo / Claude-mined factors) and mutate
  outward from them;
* AlphaEvolve (arXiv:2103.16196): parsimony pressure — simpler formulas
  survive ties, because they generalize.

Honesty rules identical to the LLM loop: fitness uses the IN-SAMPLE window
only; the holdout is touched exactly once, at the end, to confirm or reject
each hall-of-fame factor. Genomes ARE factor_dsl ASTs, so every discovered
factor is a readable expression that drops straight into the zoo.
"""

from __future__ import annotations

import random
import time
import warnings
from typing import Any, AsyncIterator

import pandas as pd

from app.services import factor_dsl
from app.services.factor_dsl import FIELDS
from app.services.factor_dsl import Node
from app.services.factor_mine import (
    MAX_COMPLEXITY,
    MAX_ZOO_CORR,
    MODES,
    UNIVERSES,
    _load_panel_blocking,
    _portfolio_from_values,
    _verdict,
    evaluate_candidate,
)

TS_UNARY = ["ts_mean", "ts_std", "ts_sum", "ts_min", "ts_max", "ts_rank", "delay", "delta"]
ELEMENT = ["sign", "abs", "log", "sqrt", "neg"]
CROSS = ["rank", "zscore"]
WINDOWS = [3, 5, 10, 20, 40, 60]
BINOPS = ["+", "-", "*", "/"]
CONSTS = [0.5, 1.0, 2.0]

PARSIMONY = 0.0015          # fitness penalty per AST node (bloat control)
REDUNDANCY_FACTOR = 0.5     # fitness multiplier when too correlated with the HOF
HOF_SIZE = 8
TRANSFORM_OPS = set(TS_UNARY) | set(CROSS) | {"ts_corr"}


# ------------------------------------------------------------ genome ops


def to_expr(node: Node) -> str:
    """Serialize an AST back to DSL text (round-trips through parse())."""
    if node.kind == "field":
        return str(node.value)
    if node.kind == "num":
        v = float(node.value)
        return str(int(v)) if v.is_integer() else f"{v:g}"
    if node.kind == "neg":
        return f"neg({to_expr(node.args[0])})"  # type: ignore[arg-type]
    if node.kind == "bin":
        left, right = node.args  # type: ignore[misc]
        return f"({to_expr(left)} {node.value} {to_expr(right)})"  # type: ignore[arg-type]
    name = str(node.value)
    parts = [to_expr(a) if isinstance(a, Node) else str(a) for a in node.args]
    return f"{name}({', '.join(parts)})"


def random_tree(rng: random.Random, depth: int, *, full: bool = False) -> Node:
    """Ramped half-and-half generator bounded by `depth`."""
    if depth <= 0 or (not full and rng.random() < 0.25):
        return Node("field", rng.choice(FIELDS))
    roll = rng.random()
    if roll < 0.35:
        return Node("call", rng.choice(TS_UNARY), (random_tree(rng, depth - 1, full=full), rng.choice(WINDOWS)))
    if roll < 0.5:
        return Node("call", rng.choice(CROSS), (random_tree(rng, depth - 1, full=full),))
    if roll < 0.62:
        return Node("call", rng.choice(ELEMENT), (random_tree(rng, depth - 1, full=full),))
    if roll < 0.74:
        return Node(
            "call",
            "ts_corr",
            (random_tree(rng, depth - 1, full=full), random_tree(rng, depth - 1, full=full), rng.choice(WINDOWS)),
        )
    right: Node = (
        Node("num", rng.choice(CONSTS)) if rng.random() < 0.15 else random_tree(rng, depth - 1, full=full)
    )
    return Node("bin", rng.choice(BINOPS), (random_tree(rng, depth - 1, full=full), right))


def _subtrees(node: Node, path: tuple[int, ...] = ()) -> list[tuple[tuple[int, ...], Node]]:
    out = [(path, node)]
    for i, a in enumerate(node.args):
        if isinstance(a, Node):
            out.extend(_subtrees(a, path + (i,)))
    return out


def _replace(node: Node, path: tuple[int, ...], new: Node) -> Node:
    if not path:
        return new
    i, rest = path[0], path[1:]
    args = list(node.args)
    args[i] = _replace(args[i], rest, new)  # type: ignore[arg-type]
    return Node(node.kind, node.value, tuple(args))


def crossover(rng: random.Random, a: Node, b: Node) -> Node:
    """Swap a random subtree of `a` for a random subtree of `b`."""
    pa, _ = rng.choice(_subtrees(a))
    _, sb = rng.choice(_subtrees(b))
    return _replace(a, pa, sb)


def mutate(rng: random.Random, node: Node) -> Node:
    """One of: subtree replacement, window jitter, operator swap, hoist."""
    subs = _subtrees(node)
    path, target = rng.choice(subs)
    roll = rng.random()
    if roll < 0.4:
        return _replace(node, path, random_tree(rng, 2))
    if roll < 0.65 and target.kind == "call" and str(target.value) in TS_UNARY + ["ts_corr"]:
        args = list(target.args)
        args[-1] = rng.choice(WINDOWS)
        return _replace(node, path, Node("call", target.value, tuple(args)))
    if roll < 0.85 and target.kind == "call":
        name = str(target.value)
        pool = TS_UNARY if name in TS_UNARY else ELEMENT if name in ELEMENT else CROSS if name in CROSS else None
        if pool:
            return _replace(node, path, Node("call", rng.choice(pool), target.args))
    # hoist: promote a random subtree to root (simplifies)
    _, hoisted = rng.choice(subs)
    return hoisted if hoisted.kind != "num" else node


def has_transform(node: Node) -> bool:
    """A discovered factor must contain at least one time-series or
    cross-sectional operator. Bare fields and raw-scale arithmetic like
    `high * volume` are size proxies, not signals — GP loves them because
    they rank well cross-sectionally, which is exactly why we exclude them."""
    if node.kind == "call" and str(node.value) in TRANSFORM_OPS:
        return True
    return any(has_transform(a) for a in node.args if isinstance(a, Node))


_IDEMPOTENT_UNARY = {"rank", "zscore", "sign", "abs"}
_IDEMPOTENT_TS = {"ts_min", "ts_max"}


def simplify(node: Node) -> Node:
    """Collapse algebraically redundant nesting GP loves to grow:
    rank(rank(x)) → rank(x), ts_min(ts_min(x,w),w) → ts_min(x,w),
    neg(neg(x)) → x, abs(abs(x)) → abs(x). Bloat that parsimony pressure
    alone punishes too slowly; this removes it outright."""
    args = tuple(simplify(a) if isinstance(a, Node) else a for a in node.args)
    node = Node(node.kind, node.value, args)
    if node.kind == "neg" and isinstance(args[0], Node) and args[0].kind == "neg":
        return args[0].args[0]  # type: ignore[return-value]
    if node.kind == "call":
        name = str(node.value)
        inner = args[0] if args and isinstance(args[0], Node) else None
        if inner is not None and inner.kind == "call" and str(inner.value) == name:
            if name in _IDEMPOTENT_UNARY:
                return inner
            if name in _IDEMPOTENT_TS and len(args) > 1 and args[1] == inner.args[1]:
                return inner
        if name == "neg" and inner is not None and inner.kind == "call" and str(inner.value) == "neg":
            return inner.args[0]  # type: ignore[return-value]
    return node


def canonical(node: Node) -> str | None:
    """Expression text if the (simplified) tree respects every DSL cap, else None."""
    try:
        text = to_expr(simplify(node))
        parsed = factor_dsl.parse(text)
    except factor_dsl.FactorError:
        return None
    if factor_dsl.complexity(parsed) > MAX_COMPLEXITY:
        return None
    return text


# ------------------------------------------------------------- evolution


def evolve_blocking(
    market: str,
    horizon: int,
    population_size: int,
    generations: int,
    mode: str,
    seeds: list[str],
    rng_seed: int | None,
    emit,
) -> dict:
    """Run the GA synchronously, calling `emit(event)` after each generation.
    Returns the final report (also emitted as the `done` event by the caller)."""
    market = market if market in UNIVERSES else "us"
    horizon = max(1, min(30, horizon))
    population_size = max(20, min(80, population_size))
    generations = max(3, min(40, generations))
    mode = mode if mode in MODES else "standard"
    min_ic, _ = MODES[mode]
    rng = random.Random(rng_seed)

    panel = _load_panel_blocking(market)
    started = time.time()
    warnings.simplefilter("ignore", RuntimeWarning)  # degenerate all-NaN slices in odd genomes

    # ---- fitness cache: identical expressions are never re-evaluated
    cache: dict[str, dict | None] = {}

    def fitness_of(expr: str, hof_values: list[pd.DataFrame]) -> tuple[float, dict | None]:
        if expr not in cache:
            try:
                cache[expr] = evaluate_candidate(expr, panel, horizon, [])
            except Exception:
                cache[expr] = None
        m = cache[expr]
        if m is None or not (abs(m["is_ic"]) >= 0):  # None or NaN
            cache[expr] = None
            return -1.0, None
        fit = abs(m["is_ic"]) - PARSIMONY * m["complexity"]
        # niching: discount ideas the hall of fame already covers
        ranked = m["_values"]
        for other in hof_values:
            pair = pd.concat([ranked.stack(), other.stack()], axis=1).dropna()
            if len(pair) > 200 and abs(float(pair.iloc[:, 0].corr(pair.iloc[:, 1]))) > MAX_ZOO_CORR:
                fit *= REDUNDANCY_FACTOR
                break
        return fit, m

    # ---- initial population: warm-start seeds (+ mutants) then ramped random
    population: list[Node] = []
    for text in seeds[:10]:
        try:
            tree = factor_dsl.parse(text)
        except factor_dsl.FactorError:
            continue
        population.append(tree)
        population.append(mutate(rng, tree))
    depth_cycle = [2, 3, 4, 3]
    guard = 0
    while len(population) < population_size and guard < population_size * 20:
        guard += 1
        tree = random_tree(rng, depth_cycle[len(population) % 4], full=rng.random() < 0.5)
        if canonical(tree):
            population.append(tree)

    hof: list[dict] = []          # {expr, metrics, fitness}
    hof_values: list[pd.DataFrame] = []
    history: list[dict] = []

    for gen in range(1, generations + 1):
        scored: list[tuple[float, Node, str, dict | None]] = []
        seen_this_gen: set[str] = set()
        for tree in population:
            tree = simplify(tree)
            text = canonical(tree)
            if not text or text in seen_this_gen:
                continue
            seen_this_gen.add(text)
            fit, m = fitness_of(text, hof_values)
            scored.append((fit, tree, text, m))
        scored.sort(key=lambda s: s[0], reverse=True)
        if not scored:
            break

        eligible = [s for s in scored if s[3] is not None and has_transform(s[1])] or scored
        best_fit, best_tree, best_text, best_m = eligible[0]
        valid = [s for s in scored if s[3] is not None]
        mean_fit = sum(s[0] for s in valid) / len(valid) if valid else 0.0

        # ---- hall of fame: strong, novel, transformed, kept small
        for fit, tree, text, m in scored[:8]:
            if m is None or abs(m["is_ic"]) < min_ic or not has_transform(tree):
                continue
            if any(h["expr"] == text for h in hof):
                continue
            novel = True
            for other in hof_values:
                pair = pd.concat([m["_values"].stack(), other.stack()], axis=1).dropna()
                if len(pair) > 200 and abs(float(pair.iloc[:, 0].corr(pair.iloc[:, 1]))) > MAX_ZOO_CORR:
                    novel = False
                    break
            if novel:
                hof.append({"expr": text, "metrics": m, "fitness": fit, "gen": gen})
                hof_values.append(m["_values"])
        hof.sort(key=lambda h: h["fitness"], reverse=True)
        del hof[HOF_SIZE:]
        hof_values = [h["metrics"]["_values"] for h in hof]

        # ---- champion portfolio stats (money, not just IC)
        champion: dict[str, Any] = {"expression": best_text, "fitness": round(best_fit, 4)}
        if best_m is not None:
            values = best_m["_values"] if best_m["is_ic"] >= 0 else -best_m["_values"]
            port = _portfolio_from_values(values, panel, market, 5, horizon)
            champion.update(
                {
                    "is_ic": best_m["is_ic"],
                    "is_icir": best_m["is_icir"],
                    "complexity": best_m["complexity"],
                    "total_return_pct": port["stats"]["total_return_pct"],
                    "cagr_pct": port["stats"]["cagr_pct"],
                    "sharpe": port["stats"]["sharpe"],
                    "max_drawdown_pct": port["stats"]["max_drawdown_pct"],
                    "bench_return_pct": port["stats"]["benchmark"]["total_return_pct"],
                }
            )
        best_abs_ic_seen = max(
            [abs(m["is_ic"]) for m in cache.values() if m is not None] or [0.0]
        )
        row = {
            "type": "gen",
            "gen": gen,
            "generations": generations,
            "best_fitness": round(best_fit, 4),
            "mean_fitness": round(mean_fit, 4),
            "unique": len(scored),
            "evaluated_total": len(cache),
            "hof_size": len(hof),
            # live hall of fame so discoveries show up as they happen
            "hof": [
                {"expression": h["expr"], "is_ic": h["metrics"]["is_ic"], "gen": h["gen"]}
                for h in hof
            ],
            "best_abs_ic": round(best_abs_ic_seen, 4),
            "min_ic": min_ic,
            "champion": champion,
            "elapsed": round(time.time() - started, 1),
        }
        history.append(row)
        emit(row)

        if gen == generations:
            break

        # ---- next generation: elitism + tournament + crossover/mutation
        elite_n = max(2, population_size // 10)
        next_pop: list[Node] = [s[1] for s in scored[:elite_n]]
        pool = [s for s in scored if s[3] is not None] or scored

        def tournament() -> Node:
            picks = [rng.choice(pool) for _ in range(3)]
            return max(picks, key=lambda s: s[0])[1]

        guard = 0
        while len(next_pop) < population_size and guard < population_size * 30:
            guard += 1
            roll = rng.random()
            if roll < 0.65:
                child = crossover(rng, tournament(), tournament())
            elif roll < 0.95:
                child = mutate(rng, tournament())
            else:
                child = random_tree(rng, 3)
            if child.depth() <= factor_dsl.MAX_DEPTH and canonical(child):
                next_pop.append(child)
        population = next_pop

    # ---- final: the holdout speaks exactly once, per hall-of-fame factor
    discovered = []
    for h in hof:
        m = h["metrics"]
        accepted, reasons = _verdict(m, mode)
        values = m["_values"] if m["is_ic"] >= 0 else -m["_values"]
        port = _portfolio_from_values(values, panel, market, 5, horizon)
        discovered.append(
            {
                "expression": h["expr"],
                "gen": h["gen"],
                "is_ic": m["is_ic"],
                "is_icir": m["is_icir"],
                "oos_ic": m["oos_ic"],
                "complexity": m["complexity"],
                "accepted": accepted,
                "reasons": reasons,
                "invert": m["is_ic"] < 0,
                "total_return_pct": port["stats"]["total_return_pct"],
                "cagr_pct": port["stats"]["cagr_pct"],
                "sharpe": port["stats"]["sharpe"],
                "max_drawdown_pct": port["stats"]["max_drawdown_pct"],
                "bench_return_pct": port["stats"]["benchmark"]["total_return_pct"],
            }
        )

    champion_curves: dict[str, Any] = {}
    if discovered:
        top = hof[0]["metrics"]
        values = top["_values"] if top["is_ic"] >= 0 else -top["_values"]
        port = _portfolio_from_values(values, panel, market, 5, horizon)
        champion_curves = {
            "equity_curve": port["equity_curve"],
            "benchmark_curve": port["benchmark_curve"],
            "drawdown_curve": port["drawdown_curve"],
        }

    return {
        "type": "done",
        "market": market,
        "horizon": horizon,
        "mode": mode,
        "min_ic": min_ic,
        "best_abs_ic": max([abs(m["is_ic"]) for m in cache.values() if m is not None] or [0.0]),
        "generations": len(history),
        "evaluated_total": len(cache),
        "elapsed": round(time.time() - started, 1),
        "discovered": discovered,
        "history": [
            {k: h[k] for k in ("gen", "best_fitness", "mean_fitness")}
            | {
                "sharpe": h["champion"].get("sharpe"),
                "is_ic": h["champion"].get("is_ic"),
                "total_return_pct": h["champion"].get("total_return_pct"),
            }
            for h in history
        ],
        **champion_curves,
    }


async def evolve_stream(
    market: str,
    horizon: int,
    population_size: int,
    generations: int,
    mode: str,
    seeds: list[str],
    rng_seed: int | None = None,
) -> AsyncIterator[dict]:
    """Bridge the synchronous GA to an NDJSON stream via a worker thread + queue."""
    import asyncio

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[dict | None] = asyncio.Queue()

    def emit(event: dict) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, event)

    def worker() -> None:
        try:
            report = evolve_blocking(
                market, horizon, population_size, generations, mode, seeds, rng_seed, emit
            )
            emit(report)
        except Exception as exc:  # surface, don't hang the stream
            emit({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
        finally:
            emit(None)  # type: ignore[arg-type]

    task = loop.run_in_executor(None, worker)
    yield {"type": "start", "market": market, "population": population_size, "generations": generations}
    while True:
        event = await queue.get()
        if event is None:
            break
        yield event
    await task
