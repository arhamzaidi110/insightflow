"""Deterministic, allow-listed analytics plans for bounded in-memory datasets."""
from __future__ import annotations

import json
import math
import io
from typing import Any

import numpy as np
import pandas as pd
from fastapi import HTTPException

OPERATIONS = {"summary", "group_by", "sort_top", "trend", "compare", "missing", "duplicates", "correlation", "rows"}
AGGREGATIONS = {"sum", "average", "mean", "count", "min", "max", "median"}
GRANULARITIES = {"daily", "monthly", "quarterly", "yearly"}
MAX_LIMIT = 100
MAX_PAGE_SIZE = 100
MAX_CORRELATION_COLUMNS = 20
MAX_COLUMNS_FOR_ROWS = 250
MAX_RESULT_BYTES = 5 * 1024 * 1024
MAX_EXPORT_BYTES = 10 * 1024 * 1024
MAX_EXPORT_CELLS = 1_500_000
PLAN_KEYS = {"operation", "column", "groupBy", "columns", "aggregation", "direction", "limit", "dateColumn", "granularity", "values", "filters", "page", "pageSize"}
OPERATION_KEYS = {
    "summary": {"column", "filters"}, "group_by": {"groupBy", "column", "aggregation", "limit", "filters"},
    "sort_top": {"column", "direction", "limit", "filters"}, "trend": {"dateColumn", "column", "aggregation", "granularity", "filters"},
    "compare": {"groupBy", "column", "aggregation", "values", "filters"}, "missing": {"column", "filters"},
    "duplicates": {"limit", "filters"}, "correlation": {"columns", "filters"}, "rows": {"columns", "page", "pageSize", "filters", "column", "direction"},
}
FILTER_KEYS = {"column", "operator", "value"}
FILTER_OPERATORS = {"eq", "ne", "contains", "gt", "gte", "lt", "lte", "in", "is_null", "not_null"}


def _bad(message: str) -> None:
    raise HTTPException(status_code=422, detail=message)


def _column(frame: pd.DataFrame, name: Any) -> str:
    if not isinstance(name, str) or name not in frame.columns:
        _bad("The plan references a column that does not exist in this dataset.")
    return name


def _missing(series: pd.Series) -> pd.Series:
    return series.isna() | series.map(lambda value: isinstance(value, str) and not value.strip())


def _numeric(series: pd.Series, column: str) -> pd.Series:
    values = pd.to_numeric(series, errors="coerce")
    present = ~_missing(series)
    if int(values.notna().sum()) != int(present.sum()) or values.notna().sum() == 0:
        _bad(f"Column '{column}' must contain numeric values for this operation.")
    return values


def _aggregate(series: pd.Series, aggregation: str, column: str | None = None) -> Any:
    if aggregation not in AGGREGATIONS:
        _bad("Choose a supported aggregation.")
    if aggregation == "count":
        return int((~_missing(series)).sum())
    if column is None:
        _bad("This aggregation requires a metric column.")
    values = _numeric(series, column)
    if aggregation == "sum": return _safe(float(values.sum()))
    if aggregation in ("average", "mean"): return _safe(float(values.mean()))
    if aggregation == "min": return _safe(float(values.min()))
    if aggregation == "max": return _safe(float(values.max()))
    return _safe(float(values.median()))


def _apply_filters(frame: pd.DataFrame, filters: Any) -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    if filters is None: return frame, []
    if not isinstance(filters, list) or len(filters) > 20:
        _bad("Filters must be a list with no more than 20 conditions.")
    output = frame
    applied = []
    for item in filters:
        if not isinstance(item, dict) or set(item) - FILTER_KEYS or not {"column", "operator"} <= set(item):
            _bad("Each filter must contain only a column, operator, and optional value.")
        column = _column(output, item["column"])
        operator = item["operator"]
        if not isinstance(operator, str) or operator not in FILTER_OPERATORS: _bad("Choose a supported filter operator.")
        value = item.get("value")
        series = output[column]
        if operator == "is_null": mask = _missing(series)
        elif operator == "not_null": mask = ~_missing(series)
        elif operator in ("eq", "ne"):
            if value is None: _bad("Use is_null or not_null to filter missing values.")
            if isinstance(value, (dict, list)) or isinstance(value, str) and len(value) > 500 or isinstance(value, float) and not math.isfinite(value): _bad("Equality filters require a simple value no longer than 500 characters.")
            numeric = pd.to_numeric(series, errors="coerce")
            present = ~_missing(series)
            if numeric.notna().sum() == present.sum() and numeric.notna().sum() > 0 and not isinstance(value, bool):
                try: target = float(value)
                except (TypeError, ValueError): target = value
                left = numeric
            else:
                left, target = series, value
            mask = (left.eq(target) if operator == "eq" else left.ne(target)) & ~_missing(series)
        elif operator == "contains":
            if not isinstance(value, str) or len(value) > 200: _bad("Contains filters require a text value up to 200 characters.")
            mask = series.astype("string").str.contains(value, regex=False, na=False) & ~_missing(series)
        elif operator == "in":
            if not isinstance(value, list) or not value or len(value) > 100 or any(isinstance(v, (dict, list)) or isinstance(v, str) and len(v) > 500 or isinstance(v, float) and not math.isfinite(v) for v in value):
                _bad("An in filter requires between 1 and 100 simple values.")
            mask = series.isin(value) & ~_missing(series)
        else:
            if isinstance(value, (dict, list, bool)) or value is None or isinstance(value, str) and len(value) > 500 or isinstance(value, float) and not math.isfinite(value): _bad("Range filters require a finite number or date string.")
            numeric = pd.to_numeric(series, errors="coerce")
            present = ~_missing(series)
            if numeric.notna().sum() == present.sum() and numeric.notna().sum() > 0:
                try: target = float(value)
                except (TypeError, ValueError): _bad("This numeric column requires a numeric filter value.")
                left = numeric
            else:
                parsed = pd.to_datetime(series, errors="coerce", format="mixed")
                if parsed.notna().sum() != present.sum() or parsed.notna().sum() == 0: _bad("Range filters require a numeric or date column.")
                target = pd.to_datetime(value, errors="coerce", format="mixed")
                if pd.isna(target): _bad("This date column requires a valid date filter value.")
                left = parsed
            mask = {"gt": left > target, "gte": left >= target, "lt": left < target, "lte": left <= target}[operator]
        output = output.loc[mask].copy()
        applied.append({"column": column, "operator": operator, **({"value": value} if "value" in item else {})})
    return output, applied


def validate_plan(frame: pd.DataFrame, plan: Any) -> dict[str, Any]:
    if not isinstance(plan, dict) or set(plan) - PLAN_KEYS:
        _bad("The analysis plan is malformed or contains unsupported fields.")
    operation = plan.get("operation")
    if not isinstance(operation, str) or operation not in OPERATIONS: _bad("Choose a supported analysis operation.")
    if set(plan) - {"operation"} - OPERATION_KEYS[operation]: _bad("The plan contains fields that do not apply to this operation.")
    normalized = dict(plan)
    normalized["operation"] = operation
    if "limit" in plan and (not isinstance(plan["limit"], int) or isinstance(plan["limit"], bool) or not 1 <= plan["limit"] <= MAX_LIMIT):
        _bad(f"Result limits must be between 1 and {MAX_LIMIT}.")
    if "page" in plan and (not isinstance(plan["page"], int) or isinstance(plan["page"], bool) or plan["page"] < 1): _bad("Page must be a positive integer.")
    if "pageSize" in plan and (not isinstance(plan["pageSize"], int) or isinstance(plan["pageSize"], bool) or not 1 <= plan["pageSize"] <= MAX_PAGE_SIZE): _bad(f"Page size must be between 1 and {MAX_PAGE_SIZE}.")
    if "aggregation" in plan and (not isinstance(plan["aggregation"], str) or plan["aggregation"] not in AGGREGATIONS): _bad("Choose a supported aggregation.")
    if "column" in plan: normalized["column"] = _column(frame, plan["column"])
    if "groupBy" in plan: normalized["groupBy"] = _column(frame, plan["groupBy"])
    if "dateColumn" in plan: normalized["dateColumn"] = _column(frame, plan["dateColumn"])
    if "columns" in plan:
        cols = plan["columns"]
        minimum = 2 if operation == "correlation" else 1
        maximum = MAX_CORRELATION_COLUMNS if operation == "correlation" else MAX_COLUMNS_FOR_ROWS
        if not isinstance(cols, list) or len(cols) < minimum or len(cols) > maximum or any(not isinstance(col, str) for col in cols) or len(set(cols)) != len(cols): _bad(f"Select {minimum}–{maximum} distinct columns.")
        normalized["columns"] = [_column(frame, col) for col in cols]
    if operation in ("group_by", "compare") and "groupBy" not in normalized: _bad("This operation requires a grouping column.")
    if operation in ("group_by", "trend", "compare") and "aggregation" not in normalized: _bad("This operation requires an aggregation.")
    if operation in ("group_by", "trend", "compare") and normalized.get("aggregation") != "count" and "column" not in normalized: _bad("This aggregation requires a metric column.")
    if operation in ("group_by", "trend", "compare") and normalized.get("aggregation") != "count":
        _numeric(frame[normalized["column"]], normalized["column"])
    if operation == "sort_top":
        if "column" not in normalized: _bad("Sorting requires a column.")
        if plan.get("direction", "desc") not in ("asc", "desc"): _bad("Sort direction must be asc or desc.")
    if operation == "trend":
        if "dateColumn" not in normalized or not isinstance(plan.get("granularity"), str) or plan.get("granularity") not in GRANULARITIES: _bad("Trend requires a date column and daily, monthly, quarterly, or yearly granularity.")
        dates = pd.to_datetime(frame[normalized["dateColumn"]], errors="coerce", format="mixed")
        present = ~_missing(frame[normalized["dateColumn"]])
        if dates.notna().sum() != present.sum() or dates.notna().sum() == 0: _bad("Trend date column contains values that cannot be parsed as dates.")
    if operation == "compare":
        values = plan.get("values")
        if not isinstance(values, list) or len(values) != 2 or values[0] == values[1] or any(isinstance(v, (dict, list)) for v in values): _bad("Comparison requires exactly two distinct category values.")
        normalized["values"] = values
    if operation == "correlation":
        if "columns" not in normalized: _bad("Correlation requires at least two numeric columns.")
        for name in normalized["columns"]: _numeric(frame[name], name)
    if operation == "rows" and "columns" in plan:
        if not isinstance(plan["columns"], list) or not plan["columns"]: _bad("Choose at least one output column.")
        normalized["columns"] = [_column(frame, name) for name in plan["columns"]]
    if operation == "rows" and "column" in plan:
        normalized["column"] = _column(frame, plan["column"])
        if plan.get("direction", "asc") not in ("asc", "desc"): _bad("Sort direction must be asc or desc.")
    return normalized


def _records(frame: pd.DataFrame) -> list[dict[str, Any]]:
    clean = frame.astype(object).where(pd.notna(frame), None)
    return [{str(key): _safe(value) for key, value in row.items()} for row in clean.to_dict(orient="records")]


def _safe(value: Any) -> Any:
    if value is None: return None
    if hasattr(value, "isoformat"): return value.isoformat()
    if hasattr(value, "item"): value = value.item()
    if isinstance(value, float) and not np.isfinite(value): return None
    if isinstance(value, (str, int, float, bool)): return value
    return str(value)


def run_plan(frame: pd.DataFrame, raw_plan: Any) -> dict[str, Any]:
    plan = validate_plan(frame, raw_plan)
    filtered, applied_filters = _apply_filters(frame, plan.get("filters"))
    operation = plan["operation"]
    result: dict[str, Any] = {"operation": operation, "rowCount": int(len(filtered)), "appliedFilters": applied_filters, "warnings": []}
    if operation == "summary":
        names = [plan["column"]] if "column" in plan else list(filtered.columns)
        summaries = []
        for name in names:
            values = filtered[name]
            item: dict[str, Any] = {"column": name, "inferredType": "string", "count": int((~_missing(values)).sum()), "missingCount": int(_missing(values).sum()), "distinctCount": int(values[~_missing(values)].nunique())}
            numeric = pd.to_numeric(values, errors="coerce")
            if numeric.notna().sum() == (~_missing(values)).sum() and numeric.notna().sum() > 0:
                item["inferredType"] = "numeric"
                item["statistics"] = {"min": _safe(float(numeric.min())), "max": _safe(float(numeric.max())), "mean": _safe(float(numeric.mean())), "median": _safe(float(numeric.median())), "sum": _safe(float(numeric.sum())), "standardDeviation": _safe(float(numeric.std())) if len(numeric.dropna()) > 1 else None}
            summaries.append(item)
        result["columns"] = summaries
    elif operation == "missing":
        names = [plan["column"]] if "column" in plan else list(filtered.columns)
        result["columns"] = [{"column": name, "missingCount": int(_missing(filtered[name]).sum()), "missingPercent": round(float(_missing(filtered[name]).mean() * 100), 2) if len(filtered) else 0} for name in names]
    elif operation == "duplicates":
        result["duplicateRowCount"] = int(filtered.duplicated().sum())
        result["sample"] = _records(filtered.loc[filtered.duplicated(keep=False)].head(plan.get("limit", 10)))
    elif operation == "correlation":
        result["columns"] = plan["columns"]
        if filtered.empty:
            result["matrix"] = [[None for _ in plan["columns"]] for _ in plan["columns"]]
        else:
            values = pd.DataFrame({name: _numeric(filtered[name], name) for name in plan["columns"]})
            matrix = values.corr().replace([np.inf, -np.inf], np.nan)
            result["matrix"] = [[_safe(value) for value in row] for row in matrix.values.tolist()]
        result["warnings"].append("Correlation describes association in this dataset and does not establish causation.")
    elif operation == "rows":
        names = plan.get("columns", list(filtered.columns))
        page, size = plan.get("page", 1), plan.get("pageSize", 50)
        start = (page - 1) * size
        ordered = filtered.sort_values(plan["column"], ascending=plan.get("direction", "asc") == "asc", kind="mergesort", na_position="last") if "column" in plan else filtered
        result.update({"columns": names, "page": page, "pageSize": size, "totalRows": int(len(filtered)), "rows": _records(ordered.loc[:, names].iloc[start:start + size])})
    elif operation == "sort_top":
        direction = plan.get("direction", "desc")
        ordered = filtered.sort_values(plan["column"], ascending=direction == "asc", kind="mergesort", na_position="last")
        result.update({"column": plan["column"], "direction": direction, "rows": _records(ordered.head(plan.get("limit", 10)))})
    elif operation in ("group_by", "compare"):
        dimension, metric, aggregation = plan["groupBy"], plan.get("column"), plan["aggregation"]
        groups = []
        for key, rows in filtered.groupby(dimension, dropna=False, sort=False):
            safe_key = _safe(key)
            if operation == "compare" and safe_key not in plan["values"]: continue
            value = int(len(rows)) if aggregation == "count" else _aggregate(rows[metric] if metric else rows[dimension], aggregation, metric)
            groups.append({"group": safe_key, "value": value, "rowCount": int(len(rows))})
        if operation == "compare":
            groups.sort(key=lambda item: plan["values"].index(item["group"]) if item["group"] in plan["values"] else 2)
        else:
            groups.sort(key=lambda item: (item["value"] is None, str(item["group"])))
            groups = groups[:plan.get("limit", MAX_LIMIT)]
        result.update({"groupBy": dimension, "column": metric, "aggregation": aggregation, "groups": groups})
    elif operation == "trend":
        name = plan["dateColumn"]
        dates = pd.to_datetime(filtered[name], errors="coerce", format="mixed")
        if filtered.empty:
            result.update({"dateColumn": name, "granularity": plan["granularity"], "column": plan.get("column"), "aggregation": plan["aggregation"], "points": []})
            return result
        missing_dates = int(dates.isna().sum())
        if missing_dates: result["warnings"].append(f"{missing_dates} row(s) with missing dates were omitted from this trend.")
        valid_rows = filtered.loc[dates.notna()].copy()
        valid_dates = dates.loc[dates.notna()]
        periods = {"daily": valid_dates.dt.strftime("%Y-%m-%d"), "monthly": valid_dates.dt.strftime("%Y-%m"), "quarterly": valid_dates.dt.to_period("Q").astype(str), "yearly": valid_dates.dt.strftime("%Y")}[plan["granularity"]]
        work = valid_rows.assign(__period=periods)
        metric, aggregation = plan.get("column"), plan["aggregation"]
        groups = []
        for key, rows in work.groupby("__period", dropna=False, sort=True):
            groups.append({"period": str(key), "value": int(len(rows)) if aggregation == "count" else _aggregate(rows[metric] if metric else rows["__period"], aggregation, metric), "rowCount": int(len(rows))})
        result.update({"dateColumn": name, "granularity": plan["granularity"], "column": metric, "aggregation": aggregation, "points": groups[:MAX_LIMIT]})
    try:
        result_size = len(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8"))
    except (TypeError, ValueError):
        _bad("The plan produced an unsupported result value.")
    if result_size > MAX_RESULT_BYTES: raise HTTPException(status_code=413, detail="The analysis result is larger than the 5 MB response limit. Reduce the row or result limit.")
    return result


def export_csv(frame: pd.DataFrame, raw_plan: Any) -> bytes:
    plan = validate_plan(frame, raw_plan)
    operation = plan["operation"]
    if operation == "rows":
        filtered, _ = _apply_filters(frame, plan.get("filters"))
        names = plan.get("columns", list(filtered.columns))
        if "column" in plan:
            filtered = filtered.sort_values(plan["column"], ascending=plan.get("direction", "asc") == "asc", kind="mergesort", na_position="last")
        output = filtered.loc[:, names].copy()
    else:
        result = run_plan(frame, plan)
        if operation in ("group_by", "compare"):
            output = pd.DataFrame(result.get("groups", []))
        elif operation == "trend":
            output = pd.DataFrame(result.get("points", []))
        elif operation in ("summary", "missing"):
            output = pd.DataFrame(result.get("columns", []))
        elif operation == "duplicates":
            output = pd.DataFrame([{"duplicateRowCount": result.get("duplicateRowCount", 0)}])
        elif operation == "sort_top":
            output = pd.DataFrame(result.get("rows", []))
        elif operation == "correlation":
            names = result.get("columns", [])
            output = pd.DataFrame(result.get("matrix", []), index=names, columns=names).rename_axis("column").reset_index()
        else:
            _bad("This analysis cannot be exported as a CSV table.")
    if len(output) * max(1, len(output.columns)) > MAX_EXPORT_CELLS:
        raise HTTPException(status_code=413, detail="The export exceeds the supported row and column limit.")
    for name in output.select_dtypes(include="object").columns:
        output[name] = output[name].map(lambda value: "'" + value if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")) else value)
    stream = io.StringIO(newline="")
    output.to_csv(stream, index=False, na_rep="")
    data = stream.getvalue().encode("utf-8-sig")
    if len(data) > MAX_EXPORT_BYTES:
        raise HTTPException(status_code=413, detail="The CSV export exceeds the 10 MB limit. Add filters or select fewer columns.")
    return data
