"""Prepare a reviewed rfd_name-only plan; apply only its explicitly approved SHA-256."""

import argparse
import hashlib
import hmac
import importlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID


PROJECT = Path(__file__).resolve().parents[1]
AUTH_SCRIPTS = Path(
    r"C:\Users\simoncook\OneDrive - Microsoft\Documents\Microsoft Scout\scripts"
)
SCHEMA = AUTH_SCRIPTS.parent / "RetailFinanceDemo" / "financial_account_schema.proposed.json"
PLAN_PATH = PROJECT / "docs" / "financial-account-name-changes.json"
URL = "https://smc-diamond-service.crm.dynamics.com"
ENVIRONMENT_ID = "b17908ad-6b6b-eefb-98bc-79cc7e20ab08"
TENANT_ID = "fc547a7e-3617-4e9c-a506-83fa37eb5247"
ORGANIZATION_ID = "d594142a-e0b5-f111-8add-6045bd02251f"
USER_ID = "0a61bb38-ef8b-f111-8076-7ced8d3c0da2"
USER_NAME = "admin@diax47618638.onmicrosoft.com"
SOLUTION = "RetailFinanceDemo"
TABLE = "rfd_financialaccount"
ID = "rfd_financialaccountid"
NAME = "rfd_name"
CARD_TYPES = {100000006, 100000007}
PROTECTED_FIELDS = [
    "rfd_holdingnumber", "rfd_producttype", "rfd_accountnumber", "rfd_cardlastfour",
    "_rfd_productid_value", "_rfd_customerid_value",
    "_rfd_linkedfinancialaccountid_value", "statecode", "statuscode",
]
READ_FIELDS = [ID, NAME, *PROTECTED_FIELDS, "versionnumber"]
RULES = {
    "label": "Use the linked product catalogue label; otherwise use the existing holding name.",
    "cleanup": "Strip leading Demo and trailing DEMO-CUST/DEMO-HLD references; replace leading Diamond with Gravity.",
    "natural_current_account": "Expand a terminal Current to Current Account.",
    "branding": "Prefix Gravity if the cleaned label has no Gravity brand.",
    "cards": "For Debit card/Credit card instruments use the existing four-digit rfd_cardlastfour only.",
    "bank_accounts": "For non-card instruments use only the last four of an existing eight-digit numeric rfd_accountnumber.",
    "missing_references": "Omit the ending suffix when unavailable; never use MTG-/LOAN- system references or invent numbers.",
    "suffix": "Append ' ending ####' when a permitted existing suffix is available.",
    "uniqueness": "Display names need not be globally unique.",
}


class PlanError(Exception):
    """An error whose message is safe to display without source financial data."""


def digest(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def record_id(value):
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError) as exc:
        raise PlanError("An invalid record GUID was encountered.") from exc


def schema_max_length(path):
    schema = json.loads(path.read_text(encoding="utf-8"))
    if (
        schema.get("environment_url") != URL
        or schema.get("environment_id") != ENVIRONMENT_ID
        or schema.get("solution") != SOLUTION
        or schema.get("publisher_prefix") != "rfd"
        or schema.get("table", {}).get("logical_name") != TABLE
        or schema.get("table", {}).get("primary_name") != NAME
    ):
        raise PlanError("The approved local schema does not match the target.")
    columns = [c for c in schema["columns"] if c["schema_name"] == "rfd_Name"]
    if len(columns) != 1 or columns[0].get("type") != "string":
        raise PlanError("The approved name column is unavailable.")
    maximum = columns[0].get("max_length")
    if not isinstance(maximum, int) or maximum <= 0:
        raise PlanError("The approved name MaxLength is invalid.")
    return maximum


def load_auth(path):
    if not (path / "auth.py").is_file():
        raise PlanError("The initialized SDK auth.py was not found.")
    sys.path.insert(0, str(path.resolve()))
    auth = importlib.import_module("auth")
    auth.load_env()
    if (
        os.environ.get("DATAVERSE_URL", "").rstrip("/") != URL
        or os.environ.get("TENANT_ID") != TENANT_ID
        or os.environ.get("SOLUTION_NAME") != SOLUTION
        or os.environ.get("PUBLISHER_PREFIX") != "rfd"
    ):
        raise PlanError("Initialized auth targets a different environment/solution/publisher.")
    return auth.get_client


def preflight(client):
    # eq-userid is evaluated by Dataverse, not inferred from a cached token.
    users = list(client.query.fetchxml(
        '<fetch><entity name="systemuser"><attribute name="systemuserid"/>'
        '<attribute name="domainname"/><filter>'
        '<condition attribute="systemuserid" operator="eq-userid"/>'
        '</filter></entity></fetch>'
    ).execute())
    if (
        len(users) != 1
        or record_id(users[0]["systemuserid"]) != USER_ID
        or (users[0].get("domainname") or "").casefold() != USER_NAME.casefold()
    ):
        raise PlanError("The authenticated Dataverse user differs from the approved admin.")
    organizations = list(client.records.list("organization", select=["organizationid"]))
    if len(organizations) != 1 or record_id(organizations[0]["organizationid"]) != ORGANIZATION_ID:
        raise PlanError("The organization differs from the approved environment.")
    solutions = list(client.records.list(
        "solution", filter=f"uniquename eq '{SOLUTION}'",
        select=["solutionid", "_publisherid_value", "ismanaged"],
    ))
    if len(solutions) != 1 or solutions[0].get("ismanaged") is not False:
        raise PlanError("The approved unmanaged solution is unavailable.")
    publisher = client.records.retrieve(
        "publisher", solutions[0]["_publisherid_value"], select=["customizationprefix"]
    )
    if publisher.get("customizationprefix") != "rfd":
        raise PlanError("The approved solution publisher does not match.")


def read_snapshot(client):
    rows = {}
    for record in client.records.list(TABLE, select=READ_FIELDS, orderby=[f"{ID} asc"]):
        row = {field: record.get(field) for field in READ_FIELDS}
        key = record_id(row[ID])
        row[ID] = key
        for field in PROTECTED_FIELDS:
            if field.startswith("_") and row[field] is not None:
                row[field] = record_id(row[field])
        if key in rows:
            raise PlanError("Duplicate financial-account GUIDs were returned.")
        rows[key] = row
    products = {}
    for product in client.records.list("product", select=["productid", "name"]):
        key = record_id(product["productid"])
        if key in products:
            raise PlanError("Duplicate product GUIDs were returned.")
        products[key] = product.get("name")
    return rows, products


def existing_suffix(row):
    if row.get("rfd_producttype") in CARD_TYPES:
        suffix = row.get("rfd_cardlastfour")
        if suffix is None or suffix == "":
            return None
        if not isinstance(suffix, str) or not re.fullmatch(r"[0-9]{4}", suffix):
            raise PlanError("A card suffix is not four existing digits.")
        return suffix
    number = row.get("rfd_accountnumber")
    if isinstance(number, str) and re.fullmatch(r"[0-9]{8}", number):
        return number[-4:]
    return None


def clean_label(value):
    if not isinstance(value, str) or not value.strip():
        raise PlanError("A required product/holding label is missing.")
    label = re.sub(r"\s+", " ", value).strip()
    label = re.sub(
        r"\s*[-\u2013\u2014|:]\s*DEMO-(?:CUST|HLD)-[A-Za-z0-9-]+\s*$",
        "", label, flags=re.IGNORECASE,
    ).strip()
    label = re.sub(r"^Demo\s+", "", label, flags=re.IGNORECASE)
    label = re.sub(r"^Diamond\b", "Gravity", label, flags=re.IGNORECASE)
    if re.search(r"\bCurrent$", label, re.IGNORECASE):
        label += " Account"
    if not re.match(r"^Gravity\b", label, re.IGNORECASE):
        label = "Gravity " + label
    if re.search(r"\bDEMO-(?:CUST|HLD)-|\bDemo\b", label, re.IGNORECASE):
        raise PlanError("A synthetic reference remains in a proposed display label.")
    return label


def target_from_source_name(row):
    suffix = existing_suffix(row)
    ending = f" ending {suffix}" if suffix else ""
    source = row.get(NAME)
    if isinstance(source, str) and ending and source.endswith(ending):
        source = source[:-len(ending)]
    return clean_label(source) + ending


def target_name(row, products, maximum):
    product_id = row.get("_rfd_productid_value")
    if product_id:
        if product_id not in products:
            raise PlanError("A linked product is missing from the live catalogue.")
        suffix = existing_suffix(row)
        target = clean_label(products[product_id]) + (f" ending {suffix}" if suffix else "")
    else:
        target = target_from_source_name(row)
    if len(target) > maximum:
        raise PlanError("A target name exceeds the approved name MaxLength.")
    if target_from_source_name(row) != target:
        raise PlanError("An existing source name no longer agrees with its product and permitted suffix.")
    return target


def source_digest(rows, products):
    used_products = sorted({
        row["_rfd_productid_value"] for row in rows.values() if row["_rfd_productid_value"]
    })
    return digest({
        "rows": [
            {ID: key, **{field: rows[key][field] for field in PROTECTED_FIELDS}}
            for key in sorted(rows)
        ],
        "product_labels": [
            {"productid": key, "name": products.get(key)} for key in used_products
        ],
    })


def prepare_plan(rows, products, maximum):
    records = [
        {"record_id": key, "new_name": target_name(rows[key], products, maximum)}
        for key in sorted(rows)
    ]
    plan = {
        "plan_version": 1,
        "status": "Prepared for review; no live updates performed.",
        "prepared_at_utc": datetime.now(timezone.utc).isoformat(),
        "environment_url": URL,
        "environment_id": ENVIRONMENT_ID,
        "identity": USER_NAME,
        "solution": SOLUTION,
        "publisher_prefix": "rfd",
        "table": TABLE,
        "scope": [NAME],
        "count": len(records),
        "prepared_change_count": sum(rows[r["record_id"]][NAME] != r["new_name"] for r in records),
        "name_max_length": maximum,
        "reference_rules": RULES,
        "source_sha256": source_digest(rows, products),
        "source_guard": "Hash of protected fields and linked product labels; old names/numbers are not exported. Current names must still derive the same target or already equal it.",
        "apply_protection": "Require the reviewed SHA-256; reread live sources and pending row versions before each batch; verify names and protected fields after every batch; skip names already at target.",
        "concurrency_limit": "The supported SDK bulk update has no conditional ETag/row-version parameter and is not atomic. Use a quiet editing window. A change between the final read and write cannot be atomically excluded; no automatic rollback is attempted.",
        "system_metadata": "Dataverse modifiedon/modifiedby/versionnumber and normal audit history may change when a name is updated.",
        "digest_rule": "sha256 is SHA-256 of the entire JSON object except sha256, serialized with sorted keys, UTF-8, ensure_ascii=False and separators=(',', ':').",
        "records": records,
    }
    plan["sha256"] = digest(plan)
    return plan


def validate_plan(plan, maximum, expected_sha256):
    if not isinstance(plan, dict):
        raise PlanError("The plan is not a JSON object.")
    actual = digest({key: value for key, value in plan.items() if key != "sha256"})
    if (
        not isinstance(expected_sha256, str)
        or not re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha256)
        or not hmac.compare_digest(actual, expected_sha256.lower())
        or plan.get("sha256") != actual
    ):
        raise PlanError("The plan does not match the explicitly approved SHA-256.")
    expected = {
        "plan_version": 1, "environment_url": URL, "environment_id": ENVIRONMENT_ID,
        "identity": USER_NAME, "solution": SOLUTION, "publisher_prefix": "rfd",
        "table": TABLE, "scope": [NAME], "name_max_length": maximum,
        "reference_rules": RULES,
    }
    if any(plan.get(key) != value for key, value in expected.items()):
        raise PlanError("The plan scope, environment or naming rules do not match this script.")
    records = plan.get("records")
    if not isinstance(records, list) or plan.get("count") != len(records):
        raise PlanError("The reviewed target count is invalid.")
    targets = {}
    for record in records:
        if not isinstance(record, dict) or set(record) != {"record_id", "new_name"}:
            raise PlanError("Each target must contain only record_id and new_name.")
        key = record_id(record["record_id"])
        if key != record["record_id"] or key in targets:
            raise PlanError("A reviewed target GUID is duplicated or noncanonical.")
        name = record["new_name"]
        if not isinstance(name, str) or not name or len(name) > maximum:
            raise PlanError("A reviewed target name is invalid.")
        targets[key] = name
    return targets


def validate_live(plan, rows, products, targets, maximum):
    if set(rows) != set(targets):
        raise PlanError("The live financial-account GUID set/count changed; prepare a new review.")
    if source_digest(rows, products) != plan.get("source_sha256"):
        raise PlanError("Protected source data or a linked catalogue label changed; prepare a new review.")
    for key, row in rows.items():
        if target_name(row, products, maximum) != targets[key]:
            raise PlanError("Live source names no longer derive the reviewed target; prepare a new review.")


def apply_plan(read_client, write_factory, plan, targets, maximum, selected, batch_size):
    initial, products = read_snapshot(read_client)
    validate_live(plan, initial, products, targets, maximum)
    if not selected <= set(targets):
        raise PlanError("A requested surgical GUID is absent from the reviewed plan.")
    pending = sorted(key for key in selected if initial[key][NAME] != targets[key])
    updated = 0
    if pending:
        with write_factory("dv-data") as writer:
            for offset in range(0, len(pending), batch_size):
                current, products = read_snapshot(read_client)
                validate_live(plan, current, products, targets, maximum)
                batch = []
                for key in pending[offset:offset + batch_size]:
                    if current[key][NAME] == targets[key]:
                        continue
                    if (
                        current[key]["versionnumber"] is None
                        or current[key]["versionnumber"] != initial[key]["versionnumber"]
                    ):
                        raise PlanError("A pending row version changed; stop and review before retrying.")
                    batch.append(key)
                if batch:
                    writer.records.update(TABLE, batch, [{NAME: targets[key]} for key in batch])
                    updated += len(batch)
                    verified, products = read_snapshot(read_client)
                    validate_live(plan, verified, products, targets, maximum)
                    if any(verified[key][NAME] != targets[key] for key in batch):
                        raise PlanError("Live names did not match the reviewed targets after a batch.")
    final, products = read_snapshot(read_client)
    validate_live(plan, final, products, targets, maximum)
    if any(final[key][NAME] != targets[key] for key in selected):
        raise PlanError("Final verification found a selected name not at its target.")
    if any(final[key][NAME] != initial[key][NAME] for key in set(targets) - selected):
        raise PlanError("An unselected name changed during surgical apply; review concurrent edits.")
    return {"selected": len(selected), "updated": updated, "verified": len(selected)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--prepare", action="store_true", help="Read live data and write a review JSON only.")
    modes.add_argument("--apply", action="store_true", help="Apply only the reviewed rfd_name targets.")
    parser.add_argument("--plan", type=Path, default=PLAN_PATH)
    parser.add_argument("--auth-scripts-dir", type=Path, default=AUTH_SCRIPTS)
    parser.add_argument("--schema", type=Path, default=SCHEMA)
    parser.add_argument("--expected-sha256", help="Required approved plan digest for --apply.")
    parser.add_argument("--record-id", action="append", help="Apply only these GUIDs; repeatable.")
    parser.add_argument("--batch-size", type=int, default=25)
    parser.add_argument("--replace-plan", action="store_true", help="Explicitly replace an existing preview.")
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 50:
        parser.error("--batch-size must be between 1 and 50.")
    if args.prepare and (args.expected_sha256 or args.record_id):
        parser.error("--expected-sha256 and --record-id are apply-only.")
    if args.apply and (not args.expected_sha256 or args.replace_plan):
        parser.error("--apply requires --expected-sha256 and cannot use --replace-plan.")
    if args.prepare and args.plan.exists() and not args.replace_plan:
        parser.error("The review JSON already exists; use --replace-plan to prepare a new review.")
    maximum = schema_max_length(args.schema)
    plan = targets = None
    if args.apply:
        plan = json.loads(args.plan.read_text(encoding="utf-8"))
        targets = validate_plan(plan, maximum, args.expected_sha256)
    get_client = load_auth(args.auth_scripts_dir)
    with get_client("dv-query") as reader:
        preflight(reader)
        if args.prepare:
            rows, products = read_snapshot(reader)
            plan = prepare_plan(rows, products, maximum)
            args.plan.parent.mkdir(parents=True, exist_ok=True)
            mode = "w" if args.replace_plan else "x"
            with args.plan.open(mode, encoding="utf-8", newline="\n") as output:
                output.write(json.dumps(plan, indent=2, ensure_ascii=False) + "\n")
            print(json.dumps({
                "mode": "prepare", "live_updates": 0, "count": plan["count"],
                "planned_changes": plan["prepared_change_count"],
                "sha256": plan["sha256"], "plan": str(args.plan.resolve()),
            }))
        else:
            selected = {record_id(key) for key in args.record_id} if args.record_id else set(targets)
            result = apply_plan(
                reader, get_client, plan, targets, maximum, selected, args.batch_size
            )
            print(json.dumps({"mode": "apply", "sha256": plan["sha256"], **result}))


if __name__ == "__main__":
    try:
        main()
    except PlanError as exc:
        print(f"Stopped: {exc}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        # SDK responses may contain source data; do not print their bodies.
        print(
            f"Stopped ({type(exc).__name__}); execution did not finish. "
            "Review the failure before retrying the same approved plan. "
            "Any successful name updates remain in place; no rollback was attempted.",
            file=sys.stderr,
        )
        sys.exit(1)
