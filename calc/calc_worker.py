#!/usr/bin/env python3
"""MRPscan pricing worker: the arithmetic of src/services/pricingMath.js in
numpy and pandas, run by the Node bridge src/services/pyCalcEngine.js.

Protocol, one JSON object per line each way:
  stdin   {"id": <id>, "inputs": {...pricingMath inputs...}}
  stdout  {"id": <id>, "ok": true, "breakdown": {...computePricing result...}}
          {"id": <id>, "ok": false, "error": "<why>"}
Nothing else is ever written to stdout; logs go to stderr. A bad line gets an
error reply and the worker carries on with the next one.

Every figure is the JavaScript one, operation for operation, in IEEE doubles
(numpy float64 and Python float are the doubles V8 uses), so the results are
identical to the last bit rather than close:
  - sums run left to right (np.add.accumulate, DataFrame.cumsum), never
    numpy's pairwise sum or pandas' compensated group sums, which round
    differently;
  - Math.min / Math.max keep their signed-zero rules, and `x || y` on a
    number treats 0, -0 and NaN as false;
  - pricingMath rounds nothing (no Math.round, no toFixed), so neither does
    this.
A figure that is not finite cannot cross JSON; such a request is answered as
an error and the bridge prices it in Node.
"""

import json
import math
import os
import platform
import sys


def _claim_stdout():
    """Keeps the real stdout for replies alone. File descriptor 1 and
    sys.stdout then lead to stderr, so nothing a library prints, even from C,
    can land between two replies."""
    sys.stdout.flush()
    replies = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return replies


REPLIES = _claim_stdout()

# One request at a time needs no thread pools; on a small instance they only
# cost memory. Set before numpy loads its BLAS.
for _name in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_name, "1")

import numpy as np  # noqa: E402  (after the stdout claim, on purpose)
import pandas as pd  # noqa: E402

NUMBER_INPUTS = (
    "netWt",
    "grossWt",
    "karatPurityPercent",
    "karatNumber",
    "goldRatePer10g",
    "labourRatePerUnit",
    "wastagePercent",
    "otherCharges",
)
STRING_INPUTS = ("labourUnit", "labourWeightBasis", "labourChargeType", "wastageCode")
DIAMOND_COLUMNS = ("weight", "rate", "discountPercent")
COLORSTONE_COLUMNS = ("weight", "rate")
# aggregateJewelleryMrp's order, which is the order the subtotal adds them in.
COMPONENTS = ("gold", "diamond", "colorstone", "labour", "wastage", "other")
# Built once: a DataFrame made on these costs a fifth of one made from lists.
COMPONENT_INDEX = pd.Index(COMPONENTS)
AMOUNT_COLUMN = pd.Index(["amount"])


# ── JavaScript semantics ─────────────────────────────────────────────────


def js_truthy(x):
    """A number as `x || ...` sees it: 0, -0 and NaN are false."""
    return x == x and x != 0


def js_min(a, b):
    """Math.min(a, b), -0 below +0."""
    if a != a or b != b:
        return math.nan
    if a < b:
        return a
    if b < a:
        return b
    return a if math.copysign(1.0, a) < 0 else b


def js_max(a, b):
    """Math.max(a, b), +0 above -0."""
    if a != a or b != b:
        return math.nan
    if a > b:
        return a
    if b > a:
        return b
    return b if math.copysign(1.0, a) < 0 else a


def clamp_percent(values):
    """Math.max(0, Math.min(100, x)) over an array of finite numbers: x below
    100 stays (-0 included), else 100; then anything not above 0, -0 and +0
    alike, becomes +0."""
    upper = np.where(values < 100.0, values, 100.0)
    return np.where(upper > 0.0, upper, 0.0)


def sum_from_zero(values):
    """values.reduce((sum, x) => sum + x, 0): left to right from +0."""
    return float(np.add.accumulate(np.concatenate(([0.0], values)))[-1])


# ── Inputs ───────────────────────────────────────────────────────────────


# What json.loads makes of a JSON number. Not bool: JSON true is a Python
# int subclass, and it is not a number here.
_NUMBER_TYPES = (int, float)


def _number(value, name):
    if type(value) not in _NUMBER_TYPES:
        raise ValueError(f"{name} must be a number")
    # float() rounds a long integer to the nearest double, as V8 does.
    x = float(value)
    if not math.isfinite(x):
        raise ValueError(f"{name} must be finite")
    return x


def _rows(value, name, columns):
    if type(value) is not list:
        raise ValueError(f"{name} must be a list")
    cells = []
    for i, row in enumerate(value):
        if type(row) is not dict:
            raise ValueError(f"{name}[{i}] must be an object")
        for column in columns:
            cell = row.get(column)
            if type(cell) not in _NUMBER_TYPES:
                raise ValueError(f"{name}[{i}].{column} must be a number")
            cells.append(float(cell))
    table = np.array(cells, dtype=np.float64).reshape(len(value), len(columns))
    if not np.isfinite(table).all():
        raise ValueError(f"{name} must be finite")
    return table


def read_inputs(inputs):
    if not isinstance(inputs, dict):
        raise ValueError("inputs must be an object")
    values = {name: _number(inputs.get(name), name) for name in NUMBER_INPUTS}
    for name in STRING_INPUTS:
        if not isinstance(inputs.get(name), str):
            raise ValueError(f"{name} must be a string")
        values[name] = inputs[name]
    custom = inputs.get("customPurityPercent")
    values["customPurityPercent"] = None if custom is None else _number(custom, "customPurityPercent")
    values["diamonds"] = _rows(inputs.get("diamonds"), "diamonds", DIAMOND_COLUMNS)
    values["colorstones"] = _rows(inputs.get("colorstones"), "colorstones", COLORSTONE_COLUMNS)
    return values


# ── The arithmetic (pricingMath.computePricing) ──────────────────────────


def compute_pricing(raw_inputs):
    p = read_inputs(raw_inputs)
    net = p["netWt"]
    gross = p["grossWt"]

    karat_number = p["karatNumber"]
    fallback_purity = js_min(100.0, (karat_number / 24.0) * 100.0) if karat_number > 0 else 0.0
    if p["customPurityPercent"] is not None:
        purity = p["customPurityPercent"]
    else:
        purity = p["karatPurityPercent"] if js_truthy(p["karatPurityPercent"]) else fallback_purity
    purity = js_max(0.0, js_min(100.0, purity))

    # Stone rows, all at once: weight x rate, less the clamped discount.
    diamonds = p["diamonds"]
    d_weight, d_rate = diamonds[:, 0], diamonds[:, 1]
    d_discount = clamp_percent(diamonds[:, 2])
    d_base = d_weight * d_rate
    d_amount = d_base - d_base * (d_discount / 100.0)
    diamond_amount = sum_from_zero(d_amount)

    colorstones = p["colorstones"]
    c_weight, c_rate = colorstones[:, 0], colorstones[:, 1]
    c_amount = c_weight * c_rate
    colorstone_amount = sum_from_zero(c_amount)

    pure_weight = net * (purity / 100.0)

    if p["labourWeightBasis"] == "gross":
        labour_weight = gross if gross > 0 else net
    else:
        labour_weight = net
    labour_rate = p["labourRatePerUnit"]
    labour_amount = 0.0
    if labour_rate > 0:
        if p["labourUnit"] == "Per 10 Gram":
            labour_amount = labour_weight * (labour_rate / 10.0)
        else:
            labour_amount = labour_weight * labour_rate

    gold_rate_10g = p["goldRatePer10g"]
    rate_per_gram = (gold_rate_10g if js_truthy(gold_rate_10g) else 0.0) / 10.0
    purity_adjusted_rate = rate_per_gram * (purity / 100.0)
    gold_amount = pure_weight * rate_per_gram

    wastage_percent = p["wastagePercent"]
    wastage_weight = net * (wastage_percent / 100.0) if wastage_percent > 0 else 0.0
    wastage_amount = wastage_weight * rate_per_gram

    # The line items, each made finite (aggregateJewelleryMrp's
    # toFiniteNumber), in a DataFrame whose running total, left to right, ends
    # at the subtotal.
    amounts = np.array(
        [gold_amount, diamond_amount, colorstone_amount, labour_amount, wastage_amount, p["otherCharges"]],
        dtype=np.float64,
    )
    amounts = np.where(np.isfinite(amounts), amounts, 0.0)
    lines = pd.DataFrame(amounts.reshape(-1, 1), index=COMPONENT_INDEX, columns=AMOUNT_COLUMN, copy=False)
    running = lines.cumsum()
    line = dict(zip(COMPONENTS, lines.to_numpy()[:, 0].tolist()))
    subtotal = float(running.to_numpy()[-1, 0])

    breakdown = {
        "diamondAmount": line["diamond"],
        "colorstoneAmount": line["colorstone"],
        "pureWeight": pure_weight,
        "goldRateApplied": rate_per_gram,
        "goldAmount": line["gold"],
        "labourAmount": line["labour"],
        "labourChargeType": p["labourChargeType"],
        "wastageCode": p["wastageCode"],
        "wastagePercent": wastage_percent,
        "wastageWeightGrams": wastage_weight,
        "wastageAmount": line["wastage"],
        "otherCharges": line["other"],
        "subtotal": subtotal,
    }
    diamond_items = [
        {"index": i + 1, "weight": w, "rate": r, "discountPercent": d, "amount": a}
        for i, (w, r, d, a) in enumerate(
            zip(d_weight.tolist(), d_rate.tolist(), d_discount.tolist(), d_amount.tolist())
        )
    ]
    colorstone_items = [
        {"index": i + 1, "weight": w, "rate": r, "amount": a}
        for i, (w, r, a) in enumerate(zip(c_weight.tolist(), c_rate.tolist(), c_amount.tolist()))
    ]
    return {
        "breakdown": breakdown,
        "finalMRP": subtotal,
        "effectivePurityPercent": purity,
        "purityAdjustedGoldRatePerGram": purity_adjusted_rate,
        "diamondLineItems": diamond_items,
        "colorstoneLineItems": colorstone_items,
    }


# ── The line protocol ────────────────────────────────────────────────────


def _reject_constant(name):
    raise ValueError(f"{name} is not JSON")


def _encode(message):
    # allow_nan=False: Infinity and NaN are not JSON, so a figure that is
    # either becomes an error reply instead of a line Node cannot read.
    return json.dumps(message, allow_nan=False, separators=(",", ":")).encode("utf-8")


def handle(line):
    request_id = None
    try:
        message = json.loads(line, parse_constant=_reject_constant)
        if not isinstance(message, dict):
            raise ValueError("a request must be a JSON object")
        request_id = message.get("id")
        with np.errstate(all="ignore"):
            result = compute_pricing(message.get("inputs"))
        return _encode({"id": request_id, "ok": True, "breakdown": result})
    except Exception as exc:  # one bad request never stops the worker
        error = f"{type(exc).__name__}: {exc}"[:500]
        try:
            return _encode({"id": request_id, "ok": False, "error": error})
        except Exception:
            return _encode({"id": None, "ok": False, "error": error})


def main():
    sys.stderr.write(
        f"calc_worker ready pid={os.getpid()} python={platform.python_version()} "
        f"numpy={np.__version__} pandas={pd.__version__}\n"
    )
    sys.stderr.flush()
    try:
        for raw in sys.stdin.buffer:
            line = raw.strip()
            if not line:
                continue
            REPLIES.write(handle(line) + b"\n")
            REPLIES.flush()
    except (OSError, KeyboardInterrupt):
        # Node went away (a broken pipe is EPIPE on Linux, EINVAL on Windows).
        pass


if __name__ == "__main__":
    main()
