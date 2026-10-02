"""Prepare or register process Custom APIs against an already registered plug-in.

Assembly upload, observer/guard activation and security grants are separate gates.
"""
import argparse
import hashlib
import importlib
import json
import os
from pathlib import Path
import sys
from uuid import UUID, uuid5
from process_provision import ManagedCli, preflight as environment_preflight

PROJECT = Path(__file__).resolve().parents[1]
CONTRACT = PROJECT / "server" / "process-contract.json"
URL = "https://smc-diamond-service.crm.dynamics.com"
ORG = "d594142a-e0b5-f111-8add-6045bd02251f"
USER = "0a61bb38-ef8b-f111-8076-7ced8d3c0da2"
SOLUTION = "RetailFinanceDemo"
PREFIX = "rfd"
ID_NAMESPACE = UUID("efa451f9-f88f-4284-bb3d-1bd4c2f41163")


class RegistrationError(Exception):
    pass


def manifest_hash(contract):
    return hashlib.sha256(json.dumps(
        contract, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")).hexdigest()


def api_definitions(contract, plugin_type_id, read_privilege, write_privilege):
    plugin_type_id = str(UUID(plugin_type_id))
    names = contract["api"]["actions"]
    if len(names) != len(set(names)) or any(not name.startswith("rfd_") for name in names):
        raise RegistrationError("Invalid or duplicate API names.")
    result = []
    for name in names:
        is_read = name.startswith(("rfd_Get", "rfd_List"))
        result.append({
            "logicalName": "customapi",
            "uniqueName": name,
            "body": {
                "uniquename": name, "name": name, "displayname": name,
                "description": "Gravity Bank versioned process tracking service.",
                "bindingtype": 0, "isfunction": False, "isprivate": False,
                "allowedcustomprocessingsteptype": 0,
                "executeprivilegename": read_privilege if is_read else write_privilege,
                "PluginTypeId@odata.bind": f"/plugintypes({plugin_type_id})",
            },
            "request": {"uniquename": "RequestJson", "name": f"{name}.RequestJson",
                        "displayname": "Request JSON", "type": 10, "isoptional": False},
            "response": {"uniquename": "ResponseJson", "name": f"{name}.ResponseJson",
                         "displayname": "Response JSON", "type": 10},
        })
    return result


def preflight(client, plugin_type_id, read_privilege, write_privilege):
    identity = list(client.query.fetchxml(
        '<fetch><entity name="systemuser"><attribute name="systemuserid"/>'
        '<filter><condition attribute="systemuserid" operator="eq-userid"/>'
        '</filter></entity></fetch>'
    ).execute())
    if len(identity) != 1 or str(identity[0]["systemuserid"]).lower() != USER:
        raise RegistrationError("Unexpected authenticated identity.")
    organizations = list(client.records.list("organization", select=["organizationid"]))
    if len(organizations) != 1 or str(organizations[0]["organizationid"]).lower() != ORG:
        raise RegistrationError("Unexpected organization.")
    solutions = list(client.records.list("solution",
        filter=f"uniquename eq '{SOLUTION}'", select=["solutionid", "ismanaged", "_publisherid_value"]))
    if len(solutions) != 1 or solutions[0]["ismanaged"]:
        raise RegistrationError("Expected unmanaged solution is unavailable.")
    publisher = client.records.retrieve("publisher", solutions[0]["_publisherid_value"],
        select=["customizationprefix"])
    if publisher.get("customizationprefix") != PREFIX:
        raise RegistrationError("Unexpected solution publisher.")
    plugin = client.records.retrieve("plugintype", plugin_type_id,
        select=["typename", "_pluginassemblyid_value"])
    if plugin is None or plugin.get("typename") != "EmailProcess.Plugin.ProcessApi":
        raise RegistrationError("The approved process plug-in type is not registered.")
    for name in (read_privilege, write_privilege):
        if not name.startswith("prv") or "'" in name:
            raise RegistrationError("Invalid privilege name.")
        privileges = list(client.records.list("privilege", filter=f"name eq '{name}'",
            select=["privilegeid", "name"], top=2))
        if len(privileges) != 1:
            raise RegistrationError("Required existing Dataverse privilege is unavailable.")
    return str(solutions[0]["solutionid"])


def assert_existing_api(existing, expected, plugin_type_id):
    fields = ("bindingtype", "isfunction", "isprivate",
              "allowedcustomprocessingsteptype", "executeprivilegename")
    if any(existing.get(key) != expected[key] for key in fields):
        raise RegistrationError("Existing API contract differs; no overwrite performed.")
    if str(existing.get("_plugintypeid_value", "")).lower() != plugin_type_id.lower():
        raise RegistrationError("Existing API is attached to another plug-in type.")


def create_children(client, cli, api_id, definition):
    for table, entity_set, field, body in [
        ("customapirequestparameter", "customapirequestparameters", "request", definition["request"]),
        ("customapiresponseproperty", "customapiresponseproperties", "response", definition["response"]),
    ]:
        select = ["uniquename", "type"] + (["isoptional"] if field == "request" else [])
        rows = list(client.records.list(table, filter=f"_customapiid_value eq {api_id}", select=select))
        if rows:
            if len(rows) != 1 or any(rows[0].get(key) != body[key] for key in select):
                raise RegistrationError("Existing API parameter contract differs; no overwrite performed.")
        else:
            cli.request(f"/api/data/v9.2/{entity_set}", method="POST", body={
                **body, f"{table}id": str(uuid5(ID_NAMESPACE, f"{api_id}:{field}")),
                "CustomAPIId@odata.bind": f"/customapis({api_id})",
            })
            verified = list(client.records.list(table, filter=f"_customapiid_value eq {api_id}", select=select))
            if len(verified) != 1 or any(verified[0].get(key) != body[key] for key in select):
                raise RegistrationError("Registered API parameter was not returned by read-back.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plugin-type-id", required=True)
    parser.add_argument("--read-privilege", required=True)
    parser.add_argument("--write-privilege", required=True)
    parser.add_argument("--auth-scripts-dir", type=Path, default=Path(
        r"C:\Users\simoncook\OneDrive - Microsoft\Documents\Microsoft Scout\scripts"))
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-contract-sha256")
    parser.add_argument("--guards-verified", action="store_true")
    parser.add_argument("--release-approved", action="store_true")
    args = parser.parse_args()
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    digest = manifest_hash(contract)
    definitions = api_definitions(contract, args.plugin_type_id,
        args.read_privilege, args.write_privilege)
    if not args.apply:
        print(json.dumps({"mode": "dry-run", "contractSha256": digest,
            "environment": URL, "solution": SOLUTION, "definitions": definitions}, indent=2))
        return
    if not args.release_approved or not args.guards_verified or args.expected_contract_sha256 != digest:
        raise RegistrationError("Release approval, verified mutation guards and exact contract hash are required.")
    sys.path.insert(0, str(args.auth_scripts_dir.resolve()))
    auth = importlib.import_module("auth")
    auth.load_env()
    if os.environ.get("DATAVERSE_URL", "").rstrip("/") != URL:
        raise RegistrationError("Auth configuration targets another environment.")
    cli = ManagedCli(writes=True)
    with auth.get_client("dv-solution") as client:
        environment_preflight(client, cli)
        preflight(client, args.plugin_type_id, args.read_privilege, args.write_privilege)
        existing = list(client.records.list("customapi",
            filter="startswith(uniquename,'rfd_')",
            select=["customapiid", "uniquename", "bindingtype", "isfunction", "isprivate",
                    "allowedcustomprocessingsteptype", "executeprivilegename", "_plugintypeid_value"]))
        by_name = {row["uniquename"]: row for row in existing}
        for definition in definitions:
            row = by_name.get(definition["uniqueName"])
            if row:
                assert_existing_api(row, definition["body"], args.plugin_type_id)
        for definition in definitions:
            row = by_name.get(definition["uniqueName"])
            api_id = str(row["customapiid"]) if row else str(uuid5(ID_NAMESPACE, definition["uniqueName"]))
            if not row:
                # The managed metadata path supplies the solution header that
                # the SDK record-create method cannot provide.
                cli.request("/api/data/v9.2/customapis", method="POST", body={
                    **definition["body"], "customapiid": api_id,
                })
            create_children(client, cli, api_id, definition)
            actual = client.records.retrieve("customapi", api_id,
                select=["bindingtype", "isfunction", "isprivate",
                        "allowedcustomprocessingsteptype", "executeprivilegename", "_plugintypeid_value"])
            if actual is None:
                raise RegistrationError("Registered API was not returned by read-back.")
            assert_existing_api(actual, definition["body"], args.plugin_type_id)
        print(json.dumps({"mode": "registered", "apis": len(definitions),
                          "contractSha256": digest}))


if __name__ == "__main__":
    try:
        main()
    except RegistrationError as error:
        print(f"Stopped: {error}", file=sys.stderr)
        sys.exit(1)
