"""Offline schema/provisioning tests. No authentication or live writes."""

import copy
import json
import types
import unittest
from unittest.mock import Mock, patch
from uuid import UUID

from process_build_manifest import CONTRACT, build_manifest
from process_provision import (
    ManagedCli, approval_arguments, apply_metadata, await_ready, repair_created_primary_names,
)
from process_schema import (
    ATTRIBUTE_TYPES, MANIFEST, PROJECT, TARGET, SchemaError, approved_hash,
    attribute_metadata, difference, digest, load_manifest, table_metadata, validate_manifest,
)
from process_seed import expected_rows, inspect_seed, provision_seed, publication_readiness


def ready_snapshot(manifest):
    result = {}
    for table in manifest["tables"]:
        attributes, relationships = [], []
        for field in table["columns"]:
            attribute = attribute_metadata(field)
            attribute.update(LogicalName=field["logical_name"], AttributeType=ATTRIBUTE_TYPES[field["type"]])
            if field["type"] == "lookup":
                attribute["Targets"] = [field["target"]]
                relationships.append({
                    "SchemaName": field["relationship"],
                    "ReferencingAttribute": field["logical_name"],
                    "ReferencingEntityNavigationPropertyName": field["logical_name"],
                    "CascadeConfiguration": {
                        "Delete": field["delete"], "Assign": "NoCascade", "Merge": field["merge"],
                        "Reparent": "NoCascade", "Share": "NoCascade", "Unshare": "NoCascade",
                    },
                })
            attributes.append(attribute)
        result[table["logical_name"]] = {
            "OwnershipType": table["ownership"], "EntitySetName": table["entity_set"],
            "PrimaryIdAttribute": table["primary_id"], "PrimaryNameAttribute": table["primary_name"],
            "IsActivity": False, "IsManaged": False, "IsOptimisticConcurrencyEnabled": True,
            "TableType": "Standard", "in_solution": True,
            "Attributes": attributes, "Relationships": relationships,
            "Keys": [{
                "SchemaName": k["name"], "KeyAttributes": k["columns"], "EntityKeyIndexStatus": "Active",
            } for k in table["keys"]],
        }
    return result


class FakeRecords:
    def __init__(self):
        self.rows = {}
        self.writes = []
        self.fail_table = None

    def list(self, table, **kwargs):
        return list(self.rows.get(table, {}).values())

    def create(self, table, body):
        if self.fail_table == table:
            raise SchemaError("Simulated create failure.")
        row = {}
        for field, value in body.items():
            if field.endswith("@odata.bind"):
                row[f"_{field[:-11]}_value"] = value.split("(")[1].rstrip(")")
            else:
                row[field] = value
        key = row[table + "id"]
        if key in self.rows.setdefault(table, {}):
            raise SchemaError("Duplicate primary key.")
        self.rows[table][key] = row
        self.writes.append(("create", table, copy.deepcopy(body)))
        return key

    def update(self, table, key, changes):
        self.rows[table][key].update(changes)
        self.writes.append(("update", table, dict(changes)))


class SchemaTests(unittest.TestCase):
    def setUp(self):
        self.manifest = load_manifest()
        self.snapshot = ready_snapshot(self.manifest)
        self.records = FakeRecords()
        self.client = types.SimpleNamespace(records=self.records)

    def test_generated_manifest_matches_service_contract(self):
        contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
        self.assertEqual(build_manifest(contract), self.manifest)

    def test_exact_seven_standard_tables_and_ownership(self):
        self.assertEqual(len(self.manifest["tables"]), 7)
        self.assertEqual([t["ownership"] for t in self.manifest["tables"]].count("OrganizationOwned"), 3)
        self.assertTrue(all(t["table_type"] == "Standard" for t in self.manifest["tables"]))

    def test_all_source_lookup_deletes_preserve_history(self):
        fields = [f for t in self.manifest["tables"] for f in t["columns"] if f["type"] == "lookup"]
        self.assertTrue(all(f["delete"] in ("RemoveLink", "Restrict") for f in fields))
        self.assertTrue(all(f["delete"] == "RemoveLink" for f in fields if f["target"] == "incident"))

    def test_sensitive_identity_fields_are_secured_but_not_keyed(self):
        process = next(t for t in self.manifest["tables"] if t["logical_name"] == "rfd_emailprocess")
        secured = {f["logical_name"] for f in process["columns"] if f.get("secured")}
        self.assertTrue({"rfd_internetmessageid", "rfd_actualfrom", "rfd_replyto"} <= secured)
        self.assertFalse(secured & {c for k in process["keys"] for c in k["columns"]})

    def test_hash_approval_rejects_changed_manifest(self):
        approved_hash(self.manifest, digest(self.manifest))
        changed = copy.deepcopy(self.manifest)
        changed["seed"]["version"] += 1
        with self.assertRaises(SchemaError):
            approved_hash(changed, digest(self.manifest))

    def test_apply_requires_every_explicit_target_argument(self):
        args = types.SimpleNamespace(
            apply=True, expected_manifest_sha256=digest(self.manifest),
            expected_url=TARGET["url"], expected_solution=TARGET["solution"],
            expected_publisher=TARGET["publisher"], expected_identity=TARGET["identity"],
        )
        approval_arguments(args, self.manifest)
        for field in ("expected_url", "expected_solution", "expected_publisher", "expected_identity"):
            bad = copy.copy(args)
            setattr(bad, field, None)
            with self.subTest(field=field), self.assertRaises(SchemaError):
                approval_arguments(bad, self.manifest)

    def test_dry_run_plan_has_only_additive_operations(self):
        report = difference(self.manifest, {})
        self.assertFalse(report["schema_ready"])
        self.assertEqual(sum(o["kind"] == "table" for o in report["changes"]), 7)
        self.assertTrue(all(o["kind"] in ("table", "column", "lookup", "key") for o in report["changes"]))
        self.assertEqual(report["conflicts"], [])

    def test_matching_schema_is_ready_and_noop(self):
        report = difference(self.manifest, self.snapshot)
        self.assertTrue(report["schema_ready"])
        self.assertEqual(report["changes"], [])

    def test_unknown_additional_columns_are_never_deleted(self):
        self.snapshot["rfd_emailprocess"]["Attributes"].append({"LogicalName": "rfd_unknown"})
        self.assertEqual(difference(self.manifest, self.snapshot)["changes"], [])

    def test_incompatible_existing_metadata_blocks(self):
        for prop, wrong in (
            ("OwnershipType", "OrganizationOwned"), ("IsManaged", True),
            ("IsOptimisticConcurrencyEnabled", False), ("in_solution", False),
            ("TableType", "Elastic"), ("PrimaryNameAttribute", "rfd_other"),
        ):
            snapshot = copy.deepcopy(self.snapshot)
            snapshot["rfd_emailprocess"][prop] = wrong
            with self.subTest(prop=prop):
                self.assertTrue(difference(self.manifest, snapshot)["conflicts"])

    def test_lookup_cascade_mismatch_blocks(self):
        self.snapshot["rfd_emailprocessevent"]["Relationships"][0]["CascadeConfiguration"]["Delete"] = "Cascade"
        self.assertTrue(difference(self.manifest, self.snapshot)["conflicts"])

    def test_navigation_casing_mismatch_blocks(self):
        self.snapshot["rfd_emailprocessevent"]["Relationships"][0]["ReferencingEntityNavigationPropertyName"] = "rfd_Process"
        self.assertTrue(difference(self.manifest, self.snapshot)["conflicts"])

    def test_unsupported_note_relationship_is_a_prewrite_conflict(self):
        snapshot = {"_source_capabilities": {"annotation": False}}
        report = difference(self.manifest, snapshot)
        if any(f.get("target") == "annotation" for t in self.manifest["tables"] for f in t["columns"]):
            self.assertTrue(any("unsupported-lookup-target" in c for c in report["conflicts"]))
        else:
            self.assertFalse(report["conflicts"])

    def test_active_keys_are_mandatory(self):
        for state in ("Pending", "InProgress", "Failed", None):
            snapshot = copy.deepcopy(self.snapshot)
            snapshot["rfd_emailprocess"]["Keys"][0]["EntityKeyIndexStatus"] = state
            with self.subTest(state=state):
                report = difference(self.manifest, snapshot)
                self.assertFalse(report["schema_ready"])
                self.assertTrue(report["pending_keys"])
                with self.assertRaises(SchemaError):
                    provision_seed(self.client, self.manifest, snapshot)
        self.assertFalse(self.records.writes)

    def test_conflicting_key_columns_block(self):
        self.snapshot["rfd_emailprocess"]["Keys"][0]["KeyAttributes"] = ["rfd_name"]
        self.assertTrue(difference(self.manifest, self.snapshot)["conflicts"])

    def test_composite_key_metadata_order_is_not_a_false_conflict(self):
        self.snapshot["rfd_processstagedefinition"]["Keys"][0]["KeyAttributes"].reverse()
        self.assertFalse(difference(self.manifest, self.snapshot)["conflicts"])

    def test_required_and_secure_column_drift_block(self):
        for prop, wrong in (("MaxLength", 40), ("IsSecured", False), ("AttributeType", "Memo")):
            snapshot = copy.deepcopy(self.snapshot)
            field = next(f for f in snapshot["rfd_emailprocess"]["Attributes"] if f["LogicalName"] == "rfd_internetmessageid")
            field[prop] = wrong
            with self.subTest(prop=prop):
                self.assertTrue(difference(self.manifest, snapshot)["conflicts"])

    def test_manifest_rejects_cascade_and_wrong_target(self):
        for mutation in ("cascade", "target", "ownership"):
            manifest = copy.deepcopy(self.manifest)
            if mutation == "cascade":
                next(f for f in manifest["tables"][1]["columns"] if f["type"] == "lookup")["delete"] = "Cascade"
            elif mutation == "target":
                manifest["target"]["url"] = "https://other.example"
            else:
                manifest["tables"][0]["ownership"] = "UserOwned"
            with self.subTest(mutation=mutation), self.assertRaises(SchemaError):
                validate_manifest(manifest)

    def test_manifest_graph_is_classification_first_with_opaque_agent(self):
        graph = self.manifest["seed"]
        self.assertEqual(graph["entry_stage"], "intake")
        intake = next(s for s in graph["stages"] if s["code"] == "intake")
        self.assertEqual((intake["completion_authority"], intake["phase"], intake["kind"]), ("intake", "intake", "start"))
        self.assertTrue(intake["required"])
        self.assertEqual(next(s for s in graph["stages"] if s["code"] == "card-servicing")["coverage"], "opaque")
        self.assertEqual(next(s for s in graph["stages"] if s["code"] == "reviewcase")["phase"], "review")

    def test_bad_graph_reference_is_rejected(self):
        self.manifest["seed"]["transitions"][0]["to"] = "invented-agent-tool"
        with self.assertRaises(SchemaError):
            validate_manifest(self.manifest)

    def test_duplicate_observer_authority_is_rejected(self):
        self.manifest["seed"]["stages"][0]["completion_authority"] = "case-observer"
        with self.assertRaises(SchemaError):
            validate_manifest(self.manifest)

    def test_seed_ids_are_deterministic_uuid5(self):
        rows = expected_rows(self.manifest)
        self.assertEqual(rows, expected_rows(copy.deepcopy(self.manifest)))
        self.assertTrue(all(UUID(row["id"]).version == 5 for row in rows))
        self.assertEqual(len({r["id"] for r in rows}), len(rows))

    def test_unconditional_classify_edge_has_null_branch(self):
        edge = next(r for r in expected_rows(self.manifest)
                    if r["table"] == "rfd_processtransition" and r["values"]["rfd_code"] == "classified")
        self.assertIsNone(edge["values"]["rfd_branchcode"])
        self.assertTrue(edge["values"]["rfd_required"])

    def test_routed_branches_activate_only_their_conditional_targets(self):
        graph = self.manifest["seed"]
        for code in ("card-servicing", "spam"):
            stage = next(s for s in graph["stages"] if s["code"] == code)
            edge = next(e for e in graph["transitions"] if e["from"] == "route" and e["to"] == code)
            self.assertFalse(stage["required"])
            self.assertTrue(edge["required"])
            self.assertEqual(edge["branch"], code)
        card = next(s for s in graph["stages"] if s["code"] == "card-servicing")
        self.assertEqual(card["completion_authority"], "workflow")
        self.assertIn("host invocation only", card["label"])

    def test_failed_terminations_prevent_host_derived_no_case_success(self):
        graph = self.manifest["seed"]
        self.assertFalse(graph["allow_case_free_completion"])
        self.assertEqual([s["code"] for s in graph["stages"] if s["allow_case_free_completion"]], [])
        self.assertEqual([s["code"] for s in graph["stages"] if s["requires_case"]], ["card-servicing"])
        graph["stages"][0]["allow_case_free_completion"] = True
        with self.assertRaises(SchemaError):
            validate_manifest(self.manifest)

    def test_empty_switch_cases_reach_one_observed_mock_response_host(self):
        graph = self.manifest["seed"]
        mock = next(s for s in graph["stages"] if s["code"] == "mock-response")
        self.assertEqual((mock["completion_authority"], mock["coverage"]), ("workflow", "opaque"))
        self.assertFalse(mock["required"])
        edges = [e for e in graph["transitions"] if e["to"] == "mock-response"]
        self.assertEqual({e["branch"] for e in edges}, {
            "payment-direct-debits", "disputes-fraud", "details-documents", "complaints",
        })
        self.assertTrue(all(e["required"] and e["from"] == "route" for e in edges))
        self.assertEqual(self.manifest["seed"]["version"], 1)

    def test_contact_resolution_is_only_a_planned_optional_tool_overlay(self):
        stage = next(s for s in self.manifest["seed"]["stages"] if s["code"] == "contact-lookup")
        self.assertEqual((stage["phase"], stage["completion_authority"], stage["coverage"]), ("identify", "tool", "unknown"))
        self.assertFalse(stage["required"])
        self.assertIn("planned", stage["label"])
        self.assertFalse(any("contact-lookup" in (e["from"], e["to"]) for e in self.manifest["seed"]["transitions"]))

    def test_publication_requires_matching_nonsuperseded_adapter_seed(self):
        from instrument_email_flow import validate_help_seed

        binding = validate_help_seed(self.manifest["seed"])
        profile = (PROJECT / "flow-templates" / "help-workflow.profile.example.json").read_text(encoding="utf-8")
        for mode, change_hash, expected in (("DRY_RUN_ONLY", False, True), ("SUPERSEDED_PENDING_GRAPH_ALIGNMENT", False, False), ("DRY_RUN_ONLY", True, False)):
            delta = {"mode": mode, "definitionSeed": dict(binding)}
            if change_hash:
                delta["definitionSeed"]["seedSha256"] = "0" * 64
            with self.subTest(mode=mode, change_hash=change_hash):
                with patch("pathlib.Path.read_text", side_effect=[profile, json.dumps(delta)]):
                    self.assertEqual(publication_readiness(self.manifest)["ready"], expected)

    def test_note_is_explicit_nonrelational_guid_not_fake_lookup(self):
        table = next(t for t in self.manifest["tables"] if t["logical_name"] == "rfd_emailprocessevent")
        note = next(f for f in table["columns"] if f.get("reference_target") == "annotation")
        self.assertEqual((note["type"], note["max_length"], note["reference_target"]), ("string", 36, "annotation"))
        self.assertFalse(any(f.get("target") == "annotation" for f in table["columns"]))

    def test_seed_publishes_only_after_graph_and_is_idempotent(self):
        written = provision_seed(self.client, self.manifest, self.snapshot)
        self.assertEqual(written, len(expected_rows(self.manifest)) + 1)
        self.assertEqual(self.records.writes[-1], ("update", "rfd_processdefinition", {"rfd_state": "published"}))
        self.assertTrue(inspect_seed(self.client, self.manifest, self.snapshot)["published"])
        self.assertEqual(provision_seed(self.client, self.manifest, self.snapshot), 0)

    def test_seed_failure_stays_draft_and_can_resume(self):
        self.records.fail_table = "rfd_processtransition"
        with self.assertRaises(SchemaError):
            provision_seed(self.client, self.manifest, self.snapshot)
        definition = next(iter(self.records.rows["rfd_processdefinition"].values()))
        self.assertEqual(definition["rfd_state"], "draft")
        self.records.fail_table = None
        provision_seed(self.client, self.manifest, self.snapshot)
        self.assertEqual(definition["rfd_state"], "published")

    def test_immutable_seed_conflict_never_overwrites(self):
        provision_seed(self.client, self.manifest, self.snapshot)
        next(iter(self.records.rows["rfd_processstagedefinition"].values()))["rfd_name"] = "Existing operator edit"
        count = len(self.records.writes)
        with self.assertRaises(SchemaError):
            provision_seed(self.client, self.manifest, self.snapshot)
        self.assertEqual(len(self.records.writes), count)

    def test_published_incomplete_graph_is_not_repaired(self):
        provision_seed(self.client, self.manifest, self.snapshot)
        self.records.rows["rfd_processtransition"].pop(next(iter(self.records.rows["rfd_processtransition"])))
        count = len(self.records.writes)
        with self.assertRaises(SchemaError):
            provision_seed(self.client, self.manifest, self.snapshot)
        self.assertEqual(len(self.records.writes), count)

    def test_read_only_cli_rejects_all_writes_before_subprocess(self):
        cli = object.__new__(ManagedCli)
        cli.writes = False
        cli.run = Mock()
        for verb in ("POST", "PATCH", "DELETE"):
            with self.subTest(verb=verb), self.assertRaises(SchemaError):
                cli.request("/api/data/v9.2/EntityDefinitions", verb, {})
        cli.run.assert_not_called()

    def test_metadata_errors_preserve_diagnostic_but_not_raw_response(self):
        cli = object.__new__(ManagedCli)
        cli.command = ["dataverse"]
        response = types.SimpleNamespace(
            returncode=1, stdout=json.dumps({
                "error": {"code": "0xTEST", "message": "Unsupported metadata property."},
                "unrelated": "not-to-be-logged",
            }), stderr="not-to-be-logged",
        )
        with patch("process_provision.subprocess.run", return_value=response):
            with self.assertRaisesRegex(SchemaError, "0xTEST.*Unsupported metadata property"):
                cli.run([], metadata=True)
            with self.assertRaises(SchemaError) as caught:
                cli.run([], metadata=False)
            self.assertNotIn("0xTEST", str(caught.exception))

    def test_primary_correction_requires_exact_created_ids_and_empty_table(self):
        name = "rfd_emailprocess"
        metadata_id = "9a55379a-3bd2-459f-8d79-0b16db68cede"
        self.snapshot[name]["MetadataId"] = metadata_id
        field = next(f for f in self.snapshot[name]["Attributes"] if f["LogicalName"] == "rfd_name")
        field.update(MetadataId="27ae328a-014e-4269-9297-94ee38318049", IsManaged=False, IsPrimaryName=True,
                     MaxLength=850, RequiredLevel={"Value": "None"})
        cli = types.SimpleNamespace(writes=True, request=Mock(side_effect=[copy.deepcopy(field), {}, {}]))
        with self.assertRaises(SchemaError):
            repair_created_primary_names(self.client, cli, self.manifest, self.snapshot, {name: "11111111-1111-1111-1111-111111111111"})
        cli.request.assert_not_called()
        self.records.rows[name] = {"existing": {name + "id": "existing"}}
        with self.assertRaises(SchemaError):
            repair_created_primary_names(self.client, cli, self.manifest, self.snapshot, {name: metadata_id})
        cli.request.assert_not_called()
        self.records.rows[name] = {}
        self.assertEqual(repair_created_primary_names(self.client, cli, self.manifest, self.snapshot, {name: metadata_id}), 1)
        put = cli.request.call_args_list[1].args
        self.assertEqual(put[1], "PUT")
        self.assertEqual(put[2]["MaxLength"], 200)
        self.assertEqual(put[2]["RequiredLevel"]["Value"], "ApplicationRequired")
        self.assertEqual(put[2]["MetadataId"], field["MetadataId"])

    def test_metadata_conflict_rejects_entire_apply(self):
        cli = types.SimpleNamespace(writes=True, request=Mock())
        with self.assertRaises(SchemaError):
            apply_metadata(self.client, cli, self.manifest, {"conflicts": ["drift"], "changes": []})
        cli.request.assert_not_called()

    def test_failed_existing_key_blocks_before_additive_writes(self):
        cli = types.SimpleNamespace(writes=True, request=Mock())
        with self.assertRaises(SchemaError):
            apply_metadata(self.client, cli, self.manifest, {
                "conflicts": [], "changes": [{"kind": "table", "table": "rfd_emailprocess"}],
                "pending_keys": [{"status": "Failed"}],
            })
        cli.request.assert_not_called()

    def test_inspect_seed_is_read_only(self):
        report = inspect_seed(self.client, self.manifest, self.snapshot)
        self.assertTrue(report["missing"])
        self.assertFalse(self.records.writes)

    def test_failed_key_await_never_reports_ready(self):
        self.snapshot["rfd_emailprocess"]["Keys"][0]["EntityKeyIndexStatus"] = "Failed"
        with patch("process_provision.inspect_schema", return_value=self.snapshot):
            with self.assertRaises(SchemaError):
                await_ready(self.client, None, self.manifest, "solution", 0)

    def test_table_payload_preserves_standard_ownership_security_and_concurrency(self):
        process = next(t for t in self.manifest["tables"] if t["logical_name"] == "rfd_emailprocess")
        payload = table_metadata(process)
        self.assertEqual(payload["OwnershipType"], "UserOwned")
        self.assertTrue(payload["IsOptimisticConcurrencyEnabled"])
        self.assertFalse(payload["IsActivity"])
        self.assertEqual([f["SchemaName"] for f in payload["Attributes"]], ["rfd_name"])
        field = next(f for f in process["columns"] if f["logical_name"] == "rfd_actualfrom")
        self.assertTrue(attribute_metadata(field)["IsSecured"])
        self.assertFalse(any(f["@odata.type"].endswith("LookupAttributeMetadata") for f in payload["Attributes"]))

    def test_fixture_demonstrates_both_case_cardinalities(self):
        fixture = json.loads((PROJECT / "fixtures" / "process-tracking-relations.json").read_text(encoding="utf-8"))
        links = fixture["process_case_links"]
        self.assertEqual(len({(l["process"], l["case"]) for l in links}), len(links))
        self.assertEqual(sum(l["process"] == "message-a" for l in links), 2)
        self.assertEqual(sum(l["case"] == "case-a" for l in links), 2)
        self.assertFalse(fixture["live_seed"])


if __name__ == "__main__":
    unittest.main()
