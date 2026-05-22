from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from typing import Any

from z3 import And, Bool, BoolVal, Implies, Int, IntVal, Not, Or, Real, RealVal, Solver, String, StringVal, is_true, sat, unknown, unsat


class ConstraintError(ValueError):
    def __init__(self, message: str, constraint_id: str | None = None):
        super().__init__(message)
        self.constraint_id = constraint_id


@dataclass
class SolverOutcome:
    result: str
    risk_level: str
    meaning: str
    counterexample: dict[str, Any] | None
    explanation: str
    recommendations: list[str]
    duration_ms: int
    timeout: bool
    constraint_hash: str
    solver_trace_hash: str


def stable_hash(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def verify_payload(payload: dict[str, Any], default_timeout_ms: int, max_timeout_ms: int) -> SolverOutcome:
    started = time.perf_counter()
    constraints = payload.get("constraints") if isinstance(payload.get("constraints"), list) else []
    query = payload.get("query") if isinstance(payload.get("query"), dict) else {}
    query_type = str(query.get("type") or "FORBIDDEN_STATE_CHECK").upper()
    options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
    timeout_ms = int(options.get("timeoutMs") or options.get("timeout_ms") or default_timeout_ms)
    timeout_ms = max(1, min(timeout_ms, max_timeout_ms))

    facts = payload.get("facts") if isinstance(payload.get("facts"), dict) else {}
    env = _Env()
    solver = Solver()
    solver.set(timeout=timeout_ms)

    for field, value in _fact_assignments(facts):
        solver.add(env.var(field, value) == env.val(field, value))

    for item in constraints:
        if not isinstance(item, dict):
            raise ConstraintError("Constraint must be an object")
        expr = item.get("expression") or item.get("expr") or item
        # In forbidden-state mode policy rules are evidence descriptors; the
        # query asks whether the unsafe state is possible under the submitted
        # facts. Domain constraints can still opt in with enforce=true.
        if query_type == "CONSISTENCY_CHECK" or item.get("enforce") is True:
            solver.add(env.expr(expr))

    assertions = query.get("assertions")
    if isinstance(assertions, list) and assertions:
        solver.add(And(*[env.expr(assertion) for assertion in assertions if isinstance(assertion, dict)]))
    elif query:
        solver.add(env.expr(query))

    check = solver.check()
    duration_ms = int((time.perf_counter() - started) * 1000)
    result = "SAT" if check == sat else "UNSAT" if check == unsat else "UNKNOWN"
    timeout = check == unknown and "timeout" in str(solver.reason_unknown()).lower()
    counterexample = env.counterexample(solver.model()) if check == sat else None
    risk_level = _risk_level(query_type, result, constraints)
    meaning = _meaning(query_type, result)
    explanation = _explanation(query_type, result, counterexample)
    recommendations = _recommendations(query_type, result, counterexample)
    solver_trace = {
        "constraints": constraints,
        "query": query,
        "result": result,
        "counterexample": counterexample,
        "reasonUnknown": solver.reason_unknown() if check == unknown else None,
    }
    return SolverOutcome(
        result=result,
        risk_level=risk_level,
        meaning=meaning,
        counterexample=counterexample,
        explanation=explanation,
        recommendations=recommendations,
        duration_ms=duration_ms,
        timeout=timeout,
        constraint_hash=stable_hash(constraints),
        solver_trace_hash=stable_hash(solver_trace),
    )


class _Env:
    def __init__(self) -> None:
        self.vars: dict[str, Any] = {}
        self.types: dict[str, str] = {}

    def expr(self, node: dict[str, Any]) -> Any:
        if "field" in node:
            return self.field_expr(node)
        op = _norm_op(node.get("operator", node.get("op")))
        if op == "AND":
            return And(*[self.expr(c) for c in _conditions(node)])
        if op == "OR":
            return Or(*[self.expr(c) for c in _conditions(node)])
        if op == "NOT":
            target = node.get("condition") or node.get("left")
            if not isinstance(target, dict):
                raise ConstraintError("NOT requires condition")
            return Not(self.expr(target))
        if op == "IMPLIES":
            left, right = node.get("left", node.get("if")), node.get("right", node.get("then"))
            if not isinstance(left, dict) or not isinstance(right, dict):
                raise ConstraintError("IMPLIES requires left and right")
            return Implies(self.expr(left), self.expr(right))
        raise ConstraintError(f"Unsupported expression operator: {node.get('operator')}")

    def field_expr(self, node: dict[str, Any]) -> Any:
        field = str(node.get("field") or "").strip()
        if not field:
            raise ConstraintError("Field expression requires field")
        op = _norm_op(node.get("operator", node.get("op")))
        value = node.get("value")
        var = self.var(field, value)
        if op in {"==", "EQUALS"}:
            return var == self.val(field, value)
        if op in {"!=", "NOT_EQUALS"}:
            return var != self.val(field, value)
        if op == "GT":
            return var > self.val(field, value)
        if op == "GTE":
            return var >= self.val(field, value)
        if op == "LT":
            return var < self.val(field, value)
        if op == "LTE":
            return var <= self.val(field, value)
        if op == "IN":
            values = value if isinstance(value, list) else []
            return Or(*[var == self.val(field, v) for v in values]) if values else BoolVal(False)
        if op == "NOT_IN":
            values = value if isinstance(value, list) else []
            return And(*[var != self.val(field, v) for v in values]) if values else BoolVal(True)
        raise ConstraintError(f"Unsupported field operator: {node.get('operator')}")

    def var(self, field: str, sample: Any) -> Any:
        typ = self.types.get(field) or _type_for(sample)
        self.types[field] = typ
        if field not in self.vars:
            if typ == "bool":
                self.vars[field] = Bool(field)
            elif typ == "int":
                self.vars[field] = Int(field)
            elif typ == "real":
                self.vars[field] = Real(field)
            else:
                self.vars[field] = String(field)
        return self.vars[field]

    def val(self, field: str, value: Any) -> Any:
        typ = self.types.get(field) or _type_for(value)
        self.types[field] = typ
        if typ == "bool":
            return BoolVal(bool(value))
        if typ == "int":
            return IntVal(int(value))
        if typ == "real":
            return RealVal(str(value))
        return StringVal(str(value))

    def counterexample(self, model: Any) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for field, var in self.vars.items():
            value = model.eval(var, model_completion=True)
            typ = self.types.get(field)
            if typ == "bool":
                out[field] = bool(is_true(value))
            elif typ == "int":
                out[field] = int(value.as_long())
            elif typ == "real":
                out[field] = str(value)
            else:
                out[field] = str(value).strip('"')
        return out


def _conditions(node: dict[str, Any]) -> list[dict[str, Any]]:
    raw_args = node.get("args")
    if isinstance(raw_args, list):
        return [c for c in raw_args if isinstance(c, dict)]
    raw = node.get("conditions")
    if isinstance(raw, list):
        return [c for c in raw if isinstance(c, dict)]
    left, right = node.get("left"), node.get("right")
    return [c for c in [left, right] if isinstance(c, dict)]


def _fact_assignments(value: dict[str, Any], prefix: str = "") -> list[tuple[str, Any]]:
    out: list[tuple[str, Any]] = []
    for key, raw in value.items():
        field = f"{prefix}.{key}" if prefix else str(key)
        if isinstance(raw, (bool, int, float, str)):
            out.append((field, raw))
        elif isinstance(raw, dict):
            out.extend(_fact_assignments(raw, field))
    return out


def _norm_op(op: Any) -> str:
    text = str(op or "==").upper()
    aliases = {
        "=": "==",
        "EQUALS": "==",
        "NOT_EQUALS": "!=",
        "<>": "!=",
        ">": "GT",
        ">=": "GTE",
        "<": "LT",
        "<=": "LTE",
    }
    return aliases.get(text, text)


def _type_for(value: Any) -> str:
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int) and not isinstance(value, bool):
        return "int"
    if isinstance(value, float):
        return "real"
    if isinstance(value, list) and value:
        return _type_for(value[0])
    return "string"


def _risk_level(query_type: str, result: str, constraints: list[Any]) -> str:
    if result == "UNKNOWN":
        return "REVIEW_REQUIRED"
    if query_type == "CONSISTENCY_CHECK":
        return "HIGH" if result == "UNSAT" else "NONE"
    if result == "SAT":
        severities = [str(c.get("severity", "")).upper() for c in constraints if isinstance(c, dict)]
        for sev in ["CRITICAL", "HIGH", "MEDIUM", "LOW"]:
            if sev in severities:
                return sev
        return "HIGH"
    return "NONE"


def _meaning(query_type: str, result: str) -> str:
    if result == "UNKNOWN":
        return "Solver could not prove or disprove the query within the configured timeout"
    if query_type == "CONSISTENCY_CHECK":
        return "Constraints are contradictory" if result == "UNSAT" else "Constraints are satisfiable together"
    if query_type == "REACHABILITY_CHECK":
        return "Target state is reachable" if result == "SAT" else "Target state is unreachable"
    if result == "SAT":
        return "Violation is possible"
    return "Forbidden state is impossible under current constraints"


def _explanation(query_type: str, result: str, counterexample: dict[str, Any] | None) -> str:
    if result == "UNKNOWN":
        return "The solver timed out or could not decide the query. Treat this as requiring human review."
    if counterexample:
        facts = ", ".join(f"{k}={v}" for k, v in counterexample.items())
        if query_type == "REACHABILITY_CHECK":
            return f"The target state is reachable with: {facts}."
        return f"A violating state is possible with: {facts}."
    if query_type == "CONSISTENCY_CHECK" and result == "UNSAT":
        return "The submitted constraints cannot all be true at the same time."
    return "No counterexample exists for the requested unsafe state."


def _recommendations(query_type: str, result: str, counterexample: dict[str, Any] | None) -> list[str]:
    if result == "UNKNOWN":
        return ["Reduce the constraint set, increase timeout, or require human review before proceeding."]
    if result == "SAT" and counterexample:
        # M66 — Domain-aware remediation. The default "tighten the policy"
        # message is actively wrong for the most common counterexample we
        # see in production: `codeChanged=True` paired with absent or
        # failing verification receipts. The policy already excludes that
        # state (that's why the solver returned SAT); the actual fix is to
        # produce the evidence, not to constrain the model further. Detect
        # that shape and return an actionable hint instead.
        ce = counterexample
        code_changed = bool(ce.get("codeChanged"))
        receipt_present = bool(ce.get("verificationReceiptPresent"))
        receipt_passed = bool(ce.get("verificationReceiptPassed"))
        if code_changed and not receipt_present:
            return [
                "This code change has no verification receipt attached. "
                "Run a test/lint/typecheck tool (e.g. run_test, run_command) "
                "before finish_work_branch — its output gets recorded as "
                "the verification receipt the formal verifier expects.",
                "If verification is genuinely unavailable for this change "
                "(e.g. infrastructure-only edit with no test target), "
                "emit a `verification_unavailable` receipt to acknowledge "
                "the gap explicitly.",
            ]
        if code_changed and receipt_present and not receipt_passed:
            return [
                "A verification receipt is attached but reports a failure "
                "(passed=false or exit_code!=0). Investigate the failure, "
                "fix the underlying issue, and re-run verification — the "
                "policy requires a passing receipt before finishing.",
            ]
        return ["Add or tighten a mandatory policy constraint that excludes this counterexample."]
    if query_type == "CONSISTENCY_CHECK" and result == "UNSAT":
        return ["Review the conflicting requirements or policies and remove the contradiction."]
    return []
