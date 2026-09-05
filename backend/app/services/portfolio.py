"""Portfolio construction and risk analytics — the layer between a
cross-sectional signal and money.

Everything here is deterministic numpy/pandas with no external optimizer:
the universe is at most a few dozen names, so projected gradient descent on
a shrunk covariance is plenty for minimum variance, and the classic
fixed-point iteration converges for risk parity. All schemes are long-only
with an optional per-name cap; when the cap makes full investment infeasible
(cap * n < 1) the remainder is held as cash, never silently violated.

Weighting schemes (`SCHEMES`):
  equal        — 1/n across the selected names
  score        — rank-linear in the signal (best name gets the most)
  inverse_vol  — proportional to 1 / trailing volatility
  min_variance — argmin w'Σw  s.t. sum(w)=1, 0 <= w <= cap
  risk_parity  — every name contributes the same share of portfolio variance
  hrp          — Hierarchical Risk Parity (López de Prado 2016): cluster the
                 correlation matrix, then split risk top-down between clusters
  mean_variance— Grinold-Kahn: alpha_i = IC · sigma_i · z_i, maximise
                 alpha'w − lambda·w'Σw over the capped simplex
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

SCHEMES: tuple[str, ...] = ("equal", "score", "inverse_vol", "min_variance", "risk_parity", "hrp", "mean_variance")

COV_SHRINKAGE = 0.3        # fallback intensity when the analytic estimate is unusable
REF_IC = 0.02              # Grinold alpha at this IC balances the mean-variance trade-off
_EPS = 1e-12


def shrinkage_intensity(returns: np.ndarray) -> float:
    """Analytic optimal intensity for shrinking the sample covariance toward
    its diagonal (Ledoit & Wolf 2003/2004; the closed form is the
    Schäfer-Strimmer 2005 estimator):

        lambda* = sum_{i!=j} Var(s_ij) / sum_{i!=j} s_ij^2,  clipped to [0, 1]

    where Var(s_ij) is the sampling variance of each off-diagonal covariance.
    Short windows and many names push lambda toward 1 (trust the diagonal);
    long, stable windows let the sample correlations through."""
    r = np.nan_to_num(np.asarray(returns, dtype=float))
    t, n = r.shape
    if t < 4 or n < 2:
        return 1.0
    x = r - r.mean(axis=0)
    s = x.T @ x / (t - 1)
    # Var(s_ij) ≈ (t / (t-1)^3) * sum_k (x_ki x_kj - mean)^2  (Schäfer & Strimmer eq. 12)
    w = np.einsum("ki,kj->kij", x, x)
    var_s = w.var(axis=0, ddof=0) * t / (t - 1) ** 2
    off = ~np.eye(n, dtype=bool)
    denom = float((s[off] ** 2).sum())
    if denom <= _EPS:
        return 1.0
    lam = float(var_s[off].sum() / denom)
    return min(1.0, max(0.0, lam)) if np.isfinite(lam) else COV_SHRINKAGE


# ----------------------------------------------------------------- helpers


def shrink_cov(returns: np.ndarray) -> np.ndarray:
    """Sample covariance shrunk toward its own diagonal with the analytic
    Ledoit-Wolf intensity (see `shrinkage_intensity`). `returns` is
    (window, n); NaNs are treated as zero returns, which only ever
    *under*states risk for illiquid names."""
    r = np.nan_to_num(np.asarray(returns, dtype=float))
    if r.shape[0] < 2:
        return np.eye(r.shape[1]) * 1e-4
    sample = np.cov(r, rowvar=False, ddof=1)
    sample = np.atleast_2d(sample)
    diag = np.diag(np.diag(sample))
    lam = shrinkage_intensity(r)
    cov = (1 - lam) * sample + lam * diag
    # a floor keeps zero-variance columns from producing singular matrices
    return cov + np.eye(cov.shape[0]) * 1e-8


def apply_cap(weights: np.ndarray, cap: float) -> np.ndarray:
    """Water-fill: clip at `cap`, push the excess onto uncapped names
    proportionally, repeat. If every name hits the cap the sum falls short
    of 1 — the shortfall is cash."""
    w = np.clip(np.asarray(weights, dtype=float), 0, None)
    total = w.sum()
    if total <= _EPS:
        return np.zeros_like(w)
    w = w / total
    n = len(w)
    if cap * n < 1 - 1e-9:
        return np.full(n, cap)
    for _ in range(n + 1):
        over = w > cap + 1e-12
        if not over.any():
            break
        excess = (w[over] - cap).sum()
        w[over] = cap
        free = ~over
        free_total = w[free].sum()
        if free_total <= _EPS:
            break
        w[free] += excess * w[free] / free_total
    return np.minimum(w, cap)


def project_capped_simplex(v: np.ndarray, cap: float) -> np.ndarray:
    """Euclidean projection onto {w : sum w = 1, 0 <= w <= cap} by bisection
    on the shift tau (feasible iff cap * n >= 1)."""
    v = np.asarray(v, dtype=float)
    n = len(v)
    if cap * n < 1 - 1e-9:
        return np.full(n, cap)
    lo, hi = v.min() - 1.0, v.max()
    for _ in range(48):  # interval shrinks 2^-48 ≈ 4e-15 — machine precision
        tau = (lo + hi) / 2
        s = np.clip(v - tau, 0, cap).sum()
        if s > 1:
            lo = tau
        else:
            hi = tau
    return np.clip(v - (lo + hi) / 2, 0, cap)


# ----------------------------------------------------------------- schemes


def equal_weights(n: int, cap: float) -> np.ndarray:
    return apply_cap(np.ones(n), cap)


def score_weights(scores: np.ndarray, cap: float) -> np.ndarray:
    """Rank-linear: the best name gets weight ∝ n, the worst ∝ 1."""
    order = np.argsort(np.argsort(np.asarray(scores, dtype=float)))  # 0 = worst
    return apply_cap(order + 1.0, cap)


def inverse_vol_weights(returns: np.ndarray, cap: float) -> np.ndarray:
    r = np.asarray(returns, dtype=float)
    vol = np.nanstd(r, axis=0, ddof=1)
    vol = np.where(np.isfinite(vol) & (vol > 1e-6), vol, np.nanmedian(vol) if np.isfinite(np.nanmedian(vol)) else 1.0)
    return apply_cap(1.0 / vol, cap)


def _accelerated_pgd(grad_fn, w0: np.ndarray, cap: float, lipschitz: float, iters: int, tol: float = 1e-8) -> np.ndarray:
    """FISTA (Beck & Teboulle 2009): projected gradient with Nesterov momentum
    over the capped simplex — an order of magnitude fewer iterations than
    plain projected gradient on these ill-conditioned covariances."""
    step = 1.0 / max(lipschitz, 1e-12)
    w = y = w0
    t = 1.0
    for _ in range(iters):
        nxt = project_capped_simplex(y - step * grad_fn(y), cap)
        t_next = (1 + math.sqrt(1 + 4 * t * t)) / 2
        y = nxt + (t - 1) / t_next * (nxt - w)
        if np.abs(nxt - w).max() < tol:
            return nxt
        w, t = nxt, t_next
    return w


def min_variance_weights(cov: np.ndarray, cap: float, iters: int = 300) -> np.ndarray:
    """min w'Σw over the capped simplex by accelerated projected gradient."""
    n = cov.shape[0]
    w0 = project_capped_simplex(np.full(n, 1.0 / n), cap)
    lipschitz = 2 * max(float(np.linalg.eigvalsh(cov).max()), 1e-10)
    return _accelerated_pgd(lambda w: 2 * cov @ w, w0, cap, lipschitz, iters)


def risk_parity_weights(cov: np.ndarray, cap: float, iters: int = 500) -> np.ndarray:
    """Equal risk contribution via the fixed point w_i ∝ 1 / (Σw)_i, then
    the cap is enforced by water-filling (an exact ERC under caps is a
    constrained problem; the capped names simply contribute a bit more)."""
    n = cov.shape[0]
    w = np.full(n, 1.0 / n)
    for _ in range(iters):
        marginal = cov @ w
        marginal = np.where(marginal > 1e-12, marginal, 1e-12)
        nxt = 1.0 / marginal
        nxt = nxt / nxt.sum()
        nxt = 0.5 * w + 0.5 * nxt  # damping
        if np.abs(nxt - w).max() < 1e-10:
            w = nxt
            break
        w = nxt
    return apply_cap(w, cap)


def _single_linkage_order(corr: np.ndarray) -> list[int]:
    """Quasi-diagonalisation order from single-linkage clustering on the
    correlation-distance matrix d_ij = sqrt((1 - rho_ij) / 2). Pure numpy —
    n is tiny, so the O(n^3) agglomeration is instant."""
    n = corr.shape[0]
    if n <= 2:
        return list(range(n))
    dist = np.sqrt(np.clip((1 - corr) / 2, 0, 1))
    clusters: dict[int, list[int]] = {i: [i] for i in range(n)}
    d = dist.copy()
    np.fill_diagonal(d, np.inf)
    ids = list(range(n))
    while len(ids) > 1:
        sub = d[np.ix_(ids, ids)]
        k = int(np.argmin(sub))
        a, b = ids[k // len(ids)], ids[k % len(ids)]
        if a == b:
            break
        merged = clusters[a] + clusters[b]
        new_id = max(clusters) + 1
        clusters[new_id] = merged
        # single linkage: distance to the merged cluster = min of the parts
        row = np.minimum(d[a], d[b])
        d = np.pad(d, ((0, 1), (0, 1)), constant_values=np.inf)
        d[new_id, :-1] = row
        d[:-1, new_id] = row
        d[new_id, new_id] = np.inf
        ids = [i for i in ids if i not in (a, b)] + [new_id]
    return clusters[ids[0]]


def hrp_weights(cov: np.ndarray, cap: float) -> np.ndarray:
    """Hierarchical Risk Parity (López de Prado 2016, J. Portfolio Mgmt):
    order names by hierarchical clustering, then recursively bisect the
    ordered list, splitting each parent's weight between its two halves
    inversely to the halves' inverse-variance-portfolio variances. Needs no
    matrix inversion, so it stays stable when the covariance is ill-conditioned."""
    n = cov.shape[0]
    if n == 1:
        return np.array([min(1.0, cap)])
    std = np.sqrt(np.clip(np.diag(cov), 1e-12, None))
    corr = cov / np.outer(std, std)
    corr = np.clip(np.nan_to_num(corr), -1, 1)
    order = _single_linkage_order(corr)

    def cluster_var(items: list[int]) -> float:
        sub = cov[np.ix_(items, items)]
        ivp = 1.0 / np.clip(np.diag(sub), 1e-12, None)
        ivp = ivp / ivp.sum()
        return float(ivp @ sub @ ivp)

    w = np.ones(n)
    stack = [order]
    while stack:
        items = stack.pop()
        if len(items) < 2:
            continue
        half = len(items) // 2
        left, right = items[:half], items[half:]
        v_l, v_r = cluster_var(left), cluster_var(right)
        alpha = 1 - v_l / (v_l + v_r) if (v_l + v_r) > _EPS else 0.5
        w[left] *= alpha
        w[right] *= 1 - alpha
        stack.extend([left, right])
    return apply_cap(w, cap)


def grinold_alpha(scores: np.ndarray, vols: np.ndarray, ic: float) -> np.ndarray:
    """Grinold's rule (Grinold 1994; Grinold & Kahn 2000): the expected
    active return implied by a raw signal is  alpha = IC · sigma · z, where
    z is the cross-sectional z-score of the signal and sigma each name's
    volatility. It turns a ranking into return forecasts calibrated to how
    much the signal has actually predicted — no IC, no alpha."""
    z = np.asarray(scores, dtype=float)
    sd = z.std(ddof=0)
    z = (z - z.mean()) / sd if sd > _EPS else np.zeros_like(z)
    return float(ic) * np.asarray(vols, dtype=float) * z


def mean_variance_weights(alpha: np.ndarray, cov: np.ndarray, cap: float, risk_aversion: float = 1.0,
                          iters: int = 300) -> np.ndarray:
    """max alpha'w − lambda·w'Σw  s.t. sum(w)=1, 0 <= w <= cap, by accelerated
    projected gradient. lambda scales with the typical volatility only (see
    REF_IC), so the alpha keeps its Grinold units and a bigger IC really does
    tilt the book harder."""
    n = cov.shape[0]
    # Risk scale independent of alpha, so |IC| genuinely moves the answer:
    # at a reference IC of 0.02 the alpha and risk gradients are comparable;
    # a weaker signal collapses toward minimum variance, a stronger one
    # concentrates up to the caps.
    sigma_typ = max(float(np.mean(np.sqrt(np.clip(np.diag(cov), 1e-16, None)))), 1e-8)
    lam = max(risk_aversion * REF_IC / sigma_typ, 1e-9)
    w0 = project_capped_simplex(np.full(n, 1.0 / n), cap)
    lipschitz = 2 * lam * max(float(np.linalg.eigvalsh(cov).max()), 1e-10)
    return _accelerated_pgd(lambda w: -alpha + 2 * lam * cov @ w, w0, cap, lipschitz, iters)


def construct(
    scheme: str,
    scores: np.ndarray,
    trailing_returns: np.ndarray,
    cap: float,
    ic: float | None = None,
) -> np.ndarray:
    """Weights for the already-selected names (columns of trailing_returns).
    `ic` (the signal's realised in-sample rank IC) only matters to the
    mean-variance scheme, which needs it to turn scores into alphas."""
    n = len(scores)
    if n == 0:
        return np.zeros(0)
    if scheme == "equal":
        return equal_weights(n, cap)
    if scheme == "score":
        return score_weights(scores, cap)
    if scheme == "inverse_vol":
        return inverse_vol_weights(trailing_returns, cap)
    cov = shrink_cov(trailing_returns)
    if scheme == "min_variance":
        return min_variance_weights(cov, cap)
    if scheme == "risk_parity":
        return risk_parity_weights(cov, cap)
    if scheme == "hrp":
        return hrp_weights(cov, cap)
    if scheme == "mean_variance":
        vols = np.sqrt(np.clip(np.diag(cov), 1e-12, None))
        alpha = grinold_alpha(scores, vols, ic if ic is not None else 0.02)
        return mean_variance_weights(alpha, cov, cap)
    raise ValueError(f"unknown weighting scheme: {scheme}")


def vol_scale(weights: np.ndarray, trailing_returns: np.ndarray, target_vol: float, ann: int) -> float:
    """Exposure multiplier in (0, 1] that brings trailing realised portfolio
    vol down to `target_vol` (annualised, decimal). Never levers up."""
    if target_vol is None or target_vol <= 0 or weights.sum() <= _EPS:
        return 1.0
    port = np.nan_to_num(trailing_returns) @ weights
    realised = float(np.std(port, ddof=1)) * np.sqrt(ann) if len(port) > 2 else 0.0
    if realised <= 1e-9:
        return 1.0
    return float(min(1.0, target_vol / realised))


# -------------------------------------------------------------- analytics


def drawdown_episodes(equity: pd.Series, top: int = 5) -> list[dict]:
    """Peak → trough → recovery episodes, worst first."""
    eq = equity.astype(float)
    peak = eq.cummax()
    dd = eq / peak - 1
    episodes: list[dict] = []
    in_dd = False
    start = trough = None
    trough_val = 0.0
    last_peak = eq.index[0]
    for ts, val in dd.items():
        if not in_dd and val >= 0:
            last_peak = ts  # the most recent high before a fall begins
        if val < 0 and not in_dd:
            in_dd, start, trough, trough_val = True, last_peak, ts, val
        elif in_dd:
            if val < trough_val:
                trough, trough_val = ts, val
            if val >= 0:
                episodes.append({"peak": start, "trough": trough, "recovery": ts, "depth": trough_val})
                in_dd = False
    if in_dd:
        episodes.append({"peak": start, "trough": trough, "recovery": None, "depth": trough_val})
    # ignore sub-0.5% wobbles — they are noise, not episodes
    episodes = [e for e in episodes if e["depth"] <= -0.005]
    episodes.sort(key=lambda e: e["depth"])
    out = []
    for e in episodes[:top]:
        end = e["recovery"] if e["recovery"] is not None else eq.index[-1]
        out.append({
            "peak": str(pd.Timestamp(e["peak"]).date()),
            "trough": str(pd.Timestamp(e["trough"]).date()),
            "recovery": str(pd.Timestamp(e["recovery"]).date()) if e["recovery"] is not None else None,
            "depth_pct": round(float(e["depth"]) * 100, 2),
            "days": int((pd.Timestamp(end) - pd.Timestamp(e["peak"])).days),
        })
    return out


def period_stats(net: pd.Series, bench: pd.Series, ann: int) -> dict:
    """Return / risk figures for one window. Empty-safe."""
    if len(net) < 2:
        return {
            "total_return_pct": 0.0, "cagr_pct": None, "ann_vol_pct": None, "sharpe": None,
            "sortino": None, "calmar": None, "max_drawdown_pct": 0.0, "win_rate_pct": None,
            "excess_pct": 0.0,
        }
    eq = (1 + net).cumprod()
    beq = (1 + bench).cumprod()
    total = float(eq.iloc[-1] - 1)
    years = len(net) / ann
    vol = float(net.std(ddof=1))
    downside = float(net[net < 0].std(ddof=1)) if (net < 0).sum() > 1 else 0.0
    dd = float((eq / eq.cummax() - 1).min())
    cagr = float(eq.iloc[-1] ** (1 / years) - 1) if years > 0.25 else None
    sharpe = float(net.mean() / vol * np.sqrt(ann)) if vol > 1e-12 else None
    sortino = float(net.mean() / downside * np.sqrt(ann)) if downside > 1e-12 else None
    calmar = float(cagr / abs(dd)) if cagr is not None and dd < -1e-9 else None
    return {
        "total_return_pct": round(total * 100, 2),
        "cagr_pct": round(cagr * 100, 2) if cagr is not None else None,
        "ann_vol_pct": round(float(vol * np.sqrt(ann) * 100), 2),
        "sharpe": round(sharpe, 2) if sharpe is not None else None,
        "sortino": round(sortino, 2) if sortino is not None else None,
        "calmar": round(calmar, 2) if calmar is not None else None,
        "max_drawdown_pct": round(dd * 100, 2),
        "win_rate_pct": round(float((net > 0).mean() * 100), 1),
        "excess_pct": round((total - float(beq.iloc[-1] - 1)) * 100, 2),
    }


def relative_stats(net: pd.Series, bench: pd.Series, ann: int) -> dict:
    """Beta, tracking error, information ratio and correlation vs benchmark."""
    both = pd.concat([net, bench], axis=1).dropna()
    if len(both) < 20:
        return {"beta": None, "tracking_error_pct": None, "information_ratio": None, "correlation": None}
    p, b = both.iloc[:, 0], both.iloc[:, 1]
    bvar = float(b.var(ddof=1))
    beta = float(p.cov(b) / bvar) if bvar > 1e-12 else None
    active = p - b
    te = float(active.std(ddof=1)) * np.sqrt(ann)
    ir = float(active.mean() * ann / te) if te > 1e-12 else None
    corr = float(p.corr(b))
    return {
        "beta": round(beta, 2) if beta is not None else None,
        "tracking_error_pct": round(float(te * 100), 2),
        "information_ratio": round(ir, 2) if ir is not None else None,
        "correlation": round(corr, 2) if np.isfinite(corr) else None,
    }


def calendar_returns(net: pd.Series, bench: pd.Series) -> tuple[list[dict], list[dict]]:
    """Monthly and yearly compounded returns, portfolio vs benchmark."""
    frame = pd.DataFrame({"p": net, "b": bench}).dropna(how="all").fillna(0.0)
    if frame.empty:
        return [], []
    monthly = (1 + frame).groupby([frame.index.year, frame.index.month]).prod() - 1
    yearly = (1 + frame).groupby(frame.index.year).prod() - 1
    months = [
        {"year": int(y), "month": int(m), "ret_pct": round(float(row["p"]) * 100, 2),
         "bench_pct": round(float(row["b"]) * 100, 2)}
        for (y, m), row in monthly.iterrows()
    ]
    years = [
        {"year": int(y), "ret_pct": round(float(row["p"]) * 100, 2), "bench_pct": round(float(row["b"]) * 100, 2)}
        for y, row in yearly.iterrows()
    ]
    return months, years


def effective_n(weights: np.ndarray) -> float:
    """1 / Herfindahl of the invested part — how many names you *really* hold."""
    w = np.asarray(weights, dtype=float)
    total = w.sum()
    if total <= _EPS:
        return 0.0
    w = w / total
    return float(1.0 / np.sum(w * w))


# ------------------------------------------------- overfitting statistics


def norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def norm_ppf(p: float) -> float:
    """Inverse normal CDF (Acklam's rational approximation, |error| < 1.2e-9)."""
    p = min(max(p, 1e-12), 1 - 1e-12)
    a = (-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00)
    b = (-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01)
    c = (-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00)
    d = (7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00)
    if p < 0.02425:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p > 1 - 0.02425:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


def probabilistic_sharpe(returns: pd.Series, benchmark_sr: float = 0.0) -> float | None:
    """PSR (Bailey & López de Prado 2012): probability that the TRUE Sharpe
    exceeds `benchmark_sr`, given the observed per-period Sharpe, the track
    length and the return distribution's skew (γ3) and kurtosis (γ4):

        PSR = Φ( (SR − SR*) · sqrt(T − 1) / sqrt(1 − γ3·SR + (γ4 − 1)/4 · SR²) )

    All Sharpe ratios here are per period (daily), not annualised."""
    r = returns.dropna()
    t = len(r)
    if t < 30:
        return None
    sd = float(r.std(ddof=1))
    if sd <= _EPS:
        return None
    sr = float(r.mean() / sd)
    skew = float(((r - r.mean()) ** 3).mean() / sd**3)
    kurt = float(((r - r.mean()) ** 4).mean() / sd**4)
    denom = 1 - skew * sr + (kurt - 1) / 4 * sr * sr
    if denom <= _EPS:
        return None
    return norm_cdf((sr - benchmark_sr) * math.sqrt(t - 1) / math.sqrt(denom))


def deflated_sharpe(returns: pd.Series, trial_sharpes: list[float], extra_trials: int = 0) -> dict:
    """DSR (Bailey & López de Prado 2014): PSR against the Sharpe one would
    expect from the BEST of N unskilled trials,

        SR* = sqrt(V[SR_n]) · ((1 − γ) Φ⁻¹(1 − 1/N) + γ Φ⁻¹(1 − 1/(N·e))),  γ = Euler-Mascheroni,

    where V[SR_n] is the variance of the trial Sharpes (per period). N is the
    number of configurations actually evaluated in this run — the scheme
    comparison and each factor's standalone test all count as trials."""
    trials = [float(x) for x in trial_sharpes if x is not None and np.isfinite(x)]
    # `extra_trials` are configurations tried earlier (counted by the client);
    # they raise N but we only know this run's Sharpe dispersion
    n = len(trials) + max(0, int(extra_trials))
    if len(trials) < 2:
        return {"trials": n, "expected_max_sharpe": None, "dsr": probabilistic_sharpe(returns)}
    var = float(np.var(trials, ddof=1))
    gamma = 0.5772156649015329
    sr_star = math.sqrt(max(var, 0.0)) * ((1 - gamma) * norm_ppf(1 - 1 / n) + gamma * norm_ppf(1 - 1 / (n * math.e)))
    return {"trials": n, "expected_max_sharpe": round(sr_star, 4), "dsr": probabilistic_sharpe(returns, sr_star)}


def capture_ratios(net: pd.Series, bench: pd.Series) -> dict:
    """Up / down capture: the portfolio's compounded return in benchmark-up
    months divided by the benchmark's, and likewise for down months. A ratio
    above 1 on the upside and below 1 on the downside is the asymmetric
    profile every allocator asks for."""
    frame = pd.DataFrame({"p": net, "b": bench}).dropna()
    if len(frame) < 40:
        return {"up": None, "down": None, "up_periods": 0, "down_periods": 0}
    monthly = (1 + frame).groupby([frame.index.year, frame.index.month]).prod() - 1
    up, down = monthly[monthly["b"] > 0], monthly[monthly["b"] < 0]

    def ratio(part: pd.DataFrame) -> float | None:
        if len(part) < 2:
            return None
        pb = float((1 + part["b"]).prod() - 1)
        pp = float((1 + part["p"]).prod() - 1)
        return round(pp / pb, 2) if abs(pb) > 1e-9 else None

    return {"up": ratio(up), "down": ratio(down), "up_periods": int(len(up)), "down_periods": int(len(down))}


def cvar(returns: pd.Series, level: float = 0.95) -> float | None:
    """Expected shortfall: mean of the worst (1 − level) daily returns, in %."""
    r = returns.dropna().sort_values()
    k = int(math.ceil(len(r) * (1 - level)))
    if k < 3:
        return None
    return round(float(r.iloc[:k].mean()) * 100, 2)


def min_track_record_length(returns: pd.Series, benchmark_sr: float = 0.0, confidence: float = 0.95) -> int | None:
    """MinTRL (Bailey & López de Prado 2012): the number of periods needed for
    the observed Sharpe to be significantly above `benchmark_sr`,

        MinTRL = 1 + (1 − γ3·SR + (γ4 − 1)/4 · SR²) · (z_α / (SR − SR*))²

    Returns None when SR <= SR* (no length would ever suffice)."""
    r = returns.dropna()
    if len(r) < 30:
        return None
    sd = float(r.std(ddof=1))
    if sd <= _EPS:
        return None
    sr = float(r.mean() / sd)
    if sr <= benchmark_sr:
        return None
    skew = float(((r - r.mean()) ** 3).mean() / sd**3)
    kurt = float(((r - r.mean()) ** 4).mean() / sd**4)
    z = norm_ppf(confidence)
    return int(math.ceil(1 + (1 - skew * sr + (kurt - 1) / 4 * sr * sr) * (z / (sr - benchmark_sr)) ** 2))


def sharpe_tstat(returns: pd.Series) -> float | None:
    """t-statistic of the mean return, t ≈ SR_period · sqrt(T). Harvey, Liu &
    Zhu (2016) argue a new strategy should clear t > 3 given how many have
    been tried; t < 2 is not even a conventional finding."""
    r = returns.dropna()
    sd = float(r.std(ddof=1))
    if len(r) < 30 or sd <= _EPS:
        return None
    return round(float(r.mean() / sd * math.sqrt(len(r))), 2)


def regime_table(net: pd.Series, bench: pd.Series, ann: int) -> list[dict]:
    """Performance conditional on the benchmark's state: realised-vol
    terciles (60-day) and trend (above / below its 100-day average). Three
    years is often a single regime — this shows whether the result is one
    bull run or holds up when the tape changes."""
    frame = pd.DataFrame({"p": net, "b": bench}).dropna()
    if len(frame) < 150:
        return []
    vol = frame["b"].rolling(60).std()
    trend_level = (1 + frame["b"]).cumprod()
    trend = trend_level > trend_level.rolling(100).mean()
    tri = pd.qcut(vol.rank(method="first"), 3, labels=["low_vol", "mid_vol", "high_vol"])
    rows = []

    def row(label: str, mask: pd.Series) -> None:
        part = frame[mask.fillna(False).astype(bool)]
        if len(part) < 20:
            return
        sd = float(part["p"].std(ddof=1))
        rows.append({
            "regime": label,
            "days": int(len(part)),
            "ann_return_pct": round(float(part["p"].mean() * ann) * 100, 2),
            "bench_ann_return_pct": round(float(part["b"].mean() * ann) * 100, 2),
            "sharpe": round(float(part["p"].mean() / sd * np.sqrt(ann)), 2) if sd > _EPS else None,
            "hit_rate_pct": round(float((part["p"] > part["b"]).mean() * 100), 1),
        })

    for label in ("low_vol", "mid_vol", "high_vol"):
        row(label, tri == label)
    row("uptrend", trend & trend_level.rolling(100).mean().notna())
    row("downtrend", ~trend & trend_level.rolling(100).mean().notna())
    return rows


def quantile_returns(scores: pd.DataFrame, returns: pd.DataFrame, ann: int, buckets: int = 5) -> dict:
    """Qlib-style signal check: equal-weight the names in each score quantile,
    rebalanced daily with a one-bar lag, gross of costs. A good signal shows
    monotone bucket returns and a positive top-minus-bottom spread."""
    sc = scores.reindex(index=returns.index, columns=returns.columns)
    ranks = sc.rank(axis=1, pct=True).shift(1)  # decided at t-1, earns t
    valid = ranks.notna() & returns.notna()
    if int(valid.any(axis=1).sum()) < 60:
        return {"buckets": [], "spread_ann_pct": None, "monotonic": None}
    out = []
    series = []
    for k in range(buckets):
        lo, hi = k / buckets, (k + 1) / buckets
        member = (ranks > lo) & (ranks <= hi) if k > 0 else (ranks <= hi)
        member = member & valid
        w = member.div(member.sum(axis=1).replace(0, np.nan), axis=0)
        r = (w * returns.fillna(0)).sum(axis=1)
        r = r[member.sum(axis=1) > 0]
        series.append(r)
        out.append({"bucket": k + 1, "ann_return_pct": round(float(r.mean() * ann) * 100, 2) if len(r) else None})
    both = pd.concat([series[-1], series[0]], axis=1).dropna()
    spread = both.iloc[:, 0] - both.iloc[:, 1]
    vals = [b["ann_return_pct"] for b in out if b["ann_return_pct"] is not None]
    sd = float(spread.std(ddof=1)) if len(spread) > 2 else 0.0
    return {
        "buckets": out,
        "spread_ann_pct": round(float(spread.mean() * ann) * 100, 2) if len(spread) else None,
        "spread_sharpe": round(float(spread.mean() / sd * np.sqrt(ann)), 2) if sd > _EPS else None,
        "monotonic": bool(all(b >= a for a, b in zip(vals, vals[1:]))) if len(vals) == buckets else None,
    }


def brinson(held: pd.DataFrame, bench_w: pd.DataFrame, returns: pd.DataFrame, groups: dict[str, str]) -> dict:
    """Brinson-Fachler attribution against the equal-weight benchmark, summed
    over days (arithmetic):
        allocation  = Σ_g (w_g − W_g)(B_g − B)
        selection   = Σ_g W_g (R_g − B_g)
        interaction = Σ_g (w_g − W_g)(R_g − B_g)
    where w/W are portfolio/benchmark group weights, R_g/B_g the group
    returns inside each, B the total benchmark return."""
    syms = [c for c in returns.columns if c in held.columns]
    if not syms:
        return {"allocation_pct": None, "selection_pct": None, "interaction_pct": None, "groups": []}
    g = pd.Series({s: groups.get(str(s), "other") for s in syms})
    r = returns[syms].fillna(0.0)
    w = held[syms].fillna(0.0)
    bw = bench_w[syms].fillna(0.0)
    labels = sorted(set(g.values))
    alloc = sel = inter = 0.0
    per_group = []
    b_total = (bw * r).sum(axis=1)
    for label in labels:
        cols = [s for s in syms if g[s] == label]
        wg, Wg = w[cols].sum(axis=1), bw[cols].sum(axis=1)
        Rg = (w[cols] * r[cols]).sum(axis=1) / wg.replace(0, np.nan)
        Bg = (bw[cols] * r[cols]).sum(axis=1) / Wg.replace(0, np.nan)
        Rg = Rg.fillna(Bg).fillna(0.0)
        Bg = Bg.fillna(0.0)
        a = ((wg - Wg) * (Bg - b_total)).sum()
        se = (Wg * (Rg - Bg)).sum()
        it = ((wg - Wg) * (Rg - Bg)).sum()
        alloc += a
        sel += se
        inter += it
        per_group.append({
            "group": label,
            "avg_weight_pct": round(float(wg.mean()) * 100, 2),
            "bench_weight_pct": round(float(Wg.mean()) * 100, 2),
            "allocation_pct": round(float(a) * 100, 2),
            "selection_pct": round(float(se) * 100, 2),
        })
    per_group.sort(key=lambda x: -x["avg_weight_pct"])
    return {
        "allocation_pct": round(float(alloc) * 100, 2),
        "selection_pct": round(float(sel) * 100, 2),
        "interaction_pct": round(float(inter) * 100, 2),
        "groups": per_group,
    }


def sharpe_difference_test(a: pd.Series, b: pd.Series, draws: int = 1000, seed: int = 0) -> dict:
    """Is strategy a's Sharpe really higher than b's? Ledoit & Wolf (2008,
    J. Empirical Finance) — the paired difference of Sharpe ratios under a
    circular block bootstrap (block length ≈ T^(1/3)), which respects the
    autocorrelation and fat tails of daily returns. Returns the observed
    per-period ΔSR and a two-sided p-value for ΔSR = 0."""
    both = pd.concat([a, b], axis=1).dropna()
    t = len(both)
    if t < 60:
        return {"delta_sharpe": None, "p_value": None}
    x = both.to_numpy(dtype=float)

    def sr(m: np.ndarray) -> np.ndarray:
        mu = m.mean(axis=-2)
        sd = m.std(axis=-2, ddof=1)
        return np.where(sd > _EPS, mu / np.where(sd > _EPS, sd, 1.0), 0.0)

    observed = sr(x)
    delta_obs = float(observed[0] - observed[1])
    block = max(2, int(round(t ** (1 / 3))))
    rng = np.random.default_rng(seed)
    n_blocks = int(np.ceil(t / block))
    starts = rng.integers(0, t, size=(draws, n_blocks))
    idx = (starts[:, :, None] + np.arange(block)[None, None, :]).reshape(draws, -1)[:, :t] % t
    boot = x[idx]                      # (draws, t, 2)
    deltas = sr(boot)[:, 0] - sr(boot)[:, 1]
    centred = deltas - deltas.mean()
    p = float((np.abs(centred) >= abs(delta_obs)).mean())
    return {"delta_sharpe": round(delta_obs, 4), "p_value": round(p, 3)}


def rolling_window_beat_pct(net: pd.Series, bench: pd.Series, window: int = 126) -> float | None:
    """Share of rolling `window`-day periods in which the portfolio's
    compounded return beat the benchmark's. 50% means the edge is a coin
    toss over any given half-year, however good the full-sample number."""
    frame = pd.DataFrame({"p": net, "b": bench}).dropna()
    if len(frame) < window + 20:
        return None
    lp = np.log1p(frame["p"]).rolling(window).sum()
    lb = np.log1p(frame["b"]).rolling(window).sum()
    diff = (lp - lb).dropna()
    return round(float((diff > 0).mean() * 100), 1) if len(diff) else None
