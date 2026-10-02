"""Pure schema, safety and seed helpers; importing this module never authenticates."""

import hashlib
import hmac
import json
import re
from pathlib import Path
from uuid import UUID, uuid5


PROJECT = Path(__file__).resolve().parents[1]
MANIFEST = PROJECT / "config" / "process-tracking-schema.json"
AUTH_SCRIPTS = Path(
    r"C:\Users\simoncook\OneDrive - Microsoft\Documents\Microsoft Scout\scripts"
)
TARGET = {
    "url": "https://smc-diamond-service.crm.dynamics.com",
    "environment_id": "b17908ad-6b6b-eefb-98bc-79cc7e20ab08",
    "organization_id": "d594142a-e0b5-f111-8add-6045bd02251f",
    "user_id": "0a61bb38-ef8b-f111-8076-7ced8d3c0da2",
    "identity": "admin@diax47618638.onmicrosoft.com",
    "solution": "RetailFinanceDemo",
    "publisher": "rfd",
}
CONFIG_TABLES = {
    "rfd_processdefinition", "rfd_processstagedefinition", "rfd_processtransition",
}
RUNTIME_TABLES = {
    "rfd_emailprocess", "rfd_emailprocessstage",
    "rfd_emailprocessevent", "rfd_emailprocesscase",
}
SOURCE_TABLES = {
    "contact": "contactid", "incident": "incidentid",
    "rfd_financialaccount": "rfd_financialaccountid", "email": "activityid",
    "task": "activityid", "annotation": "annotationid", "workflow": "workflowid",
    "systemuser": "systemuserid",
}
NAMESPACE = UUID("448ac72f-cb45-5cd7-9d1b-83d14b63ebca")
ATTRIBUTE_TYPES = {
    "string": "String", "memo": "Memo", "integer": "Integer",
    "bigint": "BigInt", "boolean": "Boolean", "datetime": "DateTime",
    "lookup": "Lookup", "decimal": "Decimal",
}


class SchemaError(Exception):
    """A safe-to-display error that never includes a server response or row data."""


def digest(value):
    return hashlib.sha256(json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode("utf-8")).hexdigest()


def approved_hash(manifest, expected):
    actual = digest(manifest)
    if (
        not isinstance(expected, str)
        or not re.fullmatch(r"[0-9a-fA-F]{64}", expected)
        or not hmac.compare_digest(actual, expected.lower())
    ):
        raise SchemaError("The manifest does not match the explicitly approved SHA-256.")
    return actual


def label(value):
    return {"LocalizedLabels": [{"Label": value, "LanguageCode": 1033}]}


def seed_id(kind, code, definition_code, version):
    return str(uuid5(NAMESPACE, f"{definition_code}/{version}/{kind}/{code}"))


def validate_manifest(manifest):
    if manifest.get("schema_version") != 1 or manifest.get("target") != TARGET:
        raise SchemaError("The manifest version or explicitly approved target differs.")
    tables = manifest.get("tables", [])
    names = [t["logical_name"] for t in tables]
    if len(names) != 7 or set(names) != CONFIG_TABLES | RUNTIME_TABLES:
        raise SchemaError("The manifest must contain exactly the approved seven tables.")
    all_relationships = set()
    for table in tables:
        name = table["logical_name"]
        ownership = "OrganizationOwned" if name in CONFIG_TABLES else "UserOwned"
        if table.get("ownership") != ownership or table.get("table_type") != "Standard":
            raise SchemaError(f"Ownership or standard-table requirement differs: {name}.")
        if table.get("primary_id") != name + "id" or table.get("primary_name") != "rfd_name":
            raise SchemaError(f"Unexpected primary columns: {name}.")
        columns = table.get("columns", [])
        fields = {f["logical_name"]: f for f in columns}
        if len(fields) != len(columns) or "rfd_name" not in fields:
            raise SchemaError(f"Duplicate columns or missing primary name: {name}.")
        for field in columns:
            if not re.fullmatch(r"rfd_[a-z][a-z0-9_]*", field["logical_name"]):
                raise SchemaError(f"Invalid publisher-prefixed logical column: {name}.")
            if field["type"] not in ATTRIBUTE_TYPES:
                raise SchemaError(f"Unsupported metadata type: {name}.")
            if type(field.get("required")) is not bool:
                raise SchemaError(f"Requiredness must be explicit: {name}.")
            if field["type"] in ("string", "memo"):
                maximum = 4000 if field["type"] == "string" else 1048576
                if not 1 <= field.get("max_length", 0) <= maximum:
                    raise SchemaError(f"Invalid text length: {name}.")
            if field["type"] == "lookup":
                if field.get("target") not in set(names) | set(SOURCE_TABLES):
                    raise SchemaError(f"Unapproved lookup target: {name}.")
                relationship = field.get("relationship")
                if not relationship or relationship in all_relationships:
                    raise SchemaError("Lookup relationship names must be globally unique.")
                all_relationships.add(relationship)
                if field.get("delete") not in ("Restrict", "RemoveLink"):
                    raise SchemaError("Cascading deletes are prohibited for tracking relationships.")
                if field["target"] in SOURCE_TABLES and field["delete"] != "RemoveLink":
                    raise SchemaError("Business record deletion must preserve telemetry.")
                if field.get("merge") != ("Cascade" if field["target"] == "contact" else "NoCascade"):
                    raise SchemaError("Merge policy must match the platform's mergeable-Contact constraint.")
            if field.get("secured") and field["type"] != "string":
                raise SchemaError("Restricted identity fields must be securable strings.")
            if field.get("reference_target") and (
                field["type"] != "string" or field.get("max_length") != 36
                or field["reference_target"] != "annotation"
                or field.get("reference_kind") != "non-relational-guid"
            ):
                raise SchemaError("Non-relational source references must use the reviewed annotation GUID contract.")
        keys = table.get("keys", [])
        if len({k["name"] for k in keys}) != len(keys):
            raise SchemaError(f"Duplicate key names: {name}.")
        for key in keys:
            if not key["columns"] or any(c not in fields for c in key["columns"]):
                raise SchemaError(f"An alternate key references an unknown column: {name}.")
            size = sum(
                fields[c].get("max_length", 0) * 2
                if fields[c]["type"] == "string" else 16 for c in key["columns"]
            )
            if size > 900 or any(fields[c].get("secured") for c in key["columns"]):
                raise SchemaError(f"An alternate key exceeds size/security limits: {name}.")
    validate_seed(manifest)
    return manifest


def load_manifest(path=MANIFEST):
    manifest = validate_manifest(json.loads(Path(path).read_text(encoding="utf-8")))
    contract = PROJECT / "server" / "process-contract.json"
    if contract.is_file():
        tables = json.loads(contract.read_text(encoding="utf-8"))["tables"]
        if digest(tables) != manifest.get("service_table_contract_sha256"):
            raise SchemaError("Service table contract changed. Regenerate and review a new manifest hash.")
    return manifest


def validate_seed(manifest):
    graph = manifest["seed"]
    stages = graph["stages"]
    codes = {s["code"] for s in stages}
    if len(codes) != len(stages) or not codes:
        raise SchemaError("Seed stage codes are empty or duplicated.")
    if (
        not re.fullmatch(r"[a-z][a-z0-9-]{0,79}", graph["definition_code"])
        or type(graph.get("version")) is not int or graph["version"] < 1
        or any(not re.fullmatch(r"[a-z][a-z0-9-]{0,79}", code) for code in codes)
    ):
        raise SchemaError("Definition version and seed codes must be canonical bounded values.")
    transitions = graph["transitions"]
    if len({t["code"] for t in transitions}) != len(transitions):
        raise SchemaError("Seed transition codes are duplicated.")
    if any(t["from"] not in codes or t["to"] not in codes for t in transitions):
        raise SchemaError("A seed transition references an unknown stage.")
    if graph.get("entry_stage") != "intake":
        raise SchemaError("The Help definition must begin with an observed intake receipt.")
    if not {"intake", "classify", "route", "card-servicing", "spam", "reviewcase"} <= codes:
        raise SchemaError("Verified classification/routing/review boundaries are missing.")
    by_code = {s["code"]: s for s in stages}
    if (
        by_code["intake"].get("completion_authority") != "intake"
        or by_code["intake"].get("kind") != "start"
        or by_code["intake"].get("phase") != "intake"
        or by_code["intake"].get("required") is not True
    ):
        raise SchemaError("Intake must be the required, receipt-backed start stage.")
    if by_code["card-servicing"].get("coverage") != "opaque":
        raise SchemaError("Saved-agent internals must remain opaque.")
    if by_code["reviewcase"].get("phase") != "review":
        raise SchemaError("Case review is a separate business phase.")
    if any(s["phase"] not in ("intake", "identify", "classify", "route", "act", "review")
           or s["kind"] not in ("start", "task", "gateway", "subprocess", "wait", "end", "exception")
           for s in stages):
        raise SchemaError("Stage phase/kind must match the shared UI DTO allowlists.")
    if any(s.get("completion_authority") not in ("intake", "tool", "workflow", "case-observer") for s in stages):
        raise SchemaError("Stage completion authority must match the server contract.")
    if any(sum(s["completion_authority"] == authority for s in stages) > 1
           for authority in ("intake", "case-observer")):
        raise SchemaError("Definitions allow at most one intake and one case-observer stage.")
    edge_pairs = {(t["from"], t["to"]) for t in transitions}
    if not {("intake", "classify"), ("classify", "route"), ("route", "card-servicing"), ("route", "spam")} <= edge_pairs:
        raise SchemaError("The verified Classify_Email and switch routes are missing.")
    if any(s.get("coverage") == "instrumented" for s in stages):
        raise SchemaError("Seed configuration must not claim unverified live instrumentation.")
    if (
        graph.get("allow_case_free_completion") is not False
        or any(s.get("allow_case_free_completion") is not False for s in stages)
        or any(s.get("requires_case") != (s["code"] == "card-servicing") for s in stages)
    ):
        raise SchemaError("Observed Failed terminations forbid host-derived no-case completion; card requires a case.")
    return graph


def attribute_metadata(field, primary=False):
    kind = ATTRIBUTE_TYPES[field["type"]]
    result = {
        "@odata.type": f"Microsoft.Dynamics.CRM.{kind}AttributeMetadata",
        "SchemaName": field["logical_name"],
        "DisplayName": label(field.get("label", field["logical_name"][4:])),
        "RequiredLevel": {"Value": "ApplicationRequired" if field["required"] else "None"},
    }
    if field["type"] in ("string", "memo"):
        result["MaxLength"] = field["max_length"]
        result["FormatName"] = {"Value": "Text"} if kind == "String" else {"Value": "TextArea"}
        if kind == "Memo":
            result.pop("FormatName")
            result["Format"] = "TextArea"
    if field["type"] == "string":
        result["IsSecured"] = bool(field.get("secured", False))
    if field["type"] == "integer":
        result.update(MinValue=field.get("min_value", 0), MaxValue=field.get("max_value", 2147483647))
    if field["type"] == "bigint":
        result.update(MinValue=0, MaxValue=9223372036854775807)
    if field["type"] == "decimal":
        result.update(MinValue=0, MaxValue=100000000000, Precision=3)
    if field["type"] == "datetime":
        result.update(Format="DateAndTime", DateTimeBehavior={"Value": "UserLocal"})
    if field["type"] == "boolean":
        result.update(DefaultValue=False, OptionSet={
            "TrueOption": {"Value": 1, "Label": label("Yes")},
            "FalseOption": {"Value": 0, "Label": label("No")},
        })
    if primary:
        result["IsPrimaryName"] = True
    return result


def table_metadata(table):
    return {
        "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata",
        "SchemaName": table["logical_name"],
        "EntitySetName": table["entity_set"],
        "DisplayName": label(table["label"]),
        "DisplayCollectionName": label(table["collection_label"]),
        "Description": label("Email process tracking; standard transactional table."),
        "OwnershipType": table["ownership"],
        "TableType": "Standard",
        "IsActivity": False, "HasActivities": False, "HasNotes": False,
        "IsOptimisticConcurrencyEnabled": True,
        "PrimaryNameAttribute": table["primary_name"],
        "Attributes": [
            attribute_metadata(f, primary=True)
            for f in table["columns"] if f["logical_name"] == table["primary_name"]
        ],
    }


def difference(manifest, snapshot):
    """Return only additive work; incompatible existing metadata blocks all writes."""
    changes, conflicts, pending = [], [], []
    for table in manifest["tables"]:
        name = table["logical_name"]
        capabilities = snapshot.get("_source_capabilities", {})
        for field in table["columns"]:
            if field["type"] == "lookup" and field["target"] in capabilities:
                if capabilities[field["target"]] is not True:
                    conflicts.append(f"{name}.{field['logical_name']}.unsupported-lookup-target")
        live = snapshot.get(name)
        if live is None:
            changes.append({"kind": "table", "table": name})
            for field in table["columns"]:
                if field["logical_name"] != table["primary_name"]:
                    changes.append({
                        "kind": "lookup" if field["type"] == "lookup" else "column",
                        "table": name, "column": field["logical_name"],
                    })
            for key in table["keys"]:
                changes.append({"kind": "key", "table": name, "key": key["name"]})
            continue
        expected = {
            "OwnershipType": table["ownership"], "EntitySetName": table["entity_set"],
            "IsActivity": False, "IsOptimisticConcurrencyEnabled": True,
            "PrimaryIdAttribute": table["primary_id"], "PrimaryNameAttribute": table["primary_name"],
        }
        for prop, value in expected.items():
            if live.get(prop) != value:
                conflicts.append(f"{name}.{prop}")
        if live.get("TableType") != "Standard":
            conflicts.append(f"{name}.TableType")
        if live.get("IsManaged") is not False:
            conflicts.append(f"{name}.IsManaged")
        if live.get("in_solution") is not True:
            conflicts.append(f"{name}.solution-membership")
        columns = {f["LogicalName"]: f for f in live["Attributes"]}
        relationships = {r["ReferencingAttribute"]: r for r in live["Relationships"]}
        for field in table["columns"]:
            field_name = field["logical_name"]
            actual = columns.get(field_name)
            if actual is None:
                changes.append({
                    "kind": "lookup" if field["type"] == "lookup" else "column",
                    "table": name, "column": field_name,
                })
                continue
            checks = {
                "AttributeType": ATTRIBUTE_TYPES[field["type"]],
                "RequiredLevel": {"Value": "ApplicationRequired" if field["required"] else "None"},
            }
            if field["type"] in ("string", "memo"):
                checks["MaxLength"] = field["max_length"]
            if field["type"] == "string":
                checks["IsSecured"] = bool(field.get("secured", False))
            if field["type"] == "datetime":
                checks["Format"] = "DateAndTime"
                checks["DateTimeBehavior"] = {"Value": "UserLocal"}
            if field["type"] in ("integer", "bigint", "decimal"):
                payload = attribute_metadata(field)
                checks.update({key: payload[key] for key in ("MinValue", "MaxValue")})
                if field["type"] == "decimal":
                    checks["Precision"] = payload["Precision"]
            if field["type"] == "lookup":
                checks["Targets"] = [field["target"]]
                relation = relationships.get(field_name, {})
                if (
                    relation.get("SchemaName") != field["relationship"]
                    or relation.get("ReferencingEntityNavigationPropertyName") != field_name
                    or relation.get("CascadeConfiguration", {}).get("Delete") != field["delete"]
                    or relation.get("CascadeConfiguration", {}).get("Merge") != field["merge"]
                    or any(relation.get("CascadeConfiguration", {}).get(k) != "NoCascade"
                           for k in ("Assign", "Reparent", "Share", "Unshare"))
                ):
                    conflicts.append(f"{name}.{field_name}.relationship")
            for prop, value in checks.items():
                actual_value = actual.get(prop)
                if prop in ("RequiredLevel", "DateTimeBehavior"):
                    actual_value = {"Value": (actual_value or {}).get("Value")}
                if actual_value != value:
                    conflicts.append(f"{name}.{field_name}.{prop}")
        keys = {k["SchemaName"]: k for k in live["Keys"]}
        for key in table["keys"]:
            actual = keys.get(key["name"])
            if actual is None:
                changes.append({"kind": "key", "table": name, "key": key["name"]})
            elif sorted(actual.get("KeyAttributes") or []) != sorted(key["columns"]):
                conflicts.append(f"{name}.{key['name']}.KeyAttributes")
            elif actual.get("EntityKeyIndexStatus") != "Active":
                pending.append({
                    "table": name, "key": key["name"],
                    "status": actual.get("EntityKeyIndexStatus", "Unknown"),
                })
    return {"changes": changes, "conflicts": conflicts, "pending_keys": pending,
            "schema_ready": not changes and not conflicts and not pending}
