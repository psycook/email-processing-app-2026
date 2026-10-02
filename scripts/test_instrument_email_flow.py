"""Synthetic-only tests: no credentials, live definition reads, or live writes."""

import copy
import io
import json
import re
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

import instrument_email_flow as adapter


FLOW_ID = "00000000-0000-4000-8000-000000000001"
DEFINITION_ID = "00000000-0000-4000-8000-000000000002"


def source():
    return {
        "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
        "contentVersion": "1.0.0.0",
        "triggers": {
            "Validated_intake": {
                "type": "Request", "kind": "Http",
                "inputs": {
                    "schema": {
                        "type": "object",
                        "required": ["internetMessageId", "actualFrom"],
                        "properties": {
                            "internetMessageId": {"type": "string"},
                            "actualFrom": {"type": "string"},
                            "replyTo": {"type": "string"},
                        },
                    },
                },
            },
        },
        "actions": {
            "Prepare_business": {
                "type": "Compose", "inputs": "@triggerBody()", "runAfter": {},
            },
            "Business_action": {
                "type": "OpenApiConnection",
                "inputs": {
                    "host": {
                        "apiId": "/providers/Microsoft.PowerApps/apis/shared_example",
                        "connectionName": "example_business_connection",
                        "operationId": "ExampleOriginalOperation",
                    },
                    "parameters": {"original": "@outputs('Prepare_business')"},
                    "retryPolicy": {"type": "none"},
                },
                "runAfter": {"Prepare_business": ["Succeeded"]},
                "metadata": {"businessMetadataPreserved": True},
            },
            "Original_followup": {
                "type": "Compose", "inputs": "business finished",
                "runAfter": {"Business_action": ["Succeeded"]},
            },
        },
        "outputs": {},
    }


def profile():
    return {
        "schemaVersion": 1, "workflowId": FLOW_ID, "definitionId": DEFINITION_ID,
        "producerId": "reviewed-workflow-producer",
        "connectionReference": "rfd_process_dataverse",
        "observations": [{"action": "Business_action", "stageCode": "connector-call"}],
    }


def help_source():
    def invoke(operation):
        return {
            "type": "OpenApiConnection",
            "inputs": {
                "host": {"operationId": operation, "connectionName": "shared_agentnode"},
                "parameters": {"syntheticOnly": "No live prompts or customer data."},
            },
            "metadata": {"syntheticOnly": True},
        }
    card = {
        "Card_Servicing_Agent": invoke("InvokeAgent"),
        adapter.HELP_CARD_TERMINATE: {
            "type": "Terminate", "inputs": {"runStatus": "Failed", "runError": {}},
            "runAfter": {"Card_Servicing_Agent": ["Succeeded"]},
        },
    }
    default = {
        "SPAM_Response": invoke("InvokeDefinition"),
        adapter.HELP_DEFAULT_TERMINATE: {
            "type": "Terminate", "inputs": {"runStatus": "Failed", "runError": {}},
            "runAfter": {"SPAM_Response": ["Succeeded"]},
        },
    }
    return {
        "triggers": {
            adapter.HELP_TRIGGER: {
                "type": "OpenApiConnection",
                "inputs": {
                    "host": {
                        "operationId": "SharedMailboxOnNewEmailV2",
                        "apiId": "/providers/Microsoft.PowerApps/apis/shared_office365",
                        "connectionName": "shared_office365-1",
                    },
                    "parameters": {"mailboxAddress": "synthetic@example.invalid"},
                },
                "splitOn": "@triggerOutputs()?['body/value']",
            },
        },
        "actions": {
            "Classify_Email": invoke("InvokeDefinition"),
            adapter.HELP_SWITCH: {
                "type": "Switch",
                "expression": "@outputs('Classify_Email')?['body']?['structuredOutput']?['predictedCategory']",
                "runAfter": {"Classify_Email": ["Succeeded"]},
                "cases": {
                    adapter.HELP_CARD_CASE: {"case": adapter.HELP_CARD_CASE, "actions": card},
                    **{name: {"case": name, "actions": {}} for name in adapter.HELP_EMPTY_CASES},
                },
                "default": {"actions": default},
            },
            "Mock_Response_Agent": {
                **invoke("InvokeDefinition"),
                "runAfter": {adapter.HELP_SWITCH: ["Succeeded"]},
            },
        },
        "outputs": {},
    }


def help_profile():
    result = profile()
    result.update({
        "workflowId": adapter.HELP_FLOW_ID, "adapter": "help-v1",
        "observations": copy.deepcopy(adapter.HELP_OBSERVATIONS),
    })
    return result


def simulate_help(definition, category, failures=None):
    failures = failures or {}
    executed = []

    class Terminated(Exception):
        pass

    def run(actions):
        statuses, pending = {}, set(actions)
        while pending:
            ready = sorted(name for name in pending if set(actions[name].get("runAfter", {})) <= statuses.keys())
            if not ready:
                raise AssertionError("Dependency cycle")
            for name in ready:
                action = actions[name]
                after = action.get("runAfter", {})
                if not all(statuses[key] in allowed for key, allowed in after.items()):
                    status = "Skipped"
                else:
                    executed.append(name)
                    if action["type"] == "Terminate":
                        raise Terminated(action["inputs"]["runStatus"])
                    if action["type"] == "Scope":
                        status = run(action["actions"])
                    elif action["type"] == "Switch":
                        branch = action["cases"].get(category, action["default"])
                        status = run(branch["actions"])
                    else:
                        status = failures.get(name, "Succeeded")
                statuses[name] = status
                pending.remove(name)
        referenced = {key for action in actions.values() for key in action.get("runAfter", {})}

        def failed(name):
            if statuses[name] in ("Failed", "TimedOut"):
                return True
            if statuses[name] == "Skipped":
                return any(failed(key) for key in actions[name].get("runAfter", {}))
            return False
        return "Failed" if any(failed(name) for name in set(actions) - referenced) else "Succeeded"

    try:
        result = run(definition["actions"])
    except Terminated as exc:
        result = str(exc)
    return executed, result


def snapshot_and_guard(definition=None):
    definition = definition or source()
    snapshot = {
        "environmentUrl": adapter.ENVIRONMENT_URL,
        "workflowid": FLOW_ID, "@odata.etag": 'W/"123456"',
        "statecode": 0, "clientdata": json.dumps({"properties": {"definition": definition}}),
    }
    guard = {
        "environmentUrl": adapter.ENVIRONMENT_URL, "workflowId": FLOW_ID,
        "etag": snapshot["@odata.etag"],
        "sourceSha256": adapter.source_digest(snapshot["clientdata"]),
        "knownOperations": adapter.operation_inventory(definition),
    }
    return snapshot, guard


def walk(actions):
    for name, action in actions.items():
        yield name, action
        if "actions" in action:
            yield from walk(action["actions"])


def simulate(actions, failures=None):
    """Subset dependency model, not a substitute for the managed runtime pilot."""
    failures = failures or {}
    statuses = {}
    pending = set(actions)
    while pending:
        ready = sorted(n for n in pending if set(actions[n]["runAfter"]) <= statuses.keys())
        if not ready:
            raise AssertionError("Cycle in test definition")
        for name in ready:
            action = actions[name]
            if not all(statuses[dep] in states for dep, states in action["runAfter"].items()):
                state = "Skipped"
            elif action["type"] == "Scope":
                _, state = simulate(action["actions"], failures)
            else:
                state = failures.get(name, "Succeeded")
            statuses[name] = state
            pending.remove(name)
    has_successor = {dep for action in actions.values() for dep in action["runAfter"]}
    leaves = set(actions) - has_successor

    def leaf_failed(name):
        if statuses[name] in ("Failed", "TimedOut"):
            return True
        if statuses[name] == "Skipped":
            return any(leaf_failed(dep) for dep in actions[name]["runAfter"])
        return False

    return statuses, "Failed" if any(leaf_failed(name) for name in leaves) else "Succeeded"


class TransformTests(unittest.TestCase):
    def test_business_and_definition_properties_are_unchanged(self):
        original = source()
        untouched = copy.deepcopy(original)
        result = adapter.transform(original, profile())
        self.assertEqual(original, untouched)
        for key, value in original.items():
            if key != "actions":
                self.assertEqual(result[key], value)
        for name, action in original["actions"].items():
            self.assertEqual(result["actions"][name], action)
        self.assertEqual(len(result["actions"]), len(original["actions"]) + 2)

    def test_idempotent_transform_and_tamper_rejection(self):
        first = adapter.transform(source(), profile())
        self.assertEqual(adapter.transform(first, profile()), first)
        first["actions"]["EP_Intake"]["actions"]["EP_Intake_Write"]["inputs"]["retryPolicy"]["count"] = 3
        with self.assertRaisesRegex(adapter.AdapterError, "COLLISION_OR_TAMPERING"):
            adapter.transform(first, profile())

    def test_profile_change_is_not_silently_reinstrumented(self):
        first = adapter.transform(source(), profile())
        changed = profile()
        changed["definitionId"] = FLOW_ID
        with self.assertRaisesRegex(adapter.AdapterError, "COLLISION_OR_TAMPERING"):
            adapter.transform(first, changed)

    def test_no_business_dependency_on_telemetry(self):
        candidate = adapter.transform(source(), profile())
        for name, action in source()["actions"].items():
            self.assertFalse(any(dep.startswith("EP_") for dep in candidate["actions"][name]["runAfter"]))
            self.assertEqual(action, candidate["actions"][name])

    def test_outage_does_not_skip_or_retry_original_business_action(self):
        candidate = adapter.transform(source(), profile())
        for failure in ("Failed", "TimedOut"):
            failures = {"EP_Intake_Write": failure, "EP_Business_action_Write": failure}
            statuses, status = simulate(candidate["actions"], failures)
            self.assertEqual(status, "Succeeded")
            self.assertEqual(statuses["Business_action"], "Succeeded")
            self.assertEqual(statuses["Original_followup"], "Succeeded")
            self.assertEqual(candidate["actions"]["Business_action"]["inputs"]["retryPolicy"], {"type": "none"})

    def test_original_failure_and_prerequisite_skip_are_not_swallowed(self):
        candidate = adapter.transform(source(), profile())
        for action in ("Prepare_business", "Business_action"):
            for failure in ("Failed", "TimedOut"):
                with self.subTest(action=action, failure=failure):
                    baseline, baseline_status = simulate(source()["actions"], {action: failure})
                    observed, status = simulate(candidate["actions"], {action: failure})
                    self.assertEqual(status, baseline_status)
                    self.assertEqual(status, "Failed")
                    self.assertEqual(observed["EP_Business_action"], "Skipped")
                    for name, state in baseline.items():
                        self.assertEqual(observed[name], state)

    def test_scope_internal_failure_and_skipped_prerequisites_are_settled(self):
        candidate = adapter.transform(source(), profile())
        for part in ("Identity", "Payload", "Write"):
            for failure in ("Failed", "TimedOut"):
                failures = {f"EP_Intake_{part}": failure, f"EP_Business_action_{part}": failure}
                _, status = simulate(candidate["actions"], failures)
                self.assertEqual(status, "Succeeded")
        for name in ("EP_Intake", "EP_Business_action"):
            scoped = candidate["actions"][name]
            self.assertEqual(scoped["actions"][f"{name}_Settled"]["inputs"], {"observationOnly": True})
            self.assertEqual(scoped["actions"][f"{name}_Settled"]["runAfter"],
                             {f"{name}_Write": adapter.ALL_STATUSES})
            self.assertNotIn("Skipped", sum(scoped["runAfter"].values(), []))

    def test_identifiers_are_full_guid_allocations_outside_connector_retries(self):
        candidate = adapter.transform(source(), profile())
        for name, action in walk(candidate["actions"]):
            if name.startswith("EP_") and name.endswith("_Identity"):
                self.assertEqual(action["type"], "Compose")
                self.assertEqual(action["inputs"]["eventId"], "@guid()")
                self.assertEqual(action["inputs"]["spanId"], "@guid()")
            if name.startswith("EP_") and name.endswith("_Write"):
                self.assertNotIn("guid()", json.dumps(action))
                self.assertEqual(action["inputs"]["host"]["operationId"], "PerformUnboundAction")
                self.assertTrue(action["inputs"]["parameters"]["item/RequestJson"].startswith("@string(outputs("))
                self.assertEqual(action["inputs"]["retryPolicy"]["count"], 2)
        payload = candidate["actions"]["EP_Business_action"]["actions"]["EP_Business_action_Payload"]["inputs"]
        self.assertEqual(payload["sourceExecutionId"], "@workflow()?['run']?['name']")
        self.assertEqual(payload["stageExecutionId"], "@outputs('EP_Business_action_Identity')?['spanId']")
        self.assertEqual(len(payload["operation"]), 64)
        self.assertNotEqual(adapter.operation_id(FLOW_ID, "cases/card/step"), adapter.operation_id(FLOW_ID, "cases/default/step"))
        self.assertNotEqual(adapter.operation_id(FLOW_ID, "step"), adapter.operation_id(DEFINITION_ID, "step"))

    def test_request_attempt_is_native_run_local_not_projection_ordinal(self):
        examples = [adapter.transform(source(), profile())["actions"]]
        examples.extend(actions for _, actions in adapter.help_action_maps(
            adapter.transform(help_source(), help_profile())))
        for actions in examples:
            for name, action in walk(actions):
                if name.startswith("EP_") and name.endswith("_Payload"):
                    payload = action["inputs"]
                    self.assertEqual(payload["attempt"], 1)
                    self.assertEqual(payload["sourceExecutionId"], "@workflow()?['run']?['name']")
                    self.assertNotIn("ordinal", json.dumps(payload).lower())

    def test_no_message_content_or_inferred_auth_in_events(self):
        result = adapter.transform(source(), profile())
        intake = result["actions"]["EP_Intake"]["actions"]["EP_Intake_Payload"]["inputs"]
        self.assertEqual(intake["actualFrom"], "@triggerBody()?['actualFrom']")
        self.assertEqual(intake["replyTo"], "@triggerBody()?['replyTo']")
        self.assertEqual(intake["internetMessageId"], "@triggerBody()?['internetMessageId']")
        self.assertNotIn("processId", intake)
        event = result["actions"]["EP_Business_action"]["actions"]["EP_Business_action_Payload"]["inputs"]
        self.assertIn("ResponseJson", event["processId"])
        for payload in (intake, event):
            for forbidden in ("subject", "body", "prompt", "userAuth", "customerEmail", "contactId"):
                self.assertNotIn(forbidden, payload)
        for name, action in walk(result["actions"]):
            if name.startswith("EP_") and action["type"] != "Scope" and not name.endswith("_Settled"):
                self.assertEqual(action["runtimeConfiguration"], adapter.SECURE)

    def test_failed_skipped_and_timeout_runafter_are_excluded(self):
        for states in (["Failed"], ["Skipped"], ["TimedOut"], adapter.ALL_STATUSES, []):
            sample = source()
            sample["actions"]["Business_action"]["runAfter"]["Prepare_business"] = states
            with self.assertRaisesRegex(adapter.AdapterError, "UNSUPPORTED_FAILURE_OR_SKIP_RUNAFTER"):
                adapter.transform(sample, profile())

    def test_managed_control_and_termination_shapes_are_excluded(self):
        for kind in ("Scope", "Switch", "If", "Foreach", "Until", "Terminate", "InvokeDefinition", "InvokeAgent", "Response"):
            sample = source()
            sample["actions"]["Business_action"]["type"] = kind
            with self.assertRaisesRegex(adapter.AdapterError, "UNSUPPORTED_CONTROL_OR_MANAGED_ACTION"):
                adapter.transform(sample, profile())

    def test_actual_help_trigger_is_not_silently_rewritten(self):
        sample = source()
        sample["triggers"] = {
            "SharedMailboxOnNewEmailV2": {
                "type": "OpenApiConnectionNotification",
                "inputs": {"host": {"operationId": "SharedMailboxOnNewEmailV2"}},
            },
        }
        with self.assertRaisesRegex(adapter.AdapterError, "UNSUPPORTED_TRIGGER"):
            adapter.transform(sample, profile())

    def test_missing_mapping_loop_and_name_collision_fail_closed(self):
        sample = source()
        del sample["triggers"]["Validated_intake"]["inputs"]["schema"]["properties"]["actualFrom"]
        with self.assertRaisesRegex(adapter.AdapterError, "UNVERIFIED_INTAKE"):
            adapter.transform(sample, profile())
        sample = source()
        sample["actions"]["Prepare_business"]["runAfter"] = {"Original_followup": ["Succeeded"]}
        with self.assertRaisesRegex(adapter.AdapterError, "CYCLIC"):
            adapter.transform(sample, profile())
        sample = source()
        sample["actions"]["EP_custom"] = adapter.compose("original")
        with self.assertRaisesRegex(adapter.AdapterError, "COLLISION"):
            adapter.transform(sample, profile())

    def test_generated_scope_and_nested_names_cannot_collide(self):
        for name in ("Intake", "Intake_Identity", "Business_action_Identity"):
            sample, config = source(), profile()
            sample["actions"][name] = copy.deepcopy(sample["actions"]["Business_action"])
            config["observations"].append({"action": name, "stageCode": "second-call"})
            with self.subTest(name=name), self.assertRaisesRegex(adapter.AdapterError, "GENERATED_ACTION_NAME_COLLISION"):
                adapter.transform(sample, config)

    def test_malformed_shapes_report_explicit_errors(self):
        for malformed in (None, [], {"actions": []}):
            with self.subTest(value=malformed), self.assertRaisesRegex(adapter.AdapterError, "INVALID_DEFINITION"):
                adapter.transform(malformed, profile())
        for malformed in (None, [], "not-an-action"):
            sample = source()
            sample["actions"]["Business_action"] = malformed
            with self.subTest(value=malformed), self.assertRaisesRegex(adapter.AdapterError, "INVALID_ACTION"):
                adapter.transform(sample, profile())
        sample = source()
        sample["triggers"]["Validated_intake"] = []
        with self.assertRaisesRegex(adapter.AdapterError, "INVALID_TRIGGER"):
            adapter.transform(sample, profile())
        for field, malformed in (("properties", []), ("required", None)):
            sample = source()
            sample["triggers"]["Validated_intake"]["inputs"]["schema"][field] = malformed
            with self.subTest(field=field), self.assertRaises(adapter.AdapterError):
                adapter.transform(sample, profile())
        for malformed in (None, [], {"arbitrary": "payload"}):
            with self.subTest(profile=malformed), self.assertRaisesRegex(adapter.AdapterError, "UNSUPPORTED_PROFILE"):
                adapter.transform(source(), malformed)


class GuardTests(unittest.TestCase):
    def test_exact_hash_etag_environment_flow_operations(self):
        snapshot, guard = snapshot_and_guard()
        adapter.guard_snapshot(snapshot, guard)
        for key, value, error in (
            ("environmentUrl", "https://another.crm.dynamics.com", "ENVIRONMENT_MISMATCH"),
            ("workflowid", DEFINITION_ID, "FLOW_ID_MISMATCH"),
            ("@odata.etag", 'W/"123457"', "ETAG_MISMATCH"),
            ("clientdata", snapshot["clientdata"] + " ", "SOURCE_HASH_MISMATCH"),
        ):
            changed = dict(snapshot)
            changed[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(adapter.AdapterError, error):
                adapter.guard_snapshot(changed, guard)
        changed = copy.deepcopy(guard)
        changed["knownOperations"][0]["operationId"] = "ChangedOperation"
        with self.assertRaisesRegex(adapter.AdapterError, "KNOWN_OPERATIONS_MISMATCH"):
            adapter.guard_snapshot(snapshot, changed)

    def test_missing_service_etag_is_not_approximated_from_version(self):
        snapshot, guard = snapshot_and_guard()
        del snapshot["@odata.etag"]
        snapshot["versionnumber"] = 123456
        with self.assertRaisesRegex(adapter.AdapterError, "MISSING_OR_INVALID_ETAG"):
            adapter.guard_snapshot(snapshot, guard)

    def test_sdk_read_is_only_retrieve_and_never_update(self):
        client = Mock()
        snapshot, _ = snapshot_and_guard()
        client.records.retrieve.return_value = snapshot
        read = adapter.retrieve_snapshot(client, adapter.ENVIRONMENT_URL, FLOW_ID)
        self.assertEqual(read, snapshot)
        client.records.retrieve.assert_called_once_with(
            "workflow", FLOW_ID,
            select=["workflowid", "clientdata", "statecode", "versionnumber", "ismanaged"],
        )
        self.assertEqual(client.mock_calls[0][0], "records.retrieve")
        self.assertEqual(len(client.mock_calls), 1)

    def test_prepare_and_verify_are_reproducible_and_do_not_mutate_source(self):
        snapshot, guard = snapshot_and_guard()
        original = copy.deepcopy(snapshot)
        package = adapter.prepare(snapshot, guard, profile())
        self.assertEqual(snapshot, original)
        self.assertFalse(package["publishable"])
        self.assertEqual(package["mode"], "DRY_RUN_ONLY")
        self.assertEqual(package["connectionBinding"]["logicalName"], "rfd_process_dataverse")
        self.assertIsNone(package["connectionBinding"]["physicalConnectionId"])
        self.assertEqual(package["connectionBinding"]["status"], "REQUIRES_PARENT_RELEASEGATE")
        self.assertEqual(adapter.verify_package(package, snapshot)["guardMatches"], True)
        package["candidateClientdata"]["properties"]["definition"]["actions"]["Business_action"]["inputs"] = {}
        with self.assertRaisesRegex(adapter.AdapterError, "CANDIDATE_HASH_MISMATCH"):
            adapter.verify_package(package, snapshot)

    def test_profile_cannot_target_different_flow(self):
        snapshot, guard = snapshot_and_guard()
        changed = profile()
        changed["workflowId"] = DEFINITION_ID
        with self.assertRaisesRegex(adapter.AdapterError, "PROFILE_FLOW_ID_MISMATCH"):
            adapter.prepare(snapshot, guard, changed)

    def test_envelope_and_recomputed_hash_tampering_are_rejected(self):
        snapshot, guard = snapshot_and_guard()
        package = adapter.prepare(snapshot, guard, profile())
        package["candidateClientdata"]["properties"]["connectionReferences"] = {"changed": True}
        with self.assertRaisesRegex(adapter.AdapterError, "CLIENTDATA_ENVELOPE_CHANGED"):
            adapter.verify_package(package, snapshot)
        package = adapter.prepare(snapshot, guard, profile())
        candidate = package["candidateClientdata"]["properties"]["definition"]
        candidate["actions"]["EP_Intake"]["actions"]["EP_Intake_Write"]["inputs"]["parameters"]["actionName"] = "WrongApi"
        package["candidateDefinitionSha256"] = adapter.digest(candidate)
        with self.assertRaisesRegex(adapter.AdapterError, "CANDIDATE_NOT_REPRODUCIBLE"):
            adapter.verify_package(package, snapshot)

    def test_missing_guards_and_unknown_profile_fields_fail_closed(self):
        snapshot, guard = snapshot_and_guard()
        for field in ("etag", "sourceSha256", "knownOperations"):
            changed = copy.deepcopy(guard)
            changed.pop(field)
            with self.subTest(field=field), self.assertRaises(adapter.AdapterError):
                adapter.guard_snapshot(snapshot, changed)
        changed = profile()
        changed["bodyExpression"] = "@triggerBody()"
        with self.assertRaisesRegex(adapter.AdapterError, "UNSUPPORTED_PROFILE"):
            adapter.transform(source(), changed)
        with self.assertRaisesRegex(adapter.AdapterError, "INVALID_GUID"):
            adapter.guid("00000000-0000-0000-0000-000000000000")

    def test_repository_backups_are_refused(self):
        for path in (adapter.PROJECT, adapter.PROJECT / "backups", adapter.PROJECT / ".ignored"):
            with self.assertRaisesRegex(adapter.AdapterError, "OUTSIDE_PROJECT"):
                adapter.private_directory(path)

    def test_private_directory_requires_existing_ignore_all(self):
        path = Path("C:\\PrivateInstrumentationReview").resolve()
        with patch.object(Path, "is_dir", return_value=True), \
             patch.object(Path, "exists", return_value=False), \
             patch.object(Path, "is_file", return_value=False):
            with self.assertRaisesRegex(adapter.AdapterError, "IGNORE_ALL"):
                adapter.private_directory(path)

    def test_prepare_writes_backup_before_candidate_and_verifies_both(self):
        snapshot, guard = snapshot_and_guard()
        stored = {}
        target = Path("C:\\PrivateInstrumentationReview")

        def reader(path):
            if str(path) == "source":
                return snapshot
            if str(path) == "guard":
                return guard
            if str(path) == "profile":
                return profile()
            return stored[path]

        output = io.StringIO()
        with patch.object(adapter, "private_input", side_effect=lambda p: p), \
             patch.object(adapter, "private_directory", return_value=target), \
             patch.object(adapter, "load_json", side_effect=reader), \
             patch.object(adapter, "exclusive_json", side_effect=lambda p, v: stored.update({p: v})), \
             patch.object(Path, "exists", return_value=False), redirect_stdout(output):
            code = adapter.main(["prepare", "--snapshot", "source", "--guard", "guard",
                                 "--profile", "profile", "--private-directory", str(target)])
        self.assertEqual(code, 0)
        self.assertTrue(next(iter(stored)).name.endswith(".source-backup.json"))
        self.assertEqual(next(iter(stored.values())), snapshot)
        self.assertTrue(json.loads(output.getvalue())["packageVerified"])
        self.assertNotIn("clientdata", output.getvalue())

    def test_existing_backups_are_not_overwritten(self):
        snapshot, guard = snapshot_and_guard()
        errors = io.StringIO()
        with patch.object(adapter, "private_input", side_effect=lambda p: p), \
             patch.object(adapter, "private_directory", return_value=Path("C:\\PrivateInstrumentationReview")), \
             patch.object(adapter, "load_json", side_effect=[snapshot, guard, profile()]), \
             patch.object(Path, "exists", return_value=True), \
             patch.object(adapter, "exclusive_json") as writer, redirect_stderr(errors):
            code = adapter.main(["prepare", "--snapshot", "source", "--guard", "guard",
                                 "--profile", "profile", "--private-directory", "private"])
        self.assertEqual(code, 2)
        writer.assert_not_called()
        self.assertIn("REFUSING_OVERWRITE", errors.getvalue())

    def test_failed_candidate_write_never_claims_success(self):
        snapshot, guard = snapshot_and_guard()
        errors, output = io.StringIO(), io.StringIO()
        with patch.object(adapter, "private_input", side_effect=lambda p: p), \
             patch.object(adapter, "private_directory", return_value=Path("C:\\PrivateInstrumentationReview")), \
             patch.object(adapter, "load_json", side_effect=[snapshot, guard, profile()]), \
             patch.object(Path, "exists", return_value=False), \
             patch.object(adapter, "exclusive_json", side_effect=[None, OSError("sensitive data")]) as writer, \
             redirect_stderr(errors), redirect_stdout(output):
            code = adapter.main(["prepare", "--snapshot", "source", "--guard", "guard",
                                 "--profile", "profile", "--private-directory", "private"])
        self.assertEqual(code, 2)
        self.assertEqual(writer.call_count, 2)
        self.assertTrue(writer.call_args_list[0].args[0].name.endswith(".source-backup.json"))
        self.assertEqual(output.getvalue(), "")
        self.assertNotIn("sensitive data", errors.getvalue())

    def test_inspection_is_explicitly_not_preparation_or_shape_approval(self):
        sample = source()
        sample["actions"]["Business_action"]["type"] = "InvokeDefinition"
        snapshot, _ = snapshot_and_guard(sample)
        output = io.StringIO()
        with patch.object(adapter, "private_input", side_effect=lambda p: p), \
             patch.object(adapter, "load_json", return_value=snapshot), redirect_stdout(output):
            code = adapter.main(["inspect", "--snapshot", "private-source"])
        self.assertEqual(code, 0)
        result = json.loads(output.getvalue())
        self.assertEqual(result["status"], "INVENTORY_ONLY_NOT_A_PREPARATION")
        self.assertIsNone(result["automaticPatchSupported"])

    def test_malformed_cli_input_has_no_traceback(self):
        for sample in ([], {"environmentUrl": "https://[malformed"}):
            errors = io.StringIO()
            with patch.object(adapter, "private_input", side_effect=lambda p: p), \
                 patch.object(adapter, "load_json", return_value=sample), redirect_stderr(errors):
                code = adapter.main(["inspect", "--snapshot", "private-source"])
            self.assertEqual(code, 2)
            self.assertNotIn("Traceback", errors.getvalue())
            self.assertNotIn("malformed", errors.getvalue())

    def test_unsupported_cli_has_no_partial_backup_or_source_leak(self):
        sample = source()
        sample["actions"]["Business_action"]["type"] = "InvokeDefinition"
        sample["actions"]["Business_action"]["inputs"]["secret"] = "SHOULD_NEVER_BE_PRINTED"
        snapshot, guard = snapshot_and_guard(sample)
        errors = io.StringIO()
        with patch.object(adapter, "private_input", side_effect=lambda p: p), \
             patch.object(adapter, "private_directory", return_value=Path("C:\\PrivateInstrumentationReview")), \
             patch.object(adapter, "load_json", side_effect=[snapshot, guard, profile()]), \
             patch.object(adapter, "exclusive_json") as writer, redirect_stderr(errors):
            code = adapter.main(["prepare", "--snapshot", "source", "--guard", "guard",
                                 "--profile", "profile", "--private-directory", "private"])
        self.assertEqual(code, 2)
        writer.assert_not_called()
        self.assertNotIn("SHOULD_NEVER_BE_PRINTED", errors.getvalue())
        self.assertIn("UNSUPPORTED_CONTROL", errors.getvalue())


class CaseTemplateTests(unittest.TestCase):
    def test_case_is_linked_explicitly_and_closure_is_not_an_observer_fact(self):
        fragment = adapter.case_workflow_fragment(profile())
        actions = fragment["actionsToAdd"]
        link = actions["EP_Link_case"]["actions"]["EP_Link_case_Payload"]["inputs"]
        self.assertEqual(link["caseId"], "@body('Create_case')?['incidentid']")
        self.assertEqual(link["processId"], "@triggerBody()?['processId']")
        self.assertTrue(link["blocksCompletion"])
        for name in ("EP_Case_progress", "EP_Close_case"):
            action = actions[name]
            payload = action["actions"][f"{name}_Payload"]["inputs"]
            self.assertEqual(payload["eventType"], "completed")
            self.assertEqual(payload["caseId"], link["caseId"])
            self.assertNotIn("caseState", payload)
            self.assertNotIn("caseStatus", payload)
        close = actions["EP_Close_case"]["actions"]["EP_Close_case_Payload"]["inputs"]
        self.assertEqual(close["stageCode"], "case-closure-attempt")
        self.assertNotIn("RecordCaseLifecycle", json.dumps(fragment))
        self.assertNotIn("customerEmail", json.dumps(fragment))
        self.assertNotIn("CloseIncident", json.dumps(fragment))

    def test_checked_in_generated_examples_are_current(self):
        folder = adapter.PROJECT / "flow-templates"
        self.assertEqual(adapter.load_json(folder / "case-workflow.actions.example.json"),
                         adapter.case_workflow_fragment(profile()))
        self.assertEqual(adapter.load_json(folder / "simple-workflow.instrumented.example.json"),
                         adapter.transform(source(), profile()))
        self.assertEqual(adapter.load_json(folder / "simple-workflow.source.example.json"), source())
        self.assertEqual(adapter.load_json(folder / "simple-workflow.profile.example.json"), profile())
        bindings = adapter.load_json(folder / "deployment-bindings.example.json")
        self.assertIsNone(bindings["connectionReference"]["physicalConnectionId"])
        self.assertFalse(bindings["publishable"])

    def test_generated_wire_fields_match_final_server_command_and_api_contract(self):
        contract = adapter.load_json(adapter.PROJECT / "server" / "process-contract.json")
        dto = (adapter.PROJECT / "server" / "EmailProcess.Plugin" / "Contracts.cs").read_text(encoding="utf-8")
        command = dto.split("public sealed class Command", 1)[1].split("public sealed class Receipt", 1)[0]
        fields = {
            name[0].lower() + name[1:]
            for name in re.findall(r"public\s+[\w?]+\s+(\w+)\s*\{\s*get;", command)
        }
        self.assertEqual(contract["api"]["input"], {"name": "RequestJson", "type": "String"})
        self.assertEqual(contract["api"]["output"], {"name": "ResponseJson", "type": "String"})
        examples = [
            adapter.transform(source(), profile())["actions"],
            adapter.case_workflow_fragment(profile())["actionsToAdd"],
        ]
        examples.extend(scope for _, scope in adapter.help_action_maps(
            adapter.transform(help_source(), help_profile())))
        for actions in examples:
            for name, action in walk(actions):
                if name.startswith("EP_") and name.endswith("_Payload"):
                    self.assertLessEqual(set(action["inputs"]), fields)
                    self.assertEqual(action["inputs"]["schemaVersion"], 1)
                    payload = action["inputs"]
                    self.assertTrue({"state", "cursor", "pageSize"}.isdisjoint(payload))
                    if payload["eventType"] in ("received", "case-linked"):
                        self.assertTrue({"stageExecutionId", "parentExecutionId", "stageCode"}.isdisjoint(payload))
                    if payload["eventType"] == "received":
                        self.assertNotIn("caseId", payload)
                        self.assertNotIn("contactId", payload)
                if name.startswith("EP_") and name.endswith("_Write"):
                    self.assertIn(action["inputs"]["parameters"]["actionName"], contract["api"]["actions"])


class HelpAdapterTests(unittest.TestCase):
    def test_exact_original_business_inputs_and_failed_terminations_preserved(self):
        original = help_source()
        candidate, changes = adapter.transform_help(original, help_profile())
        self.assertEqual(len(changes), 7)
        adapter.verify_help_business(original, candidate, changes)
        for path, scope in adapter.help_action_maps(original):
            generated = dict(adapter.help_action_maps(candidate))[path]
            for name, action in scope.items():
                if "inputs" in action:
                    self.assertEqual(generated[name]["inputs"], action["inputs"])
        switch = candidate["actions"][adapter.HELP_SWITCH]
        for branch in adapter.HELP_EMPTY_CASES:
            self.assertEqual(set(switch["cases"][branch]["actions"]), {adapter.route_scope_name(branch)})
        for change in changes:
            for action, statuses in change["before"].items():
                self.assertEqual(change["after"][action], statuses)

    def test_success_and_every_business_failure_preserve_business_path(self):
        original = help_source()
        candidate = adapter.transform(original, help_profile())
        business_names = set(name for _, scope in adapter.help_action_maps(original) for name in scope)
        for category in [adapter.HELP_CARD_CASE, "Other", *adapter.HELP_EMPTY_CASES]:
            for failed_action in [None, "Classify_Email", "Card_Servicing_Agent", "SPAM_Response", "Mock_Response_Agent"]:
                for failure in ("Failed", "TimedOut"):
                    failures = {failed_action: failure} if failed_action else {}
                    baseline, status = simulate_help(original, category, failures)
                    observed, observed_status = simulate_help(candidate, category, failures)
                    with self.subTest(category=category, action=failed_action, failure=failure):
                        self.assertEqual([name for name in observed if name in business_names], baseline)
                        self.assertEqual(observed_status, status)
                        for name in business_names:
                            self.assertLessEqual(observed.count(name), 1)

    def test_telemetry_outage_still_executes_originals_and_preserves_termination(self):
        original = help_source()
        candidate = adapter.transform(original, help_profile())
        business_names = set(name for _, scope in adapter.help_action_maps(original) for name in scope)
        all_telemetry = [
            name for _, scope in adapter.help_action_maps(candidate)
            for name, action in walk(scope)
            if name.startswith("EP_") and action["type"] != "Scope"
        ]
        for category in [adapter.HELP_CARD_CASE, "Other", *adapter.HELP_EMPTY_CASES]:
            for suffix in ("_Identity", "_Payload", "_Write"):
                for failure in ("Failed", "TimedOut"):
                    failures = {name: failure for name in all_telemetry if name.endswith(suffix)}
                    baseline, status = simulate_help(original, category)
                    observed, observed_status = simulate_help(candidate, category, failures)
                    with self.subTest(category=category, suffix=suffix, failure=failure):
                        self.assertEqual([name for name in observed if name in business_names], baseline)
                        self.assertEqual(observed_status, status)

    def test_settled_host_event_attempt_is_before_original_terminate(self):
        candidate = adapter.transform(help_source(), help_profile())
        for category, action, terminal in (
            (adapter.HELP_CARD_CASE, "Card_Servicing_Agent", adapter.HELP_CARD_TERMINATE),
            ("Other", "SPAM_Response", adapter.HELP_DEFAULT_TERMINATE),
        ):
            observed, status = simulate_help(candidate, category)
            self.assertEqual(status, "Failed")
            self.assertLess(observed.index(f"EP_{action}_Start_Write"), observed.index(action))
            self.assertLess(observed.index(f"EP_{action}_Settled_Write"), observed.index(terminal))
            self.assertNotIn("Mock_Response_Agent", observed)
        for category in adapter.HELP_EMPTY_CASES:
            observed, status = simulate_help(candidate, category)
            self.assertIn("Mock_Response_Agent", observed)
            self.assertEqual(status, "Succeeded")

    def test_start_completion_share_span_but_allocate_distinct_event_ids(self):
        candidate = adapter.transform(help_source(), help_profile())
        for _, scope in adapter.help_action_maps(candidate):
            for name, action in scope.items():
                if name.startswith("EP_") and name.endswith("_Settled"):
                    start = name.removesuffix("_Settled") + "_Start"
                    payload = action["actions"][f"{name}_Payload"]["inputs"]
                    started = scope[start]["actions"][f"{start}_Payload"]["inputs"]
                    self.assertEqual(payload["stageExecutionId"], started["stageExecutionId"])
                    self.assertEqual(payload["workflowId"], adapter.HELP_FLOW_ID)
                    self.assertEqual(payload["workflowId"], started["workflowId"])
                    self.assertNotIn("HoldingId", payload)
                    self.assertNotIn("holdingId", payload)
                    self.assertNotEqual(payload["eventId"], started["eventId"])
                    self.assertNotIn("spanId", action["actions"][f"{name}_Identity"]["inputs"])
                    self.assertNotIn("guid()", json.dumps(action["actions"][f"{name}_Write"]))
        intake = candidate["actions"]["EP_Intake"]["actions"]["EP_Intake_Payload"]["inputs"]
        self.assertEqual(intake["actualFrom"], "@triggerOutputs()?['body/from']")
        self.assertEqual(intake["replyTo"], "@triggerOutputs()?['body/replyTo']")
        self.assertEqual(intake["internetMessageId"], "@triggerOutputs()?['body/internetMessageId']")

    def test_unreviewed_shapes_and_dependency_statuses_fail_explicitly(self):
        for states in (["Failed"], ["Skipped"], ["TimedOut"], adapter.ALL_STATUSES):
            source = help_source()
            source["actions"][adapter.HELP_SWITCH]["runAfter"]["Classify_Email"] = states
            with self.assertRaisesRegex(adapter.AdapterError, "UNSUPPORTED_HELP_SWITCH"):
                adapter.transform(source, help_profile())
        source = help_source()
        source["actions"][adapter.HELP_SWITCH]["cases"]["Complaints"]["actions"]["Unexpected"] = adapter.compose("synthetic")
        with self.assertRaisesRegex(adapter.AdapterError, "UNSUPPORTED_HELP_NONEMPTY_CASE"):
            adapter.transform(source, help_profile())
        source = help_source()
        source["actions"][adapter.HELP_SWITCH]["default"]["actions"][adapter.HELP_DEFAULT_TERMINATE]["inputs"]["runStatus"] = "Succeeded"
        with self.assertRaisesRegex(adapter.AdapterError, "UNSUPPORTED_HELP_TERMINATION"):
            adapter.transform(source, help_profile())

    def test_help_transform_is_idempotent_and_rejects_tampering(self):
        candidate = adapter.transform(help_source(), help_profile())
        self.assertEqual(adapter.transform(candidate, help_profile()), candidate)
        candidate["actions"]["Classify_Email"]["inputs"]["parameters"]["tampered"] = True
        with self.assertRaisesRegex(adapter.AdapterError, "TAMPERING"):
            adapter.transform(candidate, help_profile())

    def test_preparing_existing_help_instrumentation_is_noop(self):
        candidate = adapter.transform(help_source(), help_profile())
        snapshot, guard = snapshot_and_guard(candidate)
        snapshot.update({"workflowid": adapter.HELP_FLOW_ID, "statecode": 1, "ismanaged": False})
        guard["workflowId"] = adapter.HELP_FLOW_ID
        package = adapter.prepare(snapshot, guard, help_profile())
        self.assertEqual(package["structuralDiff"], [])
        self.assertEqual(package["addedActionCount"], 0)
        self.assertTrue(adapter.verify_package(package, snapshot)["guardMatches"])

    def test_real_sdk_etag_property_and_guarded_preparation(self):
        class FakeRecord(dict):
            etag = 'W/"123456"'
        snapshot, guard = snapshot_and_guard(help_source())
        snapshot.update({"workflowid": adapter.HELP_FLOW_ID, "statecode": 1, "ismanaged": False})
        guard["workflowId"] = adapter.HELP_FLOW_ID
        record = FakeRecord(snapshot)
        del record["@odata.etag"]
        client = Mock()
        client.records.retrieve.return_value = record
        retrieved = adapter.retrieve_snapshot(client, adapter.ENVIRONMENT_URL, adapter.HELP_FLOW_ID)
        self.assertEqual(retrieved["@odata.etag"], FakeRecord.etag)
        package = adapter.prepare(retrieved, guard, help_profile())
        self.assertFalse(package["publishable"])
        self.assertEqual(package["transformation"], "CONTROLLED_RUNAFTER_MUTATION")
        self.assertEqual(package["status"], "DESIGNER_REVIEW_REQUIRED_NOT_LIVE_SAFE")
        self.assertEqual(len(package["structuralDiff"]), 7)
        self.assertTrue(adapter.verify_package(package, retrieved)["guardMatches"])
        package["structuralDiff"] = []
        with self.assertRaisesRegex(adapter.AdapterError, "UNREVIEWED_HELP_STRUCTURAL_CHANGE"):
            adapter.verify_package(package, retrieved)
        retrieved["ismanaged"] = True
        with self.assertRaisesRegex(adapter.AdapterError, "HELP_MUST_BE_CONFIRMED_UNMANAGED"):
            adapter.prepare(retrieved, guard, help_profile())

    def test_review_delta_never_contains_original_source_inputs(self):
        original = help_source()
        original["actions"]["Classify_Email"]["inputs"]["parameters"]["privatePrompt"] = "DO_NOT_EXPORT_ORIGINAL_PROMPT"
        snapshot, guard = snapshot_and_guard(original)
        snapshot.update({"workflowid": adapter.HELP_FLOW_ID, "statecode": 1, "ismanaged": False})
        guard["workflowId"] = adapter.HELP_FLOW_ID
        package = adapter.prepare(snapshot, guard, help_profile())
        delta = adapter.help_review_delta(package)
        encoded = json.dumps(delta)
        self.assertNotIn("DO_NOT_EXPORT_ORIGINAL_PROMPT", encoded)
        self.assertNotIn("candidateClientdata", encoded)
        self.assertFalse(delta["originalInputsOrCustomerPayloadsIncluded"])
        self.assertEqual(len(delta["generatedActions"]), 15)
        self.assertEqual(len(delta["rewiredRunAfter"]), 7)
        self.assertIn("/cases/Card Servicing/actions/", delta["sourceOperations"][1]["path"])

    def test_generated_help_examples_are_current(self):
        folder = adapter.PROJECT / "flow-templates"
        self.assertEqual(adapter.load_json(folder / "help-workflow.profile.example.json"), help_profile())
        self.assertEqual(adapter.load_json(folder / "help-workflow.source.synthetic.json"), help_source())
        self.assertEqual(adapter.load_json(folder / "help-workflow.candidate.synthetic.json"),
                         adapter.transform(help_source(), help_profile()))

    def test_each_actual_switch_choice_records_route_before_its_business_path(self):
        candidate = adapter.transform(help_source(), help_profile())
        all_route_writes = {adapter.route_scope_name(case) + "_Write" for case in adapter.HELP_BRANCH_CODES}
        maps = dict(adapter.help_action_maps(candidate))
        for case, branch_code in adapter.HELP_BRANCH_CODES.items():
            observed, _ = simulate_help(candidate, "Unmatched" if case == "default" else case)
            route_write = adapter.route_scope_name(case) + "_Write"
            self.assertEqual(set(observed) & all_route_writes, {route_write})
            host = "Card_Servicing_Agent" if case == adapter.HELP_CARD_CASE else "SPAM_Response" if case == "default" else "Mock_Response_Agent"
            self.assertLess(observed.index(route_write), observed.index(host))
            parent = f"actions/{adapter.HELP_SWITCH}/default/actions" if case == "default" else f"actions/{adapter.HELP_SWITCH}/cases/{case}/actions"
            route = maps[parent][adapter.route_scope_name(case)]
            payload = route["actions"][adapter.route_scope_name(case) + "_Payload"]["inputs"]
            self.assertEqual(payload["eventType"], "completed")
            self.assertEqual(payload["stageCode"], "route")
            self.assertEqual(payload["branch"], branch_code)
            identity = route["actions"][adapter.route_scope_name(case) + "_Identity"]["inputs"]
            self.assertEqual(identity["spanId"], "@guid()")
            self.assertNotIn("guid()", json.dumps(route["actions"][route_write]))
        mock = candidate["actions"]["EP_Mock_Response_Agent_Start"]["actions"]["EP_Mock_Response_Agent_Start_Payload"]["inputs"]
        self.assertEqual(mock["branch"], adapter.mock_branch_expression())
        for case in adapter.HELP_EMPTY_CASES:
            self.assertIn(adapter.HELP_BRANCH_CODES[case], mock["branch"])

    def test_help_stage_and_branch_codes_match_versioned_seed(self):
        seed = adapter.load_json(adapter.PROJECT / "config" / "process-tracking-schema.json")["seed"]
        binding = adapter.validate_help_seed(seed)
        self.assertEqual(binding["definitionVersion"], seed["version"])
        self.assertEqual(binding["seedSha256"], adapter.digest(seed))
        changed = copy.deepcopy(seed)
        changed["transitions"] = [edge for edge in changed["transitions"] if edge["from"] != "classify"]
        with self.assertRaisesRegex(adapter.AdapterError, "HELP_SEED_CLASSIFY_ROUTE_EDGE_MISSING"):
            adapter.validate_help_seed(changed)
        changed = copy.deepcopy(seed)
        next(edge for edge in changed["transitions"] if edge["from"] == "route")["branch"] = "WRONG_BRANCH"
        with self.assertRaisesRegex(adapter.AdapterError, "HELP_SEED_SELECTED_ROUTE_EDGE_MISSING"):
            adapter.validate_help_seed(changed)

    def test_casefree_host_policy_is_flagged_not_silently_certified(self):
        seed = adapter.load_json(adapter.PROJECT / "config" / "process-tracking-schema.json")["seed"]
        changed = copy.deepcopy(seed)
        changed["allow_case_free_completion"] = True
        next(stage for stage in changed["stages"] if stage["code"] == "spam")["allow_case_free_completion"] = True
        self.assertIn("spam", adapter.validate_help_seed(changed)["caseFreeHostCompletionRequiresReview"])

    def test_separate_identification_protocol_requires_explicit_tool_capability(self):
        example = adapter.load_json(adapter.PROJECT / "server" / "customer-resolution-example.json")
        stage = example["definitionStageRequirements"]
        producer = example["producerPolicyExampleFailsClosedUntilIdentitiesConfigured"]
        self.assertEqual(stage["phase"], "identify")
        self.assertEqual(stage["completionAuthority"], "tool")
        self.assertEqual(producer["authority"], "tool")
        self.assertTrue(producer["canResolveCustomer"])
        self.assertIn(stage["code"], producer["customerResolutionStageCodes"])
        self.assertNotIn("contactId", example["startedRequestJsonExample"])
        self.assertIn("contactId", example["completedRequestJsonExample"])
        self.assertEqual(example["startedRequestJsonExample"]["stageExecutionId"],
                         example["completedRequestJsonExample"]["stageExecutionId"])
        self.assertFalse(producer["userIds"])
        self.assertFalse(producer["roleIds"])

    def test_current_source_review_delta_matches_final_seed_and_profile(self):
        delta = adapter.load_json(adapter.PROJECT / "flow-templates" / "help-flow.current-source.review-delta.json")
        seed = adapter.load_json(adapter.PROJECT / "config" / "process-tracking-schema.json")["seed"]
        self.assertEqual(delta["mode"], "CONTROLLED_HELP_REVIEW_DELTA_ONLY")
        self.assertFalse(delta["publishable"])
        self.assertEqual(delta["profile"], help_profile())
        self.assertEqual(delta["definitionSeed"], adapter.validate_help_seed(seed))
        self.assertEqual(len(delta["generatedActions"]), 15)
        self.assertEqual(len(delta["rewiredRunAfter"]), 7)
        self.assertEqual(
            {entry["definition"]["actions"][entry["action"] + "_Payload"]["inputs"]["branch"]
             for entry in delta["generatedActions"] if entry["action"].startswith("EP_Route_")},
            set(adapter.HELP_BRANCH_CODES.values()),
        )


class SavedAgentDiscoveryTests(unittest.TestCase):
    def component(self, kind):
        data = (
            {"kind": "InlineAgentSkill",
             "content": "PRIVATE_PROMPT_SECRET read_query contact contactid emailaddress1 create_record incident customerid",
             "authoringSource": "synthetic"}
            if kind == "InlineAgentSkill" else {
                "kind": "McpTool", "connectorId": "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
                "operationId": "InvokeMCP", "connectionReference": "PRIVATE_PHYSICAL_CONNECTION",
                "allowedTools": ["read_query", "create_record", "update_record"],
                "authMode": "Invoker", "toolPermissionMode": {"kind": "AlwaysApprove"},
            }
        )
        return {
            "botcomponentid": FLOW_ID if kind == "InlineAgentSkill" else DEFINITION_ID,
            "name": "Synthetic component", "componenttype": 9, "ismanaged": False,
            "@odata.etag": 'W/"123"', "data": json.dumps(data),
        }

    def test_component_summary_never_exports_prompt_or_physical_connection(self):
        skill = adapter.summarize_agent_component(self.component("InlineAgentSkill"))
        mcp = adapter.summarize_agent_component(self.component("McpTool"))
        encoded = json.dumps([skill, mcp])
        self.assertNotIn("PRIVATE_PROMPT_SECRET", encoded)
        self.assertNotIn("PRIVATE_PHYSICAL_CONNECTION", encoded)
        self.assertIn("contact", skill["machineSymbolsPresent"])
        self.assertIn("incident", skill["machineSymbolsPresent"])
        self.assertFalse(skill["deterministicActionsDefined"])
        self.assertFalse(mcp["connectionReferenceValueExported"])
        self.assertEqual(mcp["allowedTools"], ["read_query", "create_record", "update_record"])

    def test_unicode_yaml_is_parsed_in_memory_using_existing_dependency(self):
        parsed = adapter.parse_agent_component("kind: InlineAgentSkill\ncontent: 'synthetic \u2264 value'\n")
        self.assertEqual(parsed["kind"], "InlineAgentSkill")
        self.assertEqual(parsed["content"], "synthetic \u2264 value")

    def test_unknown_or_extended_component_cannot_be_silently_classified(self):
        record = self.component("McpTool")
        data = json.loads(record["data"])
        data["inputBindings"] = {"ProcessId": "potential-context"}
        record["data"] = json.dumps(data)
        with self.assertRaisesRegex(adapter.AdapterError, "MCP_TOOL_EXTENSIONS_REQUIRE_REVIEW"):
            adapter.summarize_agent_component(record)
        record["data"] = json.dumps({"kind": "UnknownTool"})
        with self.assertRaisesRegex(adapter.AdapterError, "UNSUPPORTED_SAVED_AGENT_COMPONENT_KIND"):
            adapter.summarize_agent_component(record)

    def test_real_shape_refuses_fictitious_deterministic_patch(self):
        inventory = {
            "mode": "READ_ONLY_SAVED_AGENT_STRUCTURAL_INVENTORY",
            "activeToolComponents": [
                adapter.summarize_agent_component(self.component("InlineAgentSkill")),
                adapter.summarize_agent_component(self.component("McpTool")),
            ],
        }
        with self.assertRaisesRegex(adapter.AdapterError, "UNSUPPORTED_INLINE_SKILL_MCP_DETERMINISTIC_INTERCEPTION"):
            adapter.prepare_saved_agent_tool_patch(inventory)

    def test_bounded_sdk_discovery_is_read_only_and_guarded(self):
        definition = help_source()
        definition["actions"][adapter.HELP_SWITCH]["cases"][adapter.HELP_CARD_CASE]["actions"]["Card_Servicing_Agent"]["inputs"]["parameters"]["body/agentId"] = "synthetic_saved_agent"
        snapshot, guard = snapshot_and_guard(definition)
        snapshot.update({"workflowid": adapter.HELP_FLOW_ID, "statecode": 1, "ismanaged": False})
        guard["workflowId"] = adapter.HELP_FLOW_ID
        client = Mock()
        rows = [
            {"botcomponentid": FLOW_ID, "componenttype": 9, "statecode": 0},
            {"botcomponentid": DEFINITION_ID, "componenttype": 9, "statecode": 0},
        ]
        client.records.list.side_effect = [[{"botid": FLOW_ID}], rows]
        client.records.retrieve.side_effect = [
            {
                "botid": FLOW_ID, "name": "Synthetic agent", "ismanaged": False,
                "configuration": json.dumps({"agentSettings": {"instructions": "PRIVATE_BOT_PROMPT"}}),
            },
            self.component("InlineAgentSkill"), self.component("McpTool"),
        ]
        result = adapter.inspect_saved_agent(client, snapshot, guard)
        self.assertEqual(result["componentCount"], 2)
        self.assertEqual(result["configuredTypedContextParameterNames"], [])
        self.assertFalse(result["automaticToolPatchSupported"])
        encoded = json.dumps(result, default=str)
        self.assertNotIn("PRIVATE_BOT_PROMPT", encoded)
        self.assertNotIn("PRIVATE_PROMPT_SECRET", encoded)
        self.assertNotIn("PRIVATE_PHYSICAL_CONNECTION", encoded)
        self.assertEqual(client.records.list.call_args_list[1].kwargs["top"], 101)
        self.assertTrue(all(call[0] in ("records.list", "records.retrieve") for call in client.mock_calls))
        bad_snapshot = copy.deepcopy(snapshot)
        bad_snapshot["clientdata"] += " "
        client.reset_mock()
        with self.assertRaisesRegex(adapter.AdapterError, "SOURCE_HASH_MISMATCH"):
            adapter.inspect_saved_agent(client, bad_snapshot, guard)
        self.assertFalse(client.mock_calls)

    def test_persisted_actual_inventory_and_orchestration_handoff_fail_closed(self):
        folder = adapter.PROJECT / "flow-templates"
        inventory = adapter.load_json(folder / "card-servicing-agent.structural-inventory.json")
        handoff = adapter.load_json(folder / "card-servicing-tool-wrapper.capability-request.json")
        self.assertEqual(inventory["componentCount"], 6)
        self.assertEqual(sorted(item["kind"] for item in inventory["activeToolComponents"]),
                         ["InlineAgentSkill", "InlineAgentSkill", "InlineAgentSkill", "McpTool"])
        self.assertEqual(inventory["configuredInvokeAgentParameterNames"], ["body/agentId", "body/prompt"])
        self.assertEqual(inventory["configuredTypedContextParameterNames"], [])
        self.assertFalse(inventory["instructionsPromptsOrCustomerPayloadsExported"])
        self.assertFalse(inventory["physicalConnectionIdentifiersExported"])
        self.assertFalse(handoff["publishable"])
        self.assertEqual(handoff["approvedStage3Decision"], "DETERMINISTIC_FLOW_ORCHESTRATION")
        self.assertFalse(handoff["currentBindingSupportsDeterministicPatch"])
        self.assertIn("flowOwns", handoff["orchestrationBoundary"])
        self.assertIn("agentOwnsOnly", handoff["orchestrationBoundary"])
        self.assertIn("server/customer-resolution-example.json", handoff["orchestrationBoundary"]["requiredFlowFragments"])
        self.assertIn("flow-templates/case-workflow.actions.example.json", handoff["orchestrationBoundary"]["requiredFlowFragments"])
        self.assertIsNone(handoff["requiredTypedContext"]["verifiedTypedContextInputForCurrentRuntime"])
        self.assertEqual(handoff["ownersRequired"][0]["ownerId"], inventory["agent"]["ownerId"])
        with self.assertRaisesRegex(adapter.AdapterError, inventory["verifiedPatchRefusal"]):
            adapter.prepare_saved_agent_tool_patch(inventory)

if __name__ == "__main__":
    unittest.main()
