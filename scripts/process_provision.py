"""Review-only by default. Additive provisioning requires explicit target and manifest approval."""

import argparse
import importlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from uuid import UUID, uuid4

from process_schema import (
    AUTH_SCRIPTS, MANIFEST, PROJECT, RUNTIME_TABLES, SOURCE_TABLES, TARGET, SchemaError,
    approved_hash, attribute_metadata, difference, digest, label, load_manifest,
    table_metadata,
)


class ManagedCli:
    """Use the installed managed CLI only for SDK metadata/ownership gaps."""

    def __init__(self, writes=False):
        self.executable = shutil.which("dataverse")
        self.writes = writes
        if not self.executable:
            raise SchemaError("The managed Dataverse CLI is not installed.")
        self.command = [self.executable]
        if os.name == "nt":
            wrapper = Path(self.executable).with_suffix(".ps1")
            powershell = shutil.which("pwsh") or shutil.which("powershell")
            if not powershell or not wrapper.is_file():
                raise SchemaError("The installed managed CLI PowerShell wrapper is required on Windows.")
            # A .cmd wrapper interprets OData '&' and '%' even with shell=False.
            self.command = [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-File", str(wrapper)]

    def run(self, arguments, metadata=False):
        result = subprocess.run(
            [*self.command, *arguments], capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=180, check=False,
        )
        if result.returncode:
            if metadata:
                try:
                    error = json.loads(result.stdout).get("error", {})
                    code = error.get("code")
                    message = error.get("message")
                    if isinstance(code, str) and isinstance(message, str):
                        raise SchemaError(f"Metadata request failed ({code}): {message[:1500]}")
                except (ValueError, AttributeError):
                    pass
            raise SchemaError("A managed Dataverse CLI operation failed; no response body was logged.")
        text = result.stdout.strip()
        if not text:
            return {}
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise SchemaError("The managed CLI did not return a JSON response.") from exc

    def who(self):
        return self.run(["org", "who", "--environment", TARGET["url"], "--json"])

    def request(self, path, method="GET", body=None):
        if method != "GET" and not self.writes:
            raise SchemaError("Write attempted through a read-only metadata client.")
        if not path.startswith("/api/data/v9.2/"):
            raise SchemaError("Only the fixed environment's Dataverse metadata API is allowed.")
        args = [
            "api", "request", "--target", "dataverse",
            "--environment", TARGET["url"], "--path", path, "--method", method,
        ]
        if body is None:
            return self.run(args, metadata=True)
        # Body files avoid cmd.exe quoting and command-length limits on Windows.
        body_path = PROJECT / "config" / f"process-metadata-request-{uuid4().hex}.json"
        try:
            with body_path.open("x", encoding="utf-8") as output:
                json.dump(body, output, separators=(",", ":"))
            args += [
                "--body-file", str(body_path),
                "--header", f"MSCRM.SolutionUniqueName:{TARGET['solution']}",
            ]
            if method == "PUT":
                args += ["--header", "MSCRM.MergeLabels:true"]
            return self.run(args, metadata=True)
        finally:
            body_path.unlink(missing_ok=True)


def load_auth(path):
    if not (path / "auth.py").is_file() or not (path.parent / ".env").is_file():
        raise SchemaError("The approved initialized SDK auth workspace is unavailable.")
    sys.path.insert(0, str(path.resolve()))
    auth = importlib.import_module("auth")
    auth.load_env()
    expected = {
        "DATAVERSE_URL": TARGET["url"], "SOLUTION_NAME": TARGET["solution"],
        "PUBLISHER_PREFIX": TARGET["publisher"],
    }
    if any(os.environ.get(k, "").rstrip("/") != value for k, value in expected.items()):
        raise SchemaError("SDK auth configuration targets another environment/solution/publisher.")
    return auth.get_client


def preflight(client, cli):
    who = cli.who()
    for key, expected in {
        "OrgUrl": TARGET["url"], "OrgId": TARGET["organization_id"],
        "EnvironmentId": TARGET["environment_id"], "UserId": TARGET["user_id"],
        "UserEmail": TARGET["identity"],
    }.items():
        if str(who.get(key, "")).rstrip("/").casefold() != expected.casefold():
            raise SchemaError(f"Managed CLI preflight mismatch: {key}.")
    users = list(client.query.fetchxml(
        '<fetch><entity name="systemuser"><attribute name="systemuserid"/>'
        '<attribute name="domainname"/><filter>'
        '<condition attribute="systemuserid" operator="eq-userid"/>'
        '</filter></entity></fetch>'
    ).execute())
    if (
        len(users) != 1 or str(users[0]["systemuserid"]).lower() != TARGET["user_id"]
        or (users[0].get("domainname") or "").casefold() != TARGET["identity"].casefold()
    ):
        raise SchemaError("The SDK authenticated identity differs from the approved administrator.")
    orgs = list(client.records.list("organization", select=["organizationid"], top=2))
    if len(orgs) != 1 or str(orgs[0]["organizationid"]).lower() != TARGET["organization_id"]:
        raise SchemaError("The SDK organization differs from the approved environment.")
    solutions = list(client.records.list(
        "solution", filter=f"uniquename eq '{TARGET['solution']}'",
        select=["solutionid", "_publisherid_value", "ismanaged"], top=2,
    ))
    if len(solutions) != 1 or solutions[0].get("ismanaged") is not False:
        raise SchemaError("The approved existing unmanaged solution is unavailable.")
    publisher = client.records.retrieve(
        "publisher", solutions[0]["_publisherid_value"], select=["customizationprefix"],
    )
    if not publisher or publisher.get("customizationprefix") != TARGET["publisher"]:
        raise SchemaError("The existing solution publisher prefix does not match.")
    return str(solutions[0]["solutionid"])


def inspect_schema(client, cli, manifest, solution_id):
    names = [t["logical_name"] for t in manifest["tables"]]
    fields = (
        "LogicalName,EntitySetName,OwnershipType,IsManaged,IsActivity,TableType,"
        "IsOptimisticConcurrencyEnabled,PrimaryIdAttribute,PrimaryNameAttribute"
    )
    filter_text = "%20or%20".join(f"LogicalName%20eq%20'{n}'" for n in names)
    entities = cli.request(
        f"/api/data/v9.2/EntityDefinitions?%24select={fields}&%24filter={filter_text}"
    ).get("value", [])
    components = list(client.records.list(
        "solutioncomponent",
        select=["objectid", "componenttype"],
        filter=f"_solutionid_value eq {solution_id} and componenttype eq 1",
    ))
    included = {str(r["objectid"]).lower() for r in components}
    result = {}
    for entity in entities:
        name = entity["LogicalName"]
        entity["in_solution"] = str(entity["MetadataId"]).lower() in included
        entity["Attributes"] = client.tables.list_columns(name)
        entity["Relationships"] = [
            r for r in client.tables.list_table_relationships(name)
            if r.get("ReferencingEntity") == name
        ]
        entity["Keys"] = cli.request(
            f"/api/data/v9.2/EntityDefinitions(LogicalName='{name}')/Keys"
        ).get("value", [])
        result[name] = entity
    source_filter = "%20or%20".join(f"LogicalName%20eq%20'{n}'" for n in SOURCE_TABLES)
    source_metadata = cli.request(
        "/api/data/v9.2/EntityDefinitions?"
        "%24select=LogicalName,PrimaryIdAttribute,CanBePrimaryEntityInRelationship"
        f"&%24filter={source_filter}"
    ).get("value", [])
    sources = {item["LogicalName"]: item for item in source_metadata}
    for source, expected_id in SOURCE_TABLES.items():
        info = client.tables.get(source)
        if not info:
            raise SchemaError(f"A required typed lookup target is unavailable: {source}.")
        primary = sources.get(source, {}).get("PrimaryIdAttribute")
        if primary != expected_id:
            raise SchemaError(f"Unexpected typed lookup primary column: {source}.")
    result["_source_capabilities"] = {
        name: item.get("CanBePrimaryEntityInRelationship", {}).get("Value")
        for name, item in sources.items()
    }
    return result


def create_lookup(client, table, field):
    from PowerPlatform.Dataverse.models.labels import Label, LocalizedLabel
    from PowerPlatform.Dataverse.models.relationship import (
        CascadeConfiguration, LookupAttributeMetadata, OneToManyRelationshipMetadata,
    )

    target = field["target"]
    primary = SOURCE_TABLES.get(target, target + "id")
    lookup = LookupAttributeMetadata(
        schema_name=field["logical_name"],
        display_name=Label(localized_labels=[LocalizedLabel(
            label=field.get("label", field["logical_name"][4:]), language_code=1033,
        )]),
        required_level="ApplicationRequired" if field["required"] else "None",
    )
    relationship = OneToManyRelationshipMetadata(
        schema_name=field["relationship"], referenced_entity=target,
        referencing_entity=table["logical_name"], referenced_attribute=primary,
        cascade_configuration=CascadeConfiguration(delete=field["delete"], merge=field["merge"]),
        additional_properties={
            "ReferencingEntityNavigationPropertyName": field["logical_name"],
        },
    )
    client.tables.create_one_to_many_relationship(
        lookup, relationship, solution=TARGET["solution"],
    )


def apply_metadata(client, cli, manifest, report):
    if (
        not cli.writes or report["conflicts"]
        or any(k["status"] == "Failed" for k in report.get("pending_keys", []))
    ):
        raise SchemaError("Metadata writes require authorization and a conflict-free read-only diff.")
    tables = {t["logical_name"]: t for t in manifest["tables"]}
    # All table shells/attributes precede cross-table relationships and key indexes.
    order = {"table": 0, "column": 1, "lookup": 2, "key": 3}
    for operation in sorted(report["changes"], key=lambda o: order[o["kind"]]):
        table = tables[operation["table"]]
        entity_path = f"/api/data/v9.2/EntityDefinitions(LogicalName='{table['logical_name']}')"
        if operation["kind"] == "table":
            cli.request("/api/data/v9.2/EntityDefinitions", "POST", table_metadata(table))
        elif operation["kind"] in ("column", "lookup"):
            field = next(f for f in table["columns"] if f["logical_name"] == operation["column"])
            if operation["kind"] == "lookup":
                create_lookup(client, table, field)
            else:
                cli.request(entity_path + "/Attributes", "POST", attribute_metadata(field))
        else:
            key = next(k for k in table["keys"] if k["name"] == operation["key"])
            cli.request(entity_path + "/Keys", "POST", {
                "@odata.type": "Microsoft.Dynamics.CRM.EntityKeyMetadata",
                "SchemaName": key["name"], "DisplayName": label(key["name"]),
                "KeyAttributes": key["columns"],
            })
        print(json.dumps({"applied_metadata": operation}), file=sys.stderr, flush=True)
    if report["changes"]:
        entity_xml = "".join(f"<entity>{name}</entity>" for name in tables)
        cli.request("/api/data/v9.2/PublishXml", "POST", {
            "ParameterXml": f"<importexportxml><entities>{entity_xml}</entities></importexportxml>",
        })
    return len(report["changes"])


def table_readiness(manifest, snapshot):
    report = difference(manifest, snapshot)
    result = []
    for table in manifest["tables"]:
        name = table["logical_name"]
        live = snapshot.get(name)
        result.append({
            "table": name,
            "exists": live is not None,
            "ready": live is not None and not any(
                item["table"] == name for item in report["changes"] + report["pending_keys"]
            ) and not any(c.startswith(name + ".") for c in report["conflicts"]),
            "in_solution": bool(live and live.get("in_solution")),
            "ownership": (live or {}).get("OwnershipType"),
            "declared_columns": len(table["columns"]),
            "keys": [{
                "name": key["name"],
                "status": next(
                    (k["EntityKeyIndexStatus"] for k in (live or {}).get("Keys", [])
                     if k["SchemaName"] == key["name"]), "Missing",
                ),
            } for key in table["keys"]],
        })
    return result


def repair_created_primary_names(client, cli, manifest, snapshot, approved_ids):
    """Only correct known empty table shells from this provisioning operation."""
    if not approved_ids:
        return 0
    if not cli.writes or not set(approved_ids) <= RUNTIME_TABLES:
        raise SchemaError("Primary-name correction requires explicit created runtime-table metadata IDs.")
    allowed_conflicts = {
        f"{table}.rfd_name.{prop}" for table in approved_ids for prop in ("MaxLength", "RequiredLevel")
    }
    if set(difference(manifest, snapshot)["conflicts"]) - allowed_conflicts:
        raise SchemaError("Other metadata conflicts block primary-name correction.")
    tables = {t["logical_name"]: t for t in manifest["tables"]}
    pending = []
    for name, metadata_id in approved_ids.items():
        live = snapshot.get(name) or {}
        if str(live.get("MetadataId", "")).lower() != str(UUID(metadata_id)):
            raise SchemaError("A primary-name correction table metadata ID differs from the approved created table.")
        if list(client.records.list(name, select=[name + "id"], top=1)):
            raise SchemaError("Primary-name correction refuses tables containing any runtime records.")
        actual = next((f for f in live.get("Attributes", []) if f["LogicalName"] == "rfd_name"), {})
        expected = next(f for f in tables[name]["columns"] if f["logical_name"] == "rfd_name")
        if actual.get("MaxLength") == expected["max_length"] and actual.get("RequiredLevel", {}).get("Value") == "ApplicationRequired":
            continue
        if (
            actual.get("IsPrimaryName") is not True or actual.get("IsManaged") is not False
            or actual.get("MaxLength") != 850 or actual.get("RequiredLevel", {}).get("Value") != "None"
        ):
            raise SchemaError("Primary-name metadata does not match the observed new-shell default; no overwrite allowed.")
        path = f"/api/data/v9.2/EntityDefinitions(LogicalName='{name}')/Attributes(LogicalName='rfd_name')"
        body = cli.request(path + "/Microsoft.Dynamics.CRM.StringAttributeMetadata")
        if body.get("MetadataId") != actual.get("MetadataId"):
            raise SchemaError("The primary-name attribute metadata ID changed during correction review.")
        body.pop("@odata.context", None)
        body["@odata.type"] = "Microsoft.Dynamics.CRM.StringAttributeMetadata"
        body["MaxLength"] = expected["max_length"]
        body["RequiredLevel"] = {**body["RequiredLevel"], "Value": "ApplicationRequired"}
        pending.append((path, body))
    for path, body in pending:
        cli.request(path, "PUT", body)
    if pending:
        entities = "".join(f"<entity>{name}</entity>" for name in approved_ids)
        cli.request("/api/data/v9.2/PublishXml", "POST", {
            "ParameterXml": f"<importexportxml><entities>{entities}</entities></importexportxml>",
        })
    return len(pending)


def await_ready(client, cli, manifest, solution_id, timeout):
    deadline = time.monotonic() + timeout
    while True:
        snapshot = inspect_schema(client, cli, manifest, solution_id)
        report = difference(manifest, snapshot)
        if report["conflicts"]:
            raise SchemaError("Post-write verification found incompatible metadata; review the diff.")
        if report["schema_ready"]:
            return snapshot
        if any(k["status"] == "Failed" for k in report["pending_keys"]):
            raise SchemaError("An alternate-key index failed. Do not enable producers.")
        if time.monotonic() >= deadline:
            raise SchemaError("Schema/index propagation is incomplete. Rerun --inspect; producers remain disabled.")
        time.sleep(10)


def approval_arguments(args, manifest):
    if not args.apply:
        return
    approved_hash(manifest, args.expected_manifest_sha256)
    for value, key in (
        (args.expected_url, "url"), (args.expected_solution, "solution"),
        (args.expected_publisher, "publisher"), (args.expected_identity, "identity"),
    ):
        if not value or value.rstrip("/") != TARGET[key]:
            raise SchemaError(f"--apply requires the explicitly approved expected {key}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Offline manifest/seed validation; no authentication.")
    mode.add_argument("--inspect", action="store_true", help="Live read-only identity, metadata and seed diff.")
    mode.add_argument("--apply", action="store_true", help="Apply approved additive metadata and definition seed only.")
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--auth-scripts-dir", type=Path, default=AUTH_SCRIPTS)
    parser.add_argument("--expected-manifest-sha256")
    parser.add_argument("--expected-url")
    parser.add_argument("--expected-solution")
    parser.add_argument("--expected-publisher")
    parser.add_argument("--expected-identity")
    parser.add_argument("--key-timeout", type=int, default=600)
    parser.add_argument("--schema-only", action="store_true", help="With --apply, provision metadata but do not create/publish seeds.")
    parser.add_argument("--repair-created-primary", action="append", default=[], metavar="TABLE=METADATA_GUID",
                        help="Explicitly correct a known newly created EMPTY runtime shell's primary-name defaults.")
    args = parser.parse_args()
    if not 0 <= args.key_timeout <= 3600:
        parser.error("--key-timeout must be between 0 and 3600 seconds.")
    if args.schema_only and not args.apply:
        parser.error("--schema-only requires --apply.")
    if args.repair_created_primary and not args.apply:
        parser.error("--repair-created-primary requires --apply and explicit created table IDs.")
    primary_repairs = {}
    for item in args.repair_created_primary:
        name, separator, metadata_id = item.partition("=")
        if not separator or name in primary_repairs:
            parser.error("--repair-created-primary requires unique TABLE=METADATA_GUID values.")
        primary_repairs[name] = str(UUID(metadata_id))
    manifest = load_manifest(args.manifest)
    approval_arguments(args, manifest)
    from process_seed import expected_rows, inspect_seed, provision_seed, publication_readiness

    result = {
        "mode": "apply" if args.apply else "inspect" if args.inspect else "dry-run",
        "manifest_sha256": digest(manifest), "target": TARGET,
        "live_writes": 0, "schema_ready": False, "production_ready": False,
        "gates": manifest["deployment_gates"],
        "definition_publication": publication_readiness(manifest),
    }
    if not (args.inspect or args.apply):
        result.update(difference(manifest, {}))
        result["seed_rows"] = len(expected_rows(manifest))
        result["live_state"] = "Not inspected; this is an offline creation plan."
    else:
        factory = load_auth(args.auth_scripts_dir)
        cli = ManagedCli(writes=args.apply)
        with factory("dv-metadata") as client:
            solution_id = preflight(client, cli)
            snapshot = inspect_schema(client, cli, manifest, solution_id)
            report = difference(manifest, snapshot)
            result.update(report)
            result["tables"] = table_readiness(manifest, snapshot)
            result["seed"] = inspect_seed(client, manifest, snapshot)
            if args.apply:
                if primary_repairs:
                    preflight(client, cli)
                    repaired = repair_created_primary_names(client, cli, manifest, snapshot, primary_repairs)
                    result["live_writes"] += repaired
                    result["corrected_created_primary_names"] = repaired
                    snapshot = inspect_schema(client, cli, manifest, solution_id)
                    report = difference(manifest, snapshot)
                    result["seed"] = inspect_seed(client, manifest, snapshot)
                if (
                    report["conflicts"] or result["seed"]["conflicts"]
                    or any(k["status"] == "Failed" for k in report["pending_keys"])
                ):
                    raise SchemaError("Existing schema or seed differs; additive apply refused without overwriting.")
                preflight(client, cli)
                result["live_writes"] += apply_metadata(client, cli, manifest, report)
                result["created"] = {
                    kind: sum(item["kind"] == kind for item in report["changes"])
                    for kind in ("table", "column", "lookup", "key")
                }
                result["created"]["scalar_columns_in_new_tables"] = sum(
                    1
                    for table in manifest["tables"]
                    if any(o["kind"] == "table" and o["table"] == table["logical_name"] for o in report["changes"])
                )
                snapshot = await_ready(client, cli, manifest, solution_id, args.key_timeout)
                if not args.schema_only:
                    result["definition_publication"] = publication_readiness(manifest)
                    if not result["definition_publication"]["ready"]:
                        raise SchemaError("Schema ready; seed publication blocked by the adapter/profile review gate.")
                    with factory("dv-data") as writer:
                        preflight(writer, cli)
                        seed_writes = provision_seed(writer, manifest, snapshot)
                        result["live_writes"] += seed_writes
                        result["created"]["seed_records"] = seed_writes - 1 if seed_writes else 0
                        result["created"]["definition_publications"] = 1 if seed_writes else 0
                else:
                    result["created"].update(seed_records=0, definition_publications=0)
                result.update(difference(manifest, snapshot))
                result["tables"] = table_readiness(manifest, snapshot)
                result["seed"] = inspect_seed(client, manifest, snapshot)
                if not args.schema_only and (result["seed"]["conflicts"] or not result["seed"]["published"]):
                    raise SchemaError("Final definition verification failed; do not enable producers.")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except SchemaError as exc:
        print(f"Stopped: {exc}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(
            f"Stopped ({type(exc).__name__}); no service response or record data logged. "
            "Successful additive changes may remain; inspect before retrying. No rollback performed.",
            file=sys.stderr,
        )
        sys.exit(1)
