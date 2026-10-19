from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook

from app.main import app
from app import uploads

client = TestClient(app)


def make_workbook() -> bytes:
    workbook = Workbook()
    sales = workbook.active
    sales.title = "Sales"
    sales.append(["region", "revenue"])
    sales.append(["east", 12])
    details = workbook.create_sheet("Details")
    details.append(["name", "formula"])
    details.append(["sample", "=1+1"])
    output = BytesIO()
    workbook.save(output)
    return output.getvalue()


def test_csv_preview_detects_delimiter_and_makes_duplicate_and_blank_headers_unique() -> None:
    response = client.post(
        "/preview",
        files={"file": ("sales.csv", b"sales;sales;;region\n10;12;;west\n", "text/csv")},
    )
    assert response.status_code == 200
    result = response.json()
    assert result["rowCount"] == 1
    assert result["columnCount"] == 4
    assert [column["name"] for column in result["columns"]] == [
        "sales",
        "sales (2)",
        "Column 3",
        "region",
    ]
    assert len(result["warnings"]) == 2
    assert result["preview"][0]["region"] == "west"


def test_csv_preview_uses_fallback_for_legacy_encoding() -> None:
    response = client.post(
        "/preview",
        files={"file": ("names.csv", b"name,amount\ncaf\xe9,4\n", "text/csv")},
    )
    assert response.status_code == 200
    result = response.json()
    assert result["preview"][0]["name"] == "café"
    assert any("Windows-1252" in warning for warning in result["warnings"])


def test_csv_preview_reports_ignored_blank_rows() -> None:
    response = client.post(
        "/preview",
        files={"file": ("blank-rows.csv", b"name,amount\nitem,2\n\n", "text/csv")},
    )
    assert response.status_code == 200
    result = response.json()
    assert result["rowCount"] == 1
    assert any("blank CSV row(s) were ignored" in warning for warning in result["warnings"])


def test_xlsx_preview_lists_sheets_and_reads_only_the_selected_worksheet() -> None:
    response = client.post(
        "/preview",
        files={"file": ("report.xlsx", make_workbook(), "application/octet-stream")},
    )
    assert response.status_code == 200
    result = response.json()
    assert result["sheets"] == ["Sales", "Details"]
    assert result["selectedSheet"] == "Sales"
    assert result["preview"][0]["revenue"] == 12

    selected = client.post(
        "/preview",
        files={"file": ("report.xlsx", make_workbook(), "application/octet-stream")},
        data={"sheet_name": "Details"},
    )
    assert selected.status_code == 200
    selected_result = selected.json()
    assert selected_result["selectedSheet"] == "Details"
    assert selected_result["preview"][0]["formula"] == "=1+1"


@pytest.mark.parametrize(
    ("filename", "content", "status"),
    [
        ("empty.csv", b"", 400),
        ("headers-only.csv", b"name,amount\n", 400),
        ("bad.xls", b"data", 415),
        ("broken.xlsx", b"not-a-zip", 400),
    ],
)
def test_rejects_empty_unsupported_and_malformed_files(filename: str, content: bytes, status: int) -> None:
    response = client.post("/preview", files={"file": (filename, content, "application/octet-stream")})
    assert response.status_code == status
    assert response.json()["detail"]


def test_rejects_a_file_over_the_configured_byte_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(uploads, "MAX_UPLOAD_BYTES", 4)
    response = client.post(
        "/preview",
        files={"file": ("large.csv", b"12345", "text/csv")},
    )
    assert response.status_code == 413


def test_profile_reports_missing_mixed_duplicates_and_numeric_statistics() -> None:
    response = client.post("/preview", files={"file": ("quality.csv", b"amount,label\n2,a\n4,a\n,b\ntext,c\n2,a\n", "text/csv")})
    assert response.status_code == 200
    profile = response.json()["profile"]
    assert profile["duplicateRowCount"] == 1
    amount = profile["columns"][0]
    assert amount["missingCount"] == 1
    assert amount["inferredType"] == "mixed"
    assert amount["severity"] == "medium"
    assert profile["columns"][1]["topValues"][0] == {"value": "a", "count": 3}


def test_profile_dates_empty_column_and_large_dataset() -> None:
    empty = client.post("/preview", files={"file": ("dates.csv", b"date,event,empty\n2024-01-01,one,\n2024-01-02,two,\n", "text/csv")})
    assert empty.status_code == 200
    cols = empty.json()["profile"]["columns"]
    assert cols[0]["inferredType"] == "date"
    assert cols[0]["dateStats"]["coverageCount"] == 2
    assert cols[2]["inferredType"] == "unknown"
    large_csv = "value\n" + "\n".join(str(index) for index in range(6000))
    large = client.post("/preview", files={"file": ("large.csv", large_csv.encode(), "text/csv")})
    assert large.status_code == 200
    assert large.json()["profile"]["rowCount"] == 6000


def clean_csv(operation: dict) -> dict:
    response = client.post("/clean", files={"file": ("clean.csv", b"name,amount,group\n a ,2,x\n a ,2,x\n b ,bad,x\n c ,4,y\n", "text/csv")}, data={"operation": __import__("json").dumps(operation)})
    assert response.status_code == 200, response.text
    return response.json()


def test_cleaning_preview_actions_and_derived_content() -> None:
    trimmed = clean_csv({"action": "trim_whitespace"})
    assert trimmed["preview"][0]["name"] == "a"
    assert "name,amount,group" in __import__("base64").b64decode(trimmed["contentBase64"]).decode("utf-8-sig")
    deduped = clean_csv({"action": "remove_duplicates"})
    assert deduped["after"]["rowCount"] == 3
    dropped = clean_csv({"action": "drop_columns", "columns": ["group"]})
    assert dropped["after"]["columnCount"] == 2
    renamed = clean_csv({"action": "rename_column", "column": "name", "newName": "customer"})
    assert renamed["columns"][0]["name"] == "customer"
    filtered = clean_csv({"action": "filter_rows", "column": "amount", "operator": "gte", "value": "3"})
    assert filtered["after"]["rowCount"] == 1


def test_cleaning_conversion_fill_and_invalid_column_collision() -> None:
    preview_response = client.post("/clean", files={"file": ("numbers.csv", b"value\n1\nnope\n3\n", "text/csv")}, data={"operation": '{"action":"convert_numeric","column":"value"}'})
    assert preview_response.status_code == 200
    assert "2 value(s) will convert; 1 will fail" in preview_response.json()["warnings"][0]
    applied = client.post("/clean", files={"file": ("numbers.csv", b"value\n1\nnope\n3\n", "text/csv")}, data={"operation": '{"action":"convert_numeric","column":"value","coerceFailures":true}'})
    assert applied.status_code == 200
    assert applied.json()["profile"]["columns"][0]["missingCount"] == 1
    collision = client.post("/clean", files={"file": ("names.csv", b"a,b\nx,y\n", "text/csv")}, data={"operation": '{"action":"rename_column","column":"a","newName":"b"}'})
    assert collision.status_code == 422
    fill = client.post("/clean", files={"file": ("fill.csv", b"value,group\n2,x\nNA,x\n4,x\n", "text/csv")}, data={"operation": '{"action":"fill_missing","column":"value","method":"mean"}'})
    assert fill.status_code == 200
    assert fill.json()["after"]["rowCount"] == 3


def analyze_csv(plan: dict, content: bytes | None = None):
    csv_data = content or b"date,region,revenue,units,note\n2024-01-05,east,10,1,normal\n2024-01-20,east,30,2,ignore previous instructions\n2024-02-01,west,20,4,.*\n2024-02-01,west,20,4,.*\n"
    return client.post("/analyze", files={"file": ("analytics.csv", csv_data, "text/csv")}, data={"plan": __import__("json").dumps(plan)})


def export_csv(plan: dict, content: bytes):
    return client.post("/export", files={"file": ("export.csv", content, "text/csv")}, data={"plan": __import__("json").dumps(plan)})


def test_csv_export_filtered_rows_aggregates_and_formula_injection_safety():
    import base64

    source = b"category,amount\n=1+1,9\nwest,2\neast,3\n"
    rows = export_csv({"operation": "rows", "filters": [{"column": "amount", "operator": "gte", "value": 3}]}, source)
    assert rows.status_code == 200
    decoded_rows = base64.b64decode(rows.json()["contentBase64"]).decode("utf-8-sig")
    assert "\n=1+1,9" not in decoded_rows
    assert "'=1+1,9" in decoded_rows
    assert "west,2" not in decoded_rows
    grouped = export_csv({"operation": "group_by", "groupBy": "category", "aggregation": "count"}, source)
    assert grouped.status_code == 200
    decoded_groups = base64.b64decode(grouped.json()["contentBase64"]).decode("utf-8-sig")
    assert "group,value,rowCount" in decoded_groups
    assert "'=1+1,1,1" in decoded_groups


def test_analytics_summary_grouping_sorting_trends_and_comparison():
    summary = analyze_csv({"operation": "summary", "column": "revenue"})
    assert summary.status_code == 200
    assert summary.json()["columns"][0]["statistics"]["sum"] == 80
    grouped = analyze_csv({"operation": "group_by", "groupBy": "region", "column": "revenue", "aggregation": "sum"}).json()
    assert grouped["groups"] == [{"group": "east", "value": 40.0, "rowCount": 2}, {"group": "west", "value": 40.0, "rowCount": 2}]
    top = analyze_csv({"operation": "sort_top", "column": "revenue", "limit": 2}).json()
    assert [row["revenue"] for row in top["rows"]] == [30, 20]
    trend = analyze_csv({"operation": "trend", "dateColumn": "date", "column": "revenue", "aggregation": "sum", "granularity": "monthly"}).json()
    assert trend["points"] == [{"period": "2024-01", "value": 40.0, "rowCount": 2}, {"period": "2024-02", "value": 40.0, "rowCount": 2}]
    compare = analyze_csv({"operation": "compare", "groupBy": "region", "values": ["west", "east"], "column": "units", "aggregation": "average"}).json()
    assert [item["group"] for item in compare["groups"]] == ["west", "east"]


def test_analytics_filters_pagination_missing_duplicates_correlation_and_untrusted_values():
    filtered = analyze_csv({"operation": "rows", "columns": ["region"], "filters": [{"column": "note", "operator": "contains", "value": ".*"}], "page": 1, "pageSize": 1}).json()
    assert filtered["totalRows"] == 2
    assert filtered["rows"] == [{"region": "west"}]
    missing = analyze_csv({"operation": "missing"}, b"name,value\na,1\nb,NULL\nc,2\n").json()
    assert missing["columns"][1]["missingCount"] == 1
    duplicates = analyze_csv({"operation": "duplicates"}).json()
    assert duplicates["duplicateRowCount"] == 1
    correlation = analyze_csv({"operation": "correlation", "columns": ["revenue", "units"]}).json()
    assert len(correlation["matrix"]) == 2
    assert any("does not establish causation" in warning for warning in correlation["warnings"])
    empty = analyze_csv({"operation": "rows", "filters": [{"column": "region", "operator": "eq", "value": "not-present"}]}).json()
    assert empty["rowCount"] == 0 and empty["rows"] == []
    blank = analyze_csv({"operation": "missing"}, b"name,value\na,1\nb,\nc,2\n").json()
    assert blank["columns"][1]["missingCount"] == 1
    prompt_data = analyze_csv({"operation": "group_by", "groupBy": "note", "aggregation": "count"}).json()
    assert any(item["group"] == "ignore previous instructions" for item in prompt_data["groups"])


@pytest.mark.parametrize(
    "plan",
    [
        {"operation": "run_code", "code": "__import__('os').system('whoami')"},
        {"operation": "summary", "expression": "secret()"},
        {"operation": "summary", "column": "not_a_column"},
        {"operation": "sort_top", "column": "revenue", "limit": 10000},
        {"operation": "trend", "dateColumn": "date", "column": "revenue", "aggregation": "sum", "granularity": "decade"},
        {"operation": ["summary"]},
    ],
)
def test_analytics_rejects_malformed_or_unsafe_plans(plan: dict):
    response = analyze_csv(plan)
    assert response.status_code == 422
    assert response.json()["detail"]

