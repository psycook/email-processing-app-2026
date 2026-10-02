"""Offline preparation of add-only or strictly reviewed Help workflow instrumentation.

There is deliberately no publish, activate, update, HTTP, or credential path.
"""

import argparse
import copy
import hashlib
import hmac
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID


PROJECT = Path(__file__).resolve().parents[1]
ENVIRONMENT_URL = "https://smc-diamond-service.crm.dynamics.com"
HELP_FLOW_ID = "f1875d78-ffe5-64c8-d7bf-76a7f7a6b63f"
PREFIX = "EP_"
VERSION = 1
ALL_STATUSES = ["Succeeded", "Failed", "Skipped", "TimedOut"]
SECURE = {"secureData": {"properties": ["inputs", "outputs"]}}
NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}\Z")
HELP_TRIGGER = "Email_Arrives_in_Help_Share_Mailbox"
HELP_SWITCH = "Classify_Email_Switch"
HELP_CARD_CASE = "Card Servicing"
HELP_EMPTY_CASES = ["Payment & direct debits", "Disputes & fraud", "Details & Documents", "Complaints"]
HELP_BRANCH_CODES = {
    HELP_CARD_CASE: "card-servicing",
    "Payment & direct debits": "payment-direct-debits",
    "Disputes & fraud": "disputes-fraud",
    "Details & Documents": "details-documents",
    "Complaints": "complaints",
    "default": "spam",
}
HELP_CARD_TERMINATE = "Classify_Email_Switch_Terminate_category_5912ba73_a6ba_4d3d_b6f5_26711927d2fa"
HELP_DEFAULT_TERMINATE = "Classify_Email_Switch_Terminate_default"
HELP_OBSERVATIONS = [
    {"action": "Classify_Email", "stageCode": "classify"},
    {"action": HELP_SWITCH, "stageCode": "route"},
    {"action": "Card_Servicing_Agent", "stageCode": "card-servicing"},
    {"action": "SPAM_Response", "stageCode": "spam"},
    {"action": "Mock_Response_Agent", "stageCode": "mock-response"},
]


class AdapterError(Exception):
    """A data-free diagnostic safe to print even for confidential definitions."""


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def source_digest(clientdata):
    return hashlib.sha256(clientdata.encode("utf-8")).hexdigest()


def guid(value):
    try:
        parsed = UUID(str(value))
        if parsed.int == 0:
            raise ValueError("Empty identifier")
        return str(parsed)
    except (ValueError, TypeError, AttributeError) as exc:
        raise AdapterError("INVALID_GUID") from exc


def environment(value):
    if not isinstance(value, str):
        raise AdapterError("INVALID_ENVIRONMENT")
    try:
        parsed = urlsplit(value)
        invalid = (
            parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.port or parsed.query or parsed.fragment
            or parsed.path not in ("", "/")
        )
    except ValueError as exc:
        raise AdapterError("INVALID_ENVIRONMENT") from exc
    if invalid:
        raise AdapterError("INVALID_ENVIRONMENT")
    return value.rstrip("/").lower()


def load_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (ValueError, OSError, UnicodeError) as exc:
        raise AdapterError("INVALID_JSON_FILE") from exc


def definition_location(clientdata):
    if not isinstance(clientdata, dict):
        raise AdapterError("UNSUPPORTED_CLIENTDATA_ENVELOPE")
    if isinstance(clientdata.get("properties"), dict):
        if isinstance(clientdata["properties"].get("definition"), dict):
            return clientdata["properties"], "definition"
    if isinstance(clientdata.get("definition"), dict):
        return clientdata, "definition"
    raise AdapterError("UNSUPPORTED_CLIENTDATA_ENVELOPE")


def operation_inventory(definition):
    """Structural identifiers only: never inputs, prompts, outputs or identities."""
    if not isinstance(definition, dict):
        raise AdapterError("INVALID_DEFINITION")
    result = []

    def visit(actions, path):
        if not isinstance(actions, dict):
            raise AdapterError("INVALID_ACTIONS")
        for name, action in sorted(actions.items()):
            if not isinstance(action, dict) or not isinstance(name, str):
                raise AdapterError("INVALID_ACTION")
            current = f"{path}/{name}"
            inputs = action.get("inputs", {})
            host = inputs.get("host", {}) if isinstance(inputs, dict) else {}
            result.append({
                "path": current,
                "type": action.get("type"),
                "operationId": host.get("operationId") if isinstance(host, dict) else None,
            })
            if "actions" in action:
                visit(action["actions"], current)
            cases = action.get("cases", {})
            if not isinstance(cases, dict):
                raise AdapterError("INVALID_BRANCHES")
            for branch, case in cases.items():
                if not isinstance(case, dict):
                    raise AdapterError("INVALID_BRANCH")
                visit(case.get("actions", {}), f"{current}/cases/{branch}")
            for branch in ("default", "else"):
                if branch in action:
                    if not isinstance(action[branch], dict):
                        raise AdapterError("INVALID_BRANCH")
                    visit(action[branch].get("actions", {}), f"{current}/{branch}")

    visit(definition.get("triggers", {}), "triggers")
    visit(definition.get("actions", {}), "actions")
    return result


def guard_snapshot(snapshot, guard):
    """Require independently reviewed environment, workflow, ETag and exact source."""
    if not isinstance(snapshot, dict) or not isinstance(guard, dict):
        raise AdapterError("INVALID_SNAPSHOT_OR_GUARD")
    if environment(guard.get("environmentUrl")) != ENVIRONMENT_URL:
        raise AdapterError("UNAPPROVED_ENVIRONMENT")
    if environment(snapshot.get("environmentUrl")) != environment(guard["environmentUrl"]):
        raise AdapterError("ENVIRONMENT_MISMATCH")
    if guid(snapshot.get("workflowid")) != guid(guard.get("workflowId")):
        raise AdapterError("FLOW_ID_MISMATCH")
    etag = snapshot.get("@odata.etag")
    if not isinstance(etag, str) or not re.fullmatch(r'W/"[0-9]+"', etag):
        raise AdapterError("MISSING_OR_INVALID_ETAG")
    if etag != guard.get("etag"):
        raise AdapterError("ETAG_MISMATCH")
    text = snapshot.get("clientdata")
    if not isinstance(text, str):
        raise AdapterError("CLIENTDATA_MUST_BE_EXACT_STRING")
    expected = guard.get("sourceSha256", "")
    if not isinstance(expected, str) or not re.fullmatch("[0-9a-f]{64}", expected):
        raise AdapterError("MISSING_REVIEWED_SOURCE_HASH")
    if not hmac.compare_digest(source_digest(text), expected):
        raise AdapterError("SOURCE_HASH_MISMATCH")
    if guid(guard["workflowId"]) == HELP_FLOW_ID and snapshot.get("statecode") != 1:
        raise AdapterError("HELP_SOURCE_NOT_ACTIVE")
    try:
        decoded = json.loads(text)
        parent, key = definition_location(decoded)
        definition = parent[key]
        actual = operation_inventory(definition)
    except (ValueError, TypeError, AttributeError) as exc:
        raise AdapterError("INVALID_CLIENTDATA") from exc
    known = guard.get("knownOperations")
    if not isinstance(known, list) or not known:
        raise AdapterError("MISSING_REVIEWED_OPERATION_INVENTORY")
    if canonical(actual) != canonical(known):
        raise AdapterError("KNOWN_OPERATIONS_MISMATCH")
    return decoded, definition


def retrieve_snapshot(client, environment_url, workflow_id):
    """Read-only SDK seam; caller must first load dv-query and initialized auth.py."""
    if environment(environment_url) != ENVIRONMENT_URL:
        raise AdapterError("UNAPPROVED_ENVIRONMENT")
    row = client.records.retrieve(
        "workflow", guid(workflow_id),
        select=["workflowid", "clientdata", "statecode", "versionnumber", "ismanaged"],
    )
    if row is None:
        raise AdapterError("WORKFLOW_NOT_FOUND")
    result = dict(row)
    if getattr(row, "etag", None):
        result["@odata.etag"] = row.etag
    result["environmentUrl"] = environment(environment_url)
    # A versionnumber is not silently substituted for a missing service ETag.
    return result


def parse_agent_component(raw):
    """Parse in memory; an existing project dependency handles YAML, never logs its input."""
    if not isinstance(raw, str) or len(raw) > 1_000_000:
        raise AdapterError("AGENT_COMPONENT_DATA_INVALID_OR_TOO_LARGE")
    try:
        value = json.loads(raw)
    except ValueError:
        parser = (
            "let s='';process.stdin.setEncoding('utf8');"
            "process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{try{"
            "process.stdout.write(JSON.stringify(require('js-yaml').load(s)))}"
            "catch{process.exit(2)}})"
        )
        try:
            result = subprocess.run(
                ["node", "-e", parser], input=raw.encode("utf-8"),
                capture_output=True, check=True, timeout=20, cwd=PROJECT,
            )
            value = json.loads(result.stdout.decode("utf-8"))
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            raise AdapterError("AGENT_COMPONENT_PARSER_UNAVAILABLE_OR_INVALID") from exc
    if not isinstance(value, dict):
        raise AdapterError("AGENT_COMPONENT_MAPPING_REQUIRED")
    return value


def summarize_agent_component(record):
    raw = record.get("data")
    parsed = parse_agent_component(raw)
    kind = parsed.get("kind")
    if kind not in ("InlineAgentSkill", "McpTool"):
        raise AdapterError("UNSUPPORTED_SAVED_AGENT_COMPONENT_KIND")
    result = {
        "componentId": guid(record["botcomponentid"]),
        "name": record.get("name"),
        "componentType": record.get("componenttype"),
        "ismanaged": record.get("ismanaged"),
        "etag": getattr(record, "etag", None) or record.get("@odata.etag"),
        "dataSha256": source_digest(raw),
        "kind": kind,
        "fieldNames": sorted(parsed),
    }
    if kind == "InlineAgentSkill":
        if not set(parsed) <= {"kind", "content", "authoringSource"}:
            raise AdapterError("INLINE_SKILL_EXTENSIONS_REQUIRE_REVIEW")
        content = parsed.get("content")
        if not isinstance(content, str):
            raise AdapterError("UNSUPPORTED_INLINE_SKILL_CONTENT")
        terms = [
            "contact", "contactid", "incident", "incidentid", "customerid",
            "rfd_financialaccount", "emailaddress1", "read_query",
            "create_record", "update_record", "invoke_api",
        ]
        result["machineSymbolsPresent"] = [
            word for word in terms
            if re.search(r"(?<![A-Za-z0-9_])" + re.escape(word) + r"(?![A-Za-z0-9_])", content, re.I)
        ]
        result["traceContextSymbolsPresent"] = bool(
            re.search(r"\b(?:trace_?id|process_?id)\b", content, re.I)
        )
        result["deterministicActionsDefined"] = False
        result["evidenceMeaning"] = "Instruction references only; not proof a tool executed."
    else:
        if not set(parsed) <= {
            "kind", "toolPermissionMode", "authMode", "connectionReference",
            "connectorId", "operationId", "allowedTools",
        }:
            raise AdapterError("MCP_TOOL_EXTENSIONS_REQUIRE_REVIEW")
        tools = parsed.get("allowedTools")
        if (
            parsed.get("operationId") != "InvokeMCP"
            or parsed.get("connectorId") != "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps"
            or not isinstance(tools, list)
            or any(not isinstance(tool, str) or not re.fullmatch("[A-Za-z][A-Za-z0-9_]{0,79}", tool) for tool in tools)
        ):
            raise AdapterError("UNSUPPORTED_MCP_CONNECTOR_SHAPE")
        result.update({
            "connectorApi": "shared_commondataserviceforapps",
            "operationId": "InvokeMCP",
            "authMode": parsed.get("authMode"),
            "toolPermissionMode": parsed.get("toolPermissionMode", {}).get("kind"),
            "allowedTools": tools,
            "connectionReferencePresent": bool(parsed.get("connectionReference")),
            "connectionReferenceValueExported": False,
        })
    return result


def inspect_saved_agent(client, snapshot, guard):
    """Bounded read-only SDK discovery; returned facts contain no skill/configuration content."""
    _, definition = guard_snapshot(snapshot, guard)
    if guid(guard["workflowId"]) != HELP_FLOW_ID:
        raise AdapterError("SAVED_AGENT_DISCOVERY_REQUIRES_HELP_GUARD")
    try:
        action = definition["actions"][HELP_SWITCH]["cases"][HELP_CARD_CASE]["actions"]["Card_Servicing_Agent"]
        parameters = action["inputs"]["parameters"]
        schema_name = parameters["body/agentId"]
        if action["inputs"]["host"]["operationId"] != "InvokeAgent":
            raise AdapterError("HELP_AGENT_OPERATION_CHANGED")
    except (KeyError, TypeError) as exc:
        raise AdapterError("HELP_AGENT_REFERENCE_MISSING") from exc
    if not isinstance(schema_name, str) or not re.fullmatch("[A-Za-z][A-Za-z0-9_]{0,199}", schema_name):
        raise AdapterError("UNSUPPORTED_AGENT_REFERENCE")
    matches = list(client.records.list(
        "bot", filter=f"schemaname eq '{schema_name}'",
        select=["botid"], top=2,
    ))
    if len(matches) != 1:
        raise AdapterError("SAVED_AGENT_NOT_UNIQUELY_LOCATED")
    bot_id = guid(matches[0]["botid"])
    bot = client.records.retrieve(
        "bot", bot_id,
        select=["botid", "name", "schemaname", "ismanaged", "statecode", "configuration",
                "runtimeprovider", "publishedon", "_ownerid_value"],
    )
    if bot is None:
        raise AdapterError("SAVED_AGENT_DISAPPEARED")
    try:
        configuration = json.loads(bot.get("configuration") or "{}")
    except ValueError as exc:
        raise AdapterError("UNSUPPORTED_AGENT_CONFIGURATION") from exc
    if not isinstance(configuration, dict):
        raise AdapterError("UNSUPPORTED_AGENT_CONFIGURATION")
    rows = list(client.records.list(
        "botcomponent", filter=f"_parentbotid_value eq {bot_id}",
        select=["botcomponentid", "name", "schemaname", "componenttype", "ismanaged", "statecode"],
        top=101,
    ))
    if len(rows) > 100:
        raise AdapterError("SAVED_AGENT_COMPONENT_INVENTORY_LIMIT")
    components = []
    for row in rows:
        if row.get("componenttype") == 9 and row.get("statecode") == 0:
            full = client.records.retrieve(
                "botcomponent", guid(row["botcomponentid"]),
                select=["botcomponentid", "name", "componenttype", "ismanaged", "data"],
            )
            if full is None:
                raise AdapterError("SAVED_AGENT_COMPONENT_DISAPPEARED")
            components.append(summarize_agent_component(full))
    configured_context = sorted(
        key for key in parameters
        if key.lower() in ("body/traceid", "body/processid", "body/context", "body/metadata", "body/variables")
    )
    definition_fields = []
    for name in ("Classify_Email", "Mock_Response_Agent"):
        for parameter, value in definition["actions"][name]["inputs"]["parameters"].items():
            if "definition" not in parameter.lower():
                continue
            parsed = value
            if isinstance(value, str):
                try:
                    parsed = json.loads(value)
                except ValueError:
                    parsed = None
            definition_fields.append({
                "action": name, "parameter": parameter,
                "sourceType": type(value).__name__,
                "definitionFieldNames": sorted(parsed) if isinstance(parsed, dict) else [],
            })
    return {
        "mode": "READ_ONLY_SAVED_AGENT_STRUCTURAL_INVENTORY",
        "publishable": False,
        "evidenceScope": "Saved configuration only; not runtime tool execution or proof of published runtime equivalence.",
        "snapshotConsistency": "Independent read-only records with individual ETags; recheck all guards before any authorized future change.",
        "workflowGuard": copy.deepcopy(guard),
        "agent": {
            "botId": bot_id, "schemaName": schema_name, "name": bot.get("name"),
            "ismanaged": bot.get("ismanaged"), "statecode": bot.get("statecode"),
            "etag": getattr(bot, "etag", None) or bot.get("@odata.etag"),
            "ownerId": bot.get("_ownerid_value"),
            "publishedOn": bot.get("publishedon"), "runtimeProvider": bot.get("runtimeprovider"),
            "configurationFieldNames": sorted(configuration),
            "configurationSha256": source_digest(bot.get("configuration") or ""),
        },
        "configuredInvokeAgentParameterNames": sorted(parameters),
        "configuredTypedContextParameterNames": configured_context,
        "inlineBotDefinitionFields": definition_fields,
        "componentCount": len(rows),
        "activeToolComponents": components,
        "nonToolComponentTypes": sorted({
            row["componenttype"] for row in rows if row.get("componenttype") != 9
        }),
        "automaticToolPatchSupported": False,
        "blocker": "UNSUPPORTED_INLINE_SKILL_MCP_DETERMINISTIC_INTERCEPTION",
        "requiredCapabilities": [
            "Supported typed per-invocation ProcessId/native-run context for this InvokeAgent runtime",
            "Supported per-tool deterministic middleware or replacement explicit action wrapper",
            "Saved agent owner-approved authoring, tool binding and verified publication surface",
        ],
        "instructionsPromptsOrCustomerPayloadsExported": False,
        "physicalConnectionIdentifiersExported": False,
    }


def prepare_saved_agent_tool_patch(inventory):
    """Never convert model instructions or generic MCP access into a fictitious workflow patch."""
    if inventory.get("mode") != "READ_ONLY_SAVED_AGENT_STRUCTURAL_INVENTORY":
        raise AdapterError("SAVED_AGENT_REVIEW_INVENTORY_REQUIRED")
    kinds = {item.get("kind") for item in inventory.get("activeToolComponents", [])}
    if kinds == {"InlineAgentSkill", "McpTool"}:
        raise AdapterError("UNSUPPORTED_INLINE_SKILL_MCP_DETERMINISTIC_INTERCEPTION")
    raise AdapterError("UNSUPPORTED_SAVED_AGENT_TOOL_PATCH_SHAPE")


def validate_profile(profile):
    if not isinstance(profile, dict):
        raise AdapterError("UNSUPPORTED_PROFILE")
    expected = {
        "schemaVersion", "workflowId", "definitionId", "producerId",
        "connectionReference", "observations",
    }
    if profile.get("adapter") == "help-v1":
        expected.add("adapter")
    if set(profile) != expected or profile.get("schemaVersion") != VERSION:
        raise AdapterError("UNSUPPORTED_PROFILE")
    guid(profile["workflowId"])
    guid(profile["definitionId"])
    producer = profile.get("producerId")
    if not isinstance(producer, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", producer):
        raise AdapterError("INVALID_PRODUCER_ID")
    connection = profile.get("connectionReference")
    if not isinstance(connection, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{1,99}", connection):
        raise AdapterError("INVALID_CONNECTION_REFERENCE")
    observations = profile["observations"]
    if not isinstance(observations, list) or not observations:
        raise AdapterError("OBSERVATIONS_REQUIRED")
    for observation in observations:
        if not isinstance(observation, dict) or set(observation) != {"action", "stageCode"}:
            raise AdapterError("UNSUPPORTED_OBSERVATION_FIELDS")
        if not isinstance(observation["action"], str):
            raise AdapterError("INVALID_OBSERVATION_ACTION")
        stage = observation["stageCode"]
        if not isinstance(stage, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,49}", stage):
            raise AdapterError("INVALID_STAGE_CODE")


def validate_shape(definition, profile):
    if not isinstance(definition, dict):
        raise AdapterError("INVALID_DEFINITION")
    if not isinstance(definition.get("triggers"), dict) or len(definition["triggers"]) != 1:
        raise AdapterError("UNSUPPORTED_TRIGGER_COUNT")
    trigger = next(iter(definition["triggers"].values()))
    if not isinstance(trigger, dict):
        raise AdapterError("INVALID_TRIGGER")
    if trigger.get("type") != "Request":
        raise AdapterError("UNSUPPORTED_TRIGGER_REQUIRES_VERIFIED_MAPPING")
    if trigger.get("kind") != "Http" or "splitOn" in trigger:
        raise AdapterError("UNSUPPORTED_TRIGGER_KIND")
    inputs = trigger.get("inputs", {})
    if not isinstance(inputs, dict) or not isinstance(inputs.get("schema"), dict):
        raise AdapterError("UNVERIFIED_INTAKE_FIELD_MAPPING")
    schema = inputs["schema"]
    properties = schema.get("properties", {})
    if not isinstance(properties, dict):
        raise AdapterError("UNVERIFIED_INTAKE_FIELD_MAPPING")
    for field in ("internetMessageId", "actualFrom", "replyTo"):
        if not isinstance(properties.get(field), dict) or properties[field].get("type") != "string":
            raise AdapterError("UNVERIFIED_INTAKE_FIELD_MAPPING")
    required = schema.get("required")
    if not isinstance(required, list) or not all(isinstance(item, str) for item in required):
        raise AdapterError("REQUIRED_INTAKE_FIELDS_MISSING")
    if not {"internetMessageId", "actualFrom"} <= set(required):
        raise AdapterError("REQUIRED_INTAKE_FIELDS_MISSING")
    actions = definition.get("actions")
    if not isinstance(actions, dict) or not actions:
        raise AdapterError("UNSUPPORTED_EMPTY_ACTIONS")
    for name, action in actions.items():
        if not isinstance(name, str) or not NAME.fullmatch(name) or name.startswith(PREFIX):
            raise AdapterError("RESERVED_OR_UNSUPPORTED_ACTION_NAME")
        if not isinstance(action, dict):
            raise AdapterError("INVALID_ACTION")
        if action.get("type") not in ("Compose", "OpenApiConnection"):
            raise AdapterError("UNSUPPORTED_CONTROL_OR_MANAGED_ACTION")
        if any(key in action for key in ("actions", "cases", "default", "else", "foreach")):
            raise AdapterError("UNSUPPORTED_NESTED_ACTION")
        after = action.get("runAfter")
        if not isinstance(after, dict):
            raise AdapterError("EXPLICIT_RUNAFTER_REQUIRED")
        for predecessor, statuses in after.items():
            if predecessor not in actions:
                raise AdapterError("UNKNOWN_RUNAFTER_ACTION")
            if statuses != ["Succeeded"]:
                raise AdapterError("UNSUPPORTED_FAILURE_OR_SKIP_RUNAFTER")
        if PREFIX in canonical(action):
            raise AdapterError("RESERVED_REFERENCE_IN_BUSINESS_ACTION")
    pending = set(actions)
    resolved = set()
    while pending:
        ready = {name for name in pending if set(actions[name]["runAfter"]) <= resolved}
        if not ready:
            raise AdapterError("CYCLIC_RUNAFTER")
        resolved.update(ready)
        pending.difference_update(ready)
    observations = profile.get("observations")
    if not isinstance(observations, list) or not observations:
        raise AdapterError("OBSERVATIONS_REQUIRED")
    seen = set()
    for observation in observations:
        action = observation.get("action")
        if action not in actions or action in seen:
            raise AdapterError("INVALID_OBSERVATION_ACTION")
        seen.add(action)
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,49}", observation.get("stageCode", "")):
            raise AdapterError("INVALID_STAGE_CODE")
        if actions[action]["type"] != "OpenApiConnection":
            raise AdapterError("ONLY_CONNECTOR_COMPLETION_IS_OBSERVABLE")


def compose(inputs, after=None, secure=True):
    value = {"type": "Compose", "inputs": inputs, "runAfter": after or {}}
    if secure:
        value["runtimeConfiguration"] = copy.deepcopy(SECURE)
    return value


def success(action):
    return {action: ["Succeeded"]}


def make_write(name, api, connection):
    return {
        "type": "OpenApiConnection",
        "inputs": {
            "host": {
                "apiId": "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
                "connectionName": connection,
                "operationId": "PerformUnboundAction",
            },
            "parameters": {
                "actionName": api,
                "item/RequestJson": f"@string(outputs('{name}_Payload'))",
            },
            "retryPolicy": {"type": "fixed", "count": 2, "interval": "PT5S"},
        },
        "runAfter": success(f"{name}_Payload"),
        "runtimeConfiguration": copy.deepcopy(SECURE),
    }


def observation_scope(name, payload, after, connection, api, marker=None):
    """Catch ONLY inside telemetry; an external Skipped catcher masks business failures."""
    value = {
        "type": "Scope",
        "actions": {
            f"{name}_Identity": compose({
                "eventId": "@guid()", "spanId": "@guid()", "occurredAtUtc": "@utcNow()",
            }),
            f"{name}_Payload": compose(payload, success(f"{name}_Identity")),
            f"{name}_Write": make_write(name, api, connection),
            f"{name}_Settled": compose(
                {"observationOnly": True},
                {f"{name}_Write": list(ALL_STATUSES)},
                secure=False,
            ),
        },
        "runAfter": after,
    }
    if marker:
        value["metadata"] = {"rfdEmailProcessAdapter": marker}
    return value


def operation_id(workflow_id, path):
    # Full SHA-256 (not a shortened GUID) fits the API's 80-character operation code.
    return digest(["workflow-operation-v1", guid(workflow_id), path])


def event_payload(name, profile, operation, event_type, stage_code=None):
    payload = {
        "schemaVersion": VERSION,
        "eventId": f"@outputs('{name}_Identity')?['eventId']",
        "producerId": profile["producerId"],
        "workflowId": guid(profile["workflowId"]),
        "sourceExecutionId": "@workflow()?['run']?['name']",
        "operation": operation_id(profile["workflowId"], operation),
        "branch": "root",
        "attempt": 1,
        "eventType": event_type,
        "occurredAtUtc": f"@outputs('{name}_Identity')?['occurredAtUtc']",
    }
    if stage_code:
        payload["stageCode"] = stage_code
        # The service names the full-GUID span StageExecutionId.
        payload["stageExecutionId"] = f"@outputs('{name}_Identity')?['spanId']"
    return payload


def transform(definition, profile):
    """Prepare a success-observation sidecar without editing original business nodes.

    Help uses a separate observed-shape validator and controlled dependency edits.
    """
    validate_profile(profile)
    if profile.get("adapter") == "help-v1":
        return transform_help(definition, profile)[0]
    if not isinstance(definition, dict) or not isinstance(definition.get("actions"), dict):
        raise AdapterError("INVALID_DEFINITION")
    if not all(isinstance(name, str) for name in definition["actions"]):
        raise AdapterError("INVALID_ACTION")
    original = copy.deepcopy(definition)
    owned = {
        name: action for name, action in original.get("actions", {}).items()
        if name.startswith(PREFIX)
    }
    original["actions"] = {
        name: action for name, action in original.get("actions", {}).items()
        if name not in owned
    }
    validate_shape(original, profile)
    marker = {
        "version": VERSION, "sourceDefinitionSha256": digest(original),
        "profileSha256": digest(profile),
    }
    name = "EP_Intake"
    payload = event_payload(name, profile, "trigger/received", "received")
    payload.update({
        "definitionId": guid(profile["definitionId"]),
        "internetMessageId": "@triggerBody()?['internetMessageId']",
        "actualFrom": "@triggerBody()?['actualFrom']",
        "replyTo": "@triggerBody()?['replyTo']",
    })
    connection = profile["connectionReference"]
    additions = {
        name: observation_scope(
            name, payload, {}, connection, "rfd_RecordEmailProcessEvent", marker,
        ),
    }
    for observation in profile["observations"]:
        action = observation["action"]
        name = f"EP_{action}"
        if name in additions:
            raise AdapterError("GENERATED_ACTION_NAME_COLLISION")
        payload = event_payload(
            name, profile, f"actions/{action}", "completed", observation["stageCode"],
        )
        payload.update({
            "processId": "@json(body('EP_Intake_Write')?['ResponseJson'])?['processId']",
            "occurredAtUtc": f"@actions('{action}')?['endTime']",
        })
        additions[name] = observation_scope(
            name, payload, {action: ["Succeeded"], "EP_Intake": ["Succeeded"]},
            connection, "rfd_RecordEmailProcessEvent", marker,
        )
    generated_names = [
        item
        for name, scope in additions.items()
        for item in [name, *scope["actions"]]
    ]
    if len(set(generated_names)) != len(generated_names):
        raise AdapterError("GENERATED_ACTION_NAME_COLLISION")
    if owned and owned != additions:
        raise AdapterError("INSTRUMENTATION_COLLISION_OR_TAMPERING")
    candidate = copy.deepcopy(original)
    candidate["actions"].update(additions)
    return candidate


def help_action_maps(definition):
    actions = definition["actions"]
    switch = actions[HELP_SWITCH]
    return [
        ("actions", actions),
        *[
            (f"actions/{HELP_SWITCH}/cases/{case}/actions", switch["cases"][case]["actions"])
            for case in [HELP_CARD_CASE, *HELP_EMPTY_CASES]
        ],
        (f"actions/{HELP_SWITCH}/default/actions", switch["default"]["actions"]),
    ]


def mock_branch_expression():
    classifier = "outputs('Classify_Email')?['body']?['structuredOutput']?['predictedCategory']"
    expression = "'unsupported'"
    for case in reversed(HELP_EMPTY_CASES):
        expression = f"if(equals({classifier},'{case}'),'{HELP_BRANCH_CODES[case]}',{expression})"
    return "@" + expression


def route_scope_name(branch):
    return "EP_Route_" + HELP_BRANCH_CODES[branch].replace("-", "_")


def validate_help_shape(definition, profile):
    """Validate the observed user workflow; agent operations do not imply managed ownership."""
    validate_profile(profile)
    if guid(profile["workflowId"]) != HELP_FLOW_ID or profile["observations"] != HELP_OBSERVATIONS:
        raise AdapterError("UNSUPPORTED_HELP_PROFILE")
    try:
        if set(definition["triggers"]) != {HELP_TRIGGER}:
            raise AdapterError("UNSUPPORTED_HELP_TRIGGER")
        trigger = definition["triggers"][HELP_TRIGGER]
        host = trigger["inputs"]["host"]
        if (trigger["type"] != "OpenApiConnection"
                or host["operationId"] != "SharedMailboxOnNewEmailV2"
                or host["apiId"] != "/providers/Microsoft.PowerApps/apis/shared_office365"
                or trigger["splitOn"] != "@triggerOutputs()?['body/value']"):
            raise AdapterError("UNSUPPORTED_HELP_TRIGGER")
        actions = definition["actions"]
        if set(actions) != {"Classify_Email", HELP_SWITCH, "Mock_Response_Agent"}:
            raise AdapterError("UNSUPPORTED_HELP_ROOT_ACTIONS")
        switch = actions[HELP_SWITCH]
        if (switch["type"] != "Switch"
                or switch["expression"] != "@outputs('Classify_Email')?['body']?['structuredOutput']?['predictedCategory']"
                or switch["runAfter"] != {"Classify_Email": ["Succeeded"]}
                or set(switch["cases"]) != {HELP_CARD_CASE, *HELP_EMPTY_CASES}):
            raise AdapterError("UNSUPPORTED_HELP_SWITCH")
        for name, branch in switch["cases"].items():
            if branch["case"] != name:
                raise AdapterError("UNSUPPORTED_HELP_CASE_MATCH")
            if name != HELP_CARD_CASE and branch["actions"] != {}:
                raise AdapterError("UNSUPPORTED_HELP_NONEMPTY_CASE")
        card = switch["cases"][HELP_CARD_CASE]["actions"]
        default = switch["default"]["actions"]
        if set(card) != {"Card_Servicing_Agent", HELP_CARD_TERMINATE} or set(default) != {"SPAM_Response", HELP_DEFAULT_TERMINATE}:
            raise AdapterError("UNSUPPORTED_HELP_BRANCH_ACTIONS")
        for name, scope, operation, after in (
            ("Classify_Email", actions, "InvokeDefinition", {}),
            ("Card_Servicing_Agent", card, "InvokeAgent", {}),
            ("SPAM_Response", default, "InvokeDefinition", {}),
            ("Mock_Response_Agent", actions, "InvokeDefinition", {HELP_SWITCH: ["Succeeded"]}),
        ):
            action = scope[name]
            if (action["type"] != "OpenApiConnection"
                    or action["inputs"]["host"]["operationId"] != operation
                    or action.get("runAfter", {}) != after
                    or any(key in action for key in ("actions", "cases", "else", "default"))):
                raise AdapterError("UNSUPPORTED_HELP_ACTION_OR_DEPENDENCY")
        for scope, terminal, predecessor in (
            (card, HELP_CARD_TERMINATE, "Card_Servicing_Agent"),
            (default, HELP_DEFAULT_TERMINATE, "SPAM_Response"),
        ):
            action = scope[terminal]
            if (action["type"] != "Terminate" or action["inputs"]["runStatus"] != "Failed"
                    or action["runAfter"] != {predecessor: ["Succeeded"]}):
                raise AdapterError("UNSUPPORTED_HELP_TERMINATION")
    except (KeyError, TypeError, AttributeError) as exc:
        raise AdapterError("MALFORMED_HELP_SHAPE") from exc


def transform_help(definition, profile):
    """Controlled runAfter-only mutation; returns an explicitly reviewed structural diff."""
    original = copy.deepcopy(definition)
    if not isinstance(original, dict) or not isinstance(original.get("actions"), dict):
        raise AdapterError("MALFORMED_HELP_SHAPE")
    # Reconstruct only from our complete, reproducible marker; never trust a prefix alone.
    try:
        marker = original["actions"].get("EP_Intake", {}).get("metadata", {}).get("rfdHelpAdapter")
    except AttributeError as exc:
        raise AdapterError("HELP_MARKER_TAMPERING") from exc
    existing = None
    if marker:
        existing = copy.deepcopy(original)
        try:
            for path, scope in help_action_maps(original):
                for name in list(scope):
                    if name.startswith(PREFIX):
                        del scope[name]
            maps = dict(help_action_maps(original))
            for change in marker["rewired"]:
                scope = maps[change["parent"]]
                if change["beforePresent"]:
                    scope[change["action"]]["runAfter"] = change["before"]
                else:
                    scope[change["action"]].pop("runAfter", None)
        except (KeyError, TypeError, AttributeError) as exc:
            raise AdapterError("HELP_MARKER_TAMPERING") from exc
    validate_help_shape(original, profile)
    candidate = copy.deepcopy(original)
    maps = dict(help_action_maps(candidate))
    root = maps["actions"]
    connection = profile["connectionReference"]
    payload = event_payload("EP_Intake", profile, f"triggers/{HELP_TRIGGER}", "received")
    payload.update({
        "definitionId": guid(profile["definitionId"]),
        "internetMessageId": "@triggerOutputs()?['body/internetMessageId']",
        "actualFrom": "@triggerOutputs()?['body/from']",
        "replyTo": "@triggerOutputs()?['body/replyTo']",
    })
    root["EP_Intake"] = observation_scope(
        "EP_Intake", payload, {}, connection, "rfd_RecordEmailProcessEvent",
    )
    for branch, code in HELP_BRANCH_CODES.items():
        parent = (
            f"actions/{HELP_SWITCH}/default/actions" if branch == "default"
            else f"actions/{HELP_SWITCH}/cases/{branch}/actions"
        )
        name = route_scope_name(branch)
        payload = event_payload(name, profile, f"{parent}/route", "completed", "route")
        payload.update({
            "processId": "@json(body('EP_Intake_Write')?['ResponseJson'])?['processId']",
            "branch": code,
        })
        maps[parent][name] = observation_scope(
            name, payload, {}, connection, "rfd_RecordEmailProcessEvent",
        )
    rewired = []

    def rewire(parent, action, extra):
        node = maps[parent][action]
        before = copy.deepcopy(node.get("runAfter", {}))
        present = "runAfter" in node
        after = {**before, **extra}
        node["runAfter"] = after
        rewired.append({
            "parent": parent, "action": action, "beforePresent": present,
            "before": before, "after": copy.deepcopy(after),
        })

    contexts = [
        ("actions", "Classify_Email", "classify", "root", {"EP_Intake": ["Succeeded"]}),
        (f"actions/{HELP_SWITCH}/cases/{HELP_CARD_CASE}/actions",
         "Card_Servicing_Agent", "card-servicing", "card-servicing",
         success(route_scope_name(HELP_CARD_CASE))),
        (f"actions/{HELP_SWITCH}/default/actions",
         "SPAM_Response", "spam", "spam", success(route_scope_name("default"))),
        ("actions", "Mock_Response_Agent", "mock-response", mock_branch_expression(),
         {HELP_SWITCH: ["Succeeded"]}),
    ]
    for parent, action, stage, branch, before in contexts:
        scope = maps[parent]
        start, end = f"EP_{action}_Start", f"EP_{action}_Settled"
        for prefix, kind in ((start, "started"), (end, "completed")):
            payload = event_payload(prefix, profile, f"{parent}/{action}", kind, stage)
            payload.update({
                "processId": "@json(body('EP_Intake_Write')?['ResponseJson'])?['processId']",
                "branch": branch,
                "stageExecutionId": f"@outputs('{start}_Identity')?['spanId']",
            })
            if kind == "completed":
                payload["occurredAtUtc"] = f"@actions('{action}')?['endTime']"
            scope[prefix] = observation_scope(
                prefix, payload, before if kind == "started" else success(action),
                connection, "rfd_RecordEmailProcessEvent",
            )
            if kind == "completed":
                del scope[prefix]["actions"][f"{prefix}_Identity"]["inputs"]["spanId"]
        rewire(parent, action, success(start))
    rewire("actions", HELP_SWITCH, success("EP_Classify_Email_Settled"))
    rewire(f"actions/{HELP_SWITCH}/cases/{HELP_CARD_CASE}/actions",
           HELP_CARD_TERMINATE, success("EP_Card_Servicing_Agent_Settled"))
    rewire(f"actions/{HELP_SWITCH}/default/actions",
           HELP_DEFAULT_TERMINATE, success("EP_SPAM_Response_Settled"))
    root["EP_Intake"]["metadata"] = {"rfdHelpAdapter": {
        "version": VERSION, "originalDefinitionSha256": digest(original),
        "profileSha256": digest(profile), "rewired": rewired,
    }}
    if existing is not None and existing != candidate:
        raise AdapterError("HELP_INSTRUMENTATION_COLLISION_OR_TAMPERING")
    verify_help_business(original, candidate, rewired)
    return candidate, rewired


def verify_help_business(original, candidate, rewired):
    """Only explicitly listed runAfter edits and generated sibling actions may differ."""
    restored = copy.deepcopy(candidate)
    maps = dict(help_action_maps(restored))
    for scope in maps.values():
        for name in list(scope):
            if name.startswith(PREFIX):
                del scope[name]
    for change in rewired:
        node = maps[change["parent"]][change["action"]]
        if node.get("runAfter") != change["after"]:
            raise AdapterError("UNREVIEWED_HELP_STRUCTURAL_CHANGE")
        if change["beforePresent"]:
            node["runAfter"] = copy.deepcopy(change["before"])
        else:
            node.pop("runAfter", None)
    if restored != original:
        raise AdapterError("HELP_BUSINESS_INPUT_OR_NAME_CHANGED")


def validate_help_seed(seed):
    """Refuse a prepare package whose local versioned graph cannot accept its events."""
    try:
        stages = {item["code"]: item for item in seed["stages"]}
        for code in ("classify", "route", "card-servicing", "spam", "mock-response"):
            if stages[code]["completion_authority"] != "workflow":
                raise AdapterError("HELP_SEED_AUTHORITY_MISMATCH")
        if stages["route"]["kind"] != "gateway" or not stages["route"]["required"]:
            raise AdapterError("HELP_SEED_ROUTE_REQUIRED")
        edges = seed["transitions"]
        if not any(
            edge["from"] == "classify" and edge["to"] == "route"
            and edge["required"] and not edge.get("branch")
            for edge in edges
        ):
            raise AdapterError("HELP_SEED_CLASSIFY_ROUTE_EDGE_MISSING")
        for branch, code in HELP_BRANCH_CODES.items():
            target = "card-servicing" if branch == HELP_CARD_CASE else "spam" if branch == "default" else "mock-response"
            matches = [
                edge for edge in edges
                if edge["from"] == "route" and edge["to"] == target and edge.get("branch") == code
            ]
            if len(matches) != 1 or not matches[0]["required"]:
                raise AdapterError("HELP_SEED_SELECTED_ROUTE_EDGE_MISSING")
        actual = {edge.get("branch") for edge in edges if edge["from"] == "route"}
        if actual != set(HELP_BRANCH_CODES.values()):
            raise AdapterError("HELP_SEED_ROUTE_CHOICES_MISMATCH")
    except (KeyError, TypeError) as exc:
        raise AdapterError("HELP_SEED_STAGE_OR_GRAPH_MISSING") from exc
    return {
        "definitionCode": seed["definition_code"],
        "definitionVersion": seed["version"],
        "seedSha256": digest(seed),
        "caseFreeHostCompletionRequiresReview": [
            code for code in ("classify", "route", "card-servicing", "spam", "mock-response")
            if seed.get("allow_case_free_completion") and stages[code].get("allow_case_free_completion")
        ],
    }


def case_workflow_fragment(profile):
    """Designer review fragment for an EXPLICIT process/case, not a business workflow.

    Requires successful original Create_case, Case_progress and Close_case actions.
    No case-close command and no observer facts are generated.
    """
    validate_profile(profile)
    connection = profile["connectionReference"]
    result = {}
    name = "EP_Link_case"
    payload = event_payload(name, profile, "actions/Create_case/link", "case-linked")
    payload.update({
        "processId": "@triggerBody()?['processId']",
        "caseId": "@body('Create_case')?['incidentid']",
        "blocksCompletion": True,
        "relationshipRole": "service-request",
        "occurredAtUtc": "@actions('Create_case')?['endTime']",
    })
    result[name] = observation_scope(
        name, payload, success("Create_case"), connection, "rfd_LinkEmailProcessCase",
    )
    for action, stage in (
        ("Case_progress", "case-workflow-progress"),
        ("Close_case", "case-closure-attempt"),
    ):
        name = f"EP_{action}"
        payload = event_payload(name, profile, f"actions/{action}", "completed", stage)
        payload.update({
            "processId": "@triggerBody()?['processId']",
            "caseId": "@body('Create_case')?['incidentid']",
            "occurredAtUtc": f"@actions('{action}')?['endTime']",
        })
        result[name] = observation_scope(
            name, payload, {action: ["Succeeded"], "EP_Link_case": ["Succeeded"]},
            connection, "rfd_RecordEmailProcessEvent",
        )
    return {
        "mode": "DESIGNER_REVIEW_FRAGMENT_ONLY", "publishable": False,
        "requiredOriginalActions": ["Create_case", "Case_progress", "Close_case"],
        "processIdSource": "Explicit processId passed from original intake API receipt.",
        "caseIdSource": "Actual Create_case connector incidentid output; never customer email.",
        "closureMeaning": "Close_case connector returned successfully, NOT an observed case resolution.",
        "actionsToAdd": result,
    }


def private_directory(path):
    """Snapshots/packages are never written inside a checkout, even an ignored folder."""
    path = Path(path).resolve()
    if path == PROJECT or PROJECT in path.parents:
        raise AdapterError("PRIVATE_ARTIFACTS_MUST_BE_OUTSIDE_PROJECT")
    if not path.is_dir() or any((p / ".git").exists() for p in [path, *path.parents]):
        raise AdapterError("PRIVATE_DIRECTORY_MUST_EXIST_OUTSIDE_GIT")
    ignore = path / ".gitignore"
    if not ignore.is_file() or "*" not in ignore.read_text(encoding="utf-8").splitlines():
        raise AdapterError("PRIVATE_DIRECTORY_REQUIRES_IGNORE_ALL_SENTINEL")
    return path


def private_input(path):
    path = Path(path).resolve()
    private_directory(path.parent)
    if not path.is_file():
        raise AdapterError("PRIVATE_SOURCE_FILE_MISSING")
    return path


def exclusive_json(path, value):
    try:
        with path.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    except FileExistsError as exc:
        raise AdapterError("ARTIFACT_EXISTS_REFUSING_OVERWRITE") from exc


def prepare(snapshot, guard, profile):
    validate_profile(profile)
    decoded, definition = guard_snapshot(snapshot, guard)
    if guid(profile.get("workflowId")) != guid(guard["workflowId"]):
        raise AdapterError("PROFILE_FLOW_ID_MISMATCH")
    help_mode = profile.get("adapter") == "help-v1"
    if help_mode and snapshot.get("ismanaged") is not False:
        raise AdapterError("HELP_MUST_BE_CONFIRMED_UNMANAGED")
    seed_binding = (
        validate_help_seed(load_json(PROJECT / "config" / "process-tracking-schema.json")["seed"])
        if help_mode else None
    )
    if help_mode:
        candidate, structural_diff = transform_help(definition, profile)
        if candidate == definition:
            structural_diff = []
    else:
        candidate, structural_diff = transform(definition, profile), []
    original_actions = definition["actions"]
    if not help_mode:
        for name, action in original_actions.items():
            if candidate["actions"].get(name) != action:
                raise AdapterError("BUSINESS_ACTION_CHANGED")
    parent, key = definition_location(decoded)
    parent[key] = candidate
    if help_mode:
        business_count = sum(
            not name.startswith(PREFIX)
            for _, actions in help_action_maps(definition) for name in actions
        )
        added_count = (
            sum(len(actions) for _, actions in help_action_maps(candidate))
            - sum(len(actions) for _, actions in help_action_maps(definition))
        )
    else:
        business_count = len(original_actions)
        added_count = len(candidate["actions"]) - len(original_actions)
    return {
        "mode": "DRY_RUN_ONLY",
        "publishable": False,
        "status": "DESIGNER_REVIEW_REQUIRED_NOT_LIVE_SAFE",
        "transformation": "CONTROLLED_RUNAFTER_MUTATION" if help_mode else "ADD_ONLY",
        "requiresDesignerValidationAndFaultInjectionPilot": True,
        "guard": copy.deepcopy(guard),
        "originalDefinitionSha256": digest(definition),
        "candidateDefinitionSha256": digest(candidate),
        "candidateClientdata": decoded,
        "businessActionCount": business_count,
        "addedActionCount": added_count,
        "profile": copy.deepcopy(profile),
        "definitionSeed": seed_binding,
        "structuralDiff": structural_diff,
        "releaseBlockers": [
            "PARENT_RELEASEGATE_NOT_GRANTED",
            "NATIVE_SCOPE_FAILURE_AND_TERMINATION_PILOT_REQUIRED",
            "CONNECTION_REFERENCE_AND_API_BINDING_NOT_VALIDATED",
            "TRIGGER_IDENTITY_FIELDS_REQUIRE_PILOT_VALIDATION",
            "STAGE_DEFINITIONS_AND_PRODUCER_AUTHORIZATION_REQUIRE_VALIDATION",
        ] + (
            ["CASEFREE_HOST_COMPLETION_POLICY_REQUIRES_REVIEW"]
            if seed_binding and seed_binding["caseFreeHostCompletionRequiresReview"] else []
        ),
        "connectionBinding": {
            "logicalName": profile["connectionReference"],
            "connectorApi": "shared_commondataserviceforapps",
            "physicalConnectionId": None,
            "source": "Private deployment settings or environment connection reference",
            "status": "REQUIRES_PARENT_RELEASEGATE",
        },
        "sourceOperations": source_operations(profile),
        "coverage": (
            "Intake, host-start and successful host completion; failure leaves open span. "
            "Existing Failed termination outcomes retained. Not financial outcome."
            if help_mode else "Intake and successful connector completion only; not financial outcome."
        ),
    }


def source_operations(profile):
    parents = {
        "Card_Servicing_Agent": f"actions/{HELP_SWITCH}/cases/{HELP_CARD_CASE}/actions",
        "SPAM_Response": f"actions/{HELP_SWITCH}/default/actions",
    } if profile.get("adapter") == "help-v1" else {}
    paths = [
        f"{parents.get(item['action'], 'actions')}/{item['action']}"
        for item in profile["observations"] if item["action"] != HELP_SWITCH
    ]
    if profile.get("adapter") == "help-v1":
        paths.extend(
            f"actions/{HELP_SWITCH}/default/actions/route" if branch == "default"
            else f"actions/{HELP_SWITCH}/cases/{branch}/actions/route"
            for branch in HELP_BRANCH_CODES
        )
    return [
        {"path": path, "operation": operation_id(profile["workflowId"], path)}
        for path in paths
    ]


def help_review_delta(package):
    """Share only generated instrumentation and approved structural changes, never source inputs."""
    if package.get("profile", {}).get("adapter") != "help-v1":
        raise AdapterError("HELP_REVIEW_PACKAGE_REQUIRED")
    parent, key = definition_location(package["candidateClientdata"])
    definition = parent[key]
    if digest(definition) != package["candidateDefinitionSha256"]:
        raise AdapterError("CANDIDATE_HASH_MISMATCH")
    if transform(definition, package["profile"]) != definition:
        raise AdapterError("CANDIDATE_NOT_REPRODUCIBLE")
    return {
        "mode": "CONTROLLED_HELP_REVIEW_DELTA_ONLY",
        "publishable": False,
        "sourceGuard": copy.deepcopy(package["guard"]),
        "sourceBackupExported": False,
        "status": package["status"],
        "releaseBlockers": copy.deepcopy(package["releaseBlockers"]),
        "unboundParameters": ["definitionId", "producerId", "connectionReference"],
        "profile": copy.deepcopy(package["profile"]),
        "definitionSeed": copy.deepcopy(package["definitionSeed"]),
        "candidateDefinitionSha256": package["candidateDefinitionSha256"],
        "sourceOperations": copy.deepcopy(package["sourceOperations"]),
        "rewiredRunAfter": copy.deepcopy(package["structuralDiff"]),
        "generatedActions": [
            {"parent": path, "action": name, "definition": copy.deepcopy(action)}
            for path, actions in help_action_maps(definition)
            for name, action in actions.items() if name.startswith(PREFIX)
        ],
        "originalInputsOrCustomerPayloadsIncluded": False,
    }


def verify_package(package, current_snapshot):
    if not isinstance(package, dict) or package.get("mode") != "DRY_RUN_ONLY" or package.get("publishable") is not False:
        raise AdapterError("INVALID_PACKAGE_MODE")
    current_envelope, current = guard_snapshot(current_snapshot, package["guard"])
    candidate_parent, candidate_key = definition_location(package["candidateClientdata"])
    candidate = candidate_parent[candidate_key]
    if digest(current) != package["originalDefinitionSha256"]:
        raise AdapterError("ORIGINAL_DEFINITION_CHANGED")
    if digest(candidate) != package["candidateDefinitionSha256"]:
        raise AdapterError("CANDIDATE_HASH_MISMATCH")
    if candidate != transform(current, package["profile"]):
        raise AdapterError("CANDIDATE_NOT_REPRODUCIBLE")
    parent, key = definition_location(current_envelope)
    parent[key] = candidate
    if current_envelope != package["candidateClientdata"]:
        raise AdapterError("CLIENTDATA_ENVELOPE_CHANGED")
    if package["profile"].get("adapter") == "help-v1":
        if current_snapshot.get("ismanaged") is not False:
            raise AdapterError("HELP_MUST_BE_CONFIRMED_UNMANAGED")
        if guid(package["profile"]["workflowId"]) != guid(package["guard"]["workflowId"]):
            raise AdapterError("PROFILE_FLOW_ID_MISMATCH")
        current_seed = validate_help_seed(load_json(PROJECT / "config" / "process-tracking-schema.json")["seed"])
        if package.get("definitionSeed") != current_seed:
            raise AdapterError("HELP_DEFINITION_SEED_CHANGED_REVIEW_REQUIRED")
        _, expected_diff = transform_help(current, package["profile"])
        if current == candidate:
            expected_diff = []
        if package.get("structuralDiff") != expected_diff:
            raise AdapterError("UNREVIEWED_HELP_STRUCTURAL_CHANGE")
        if expected_diff:
            verify_help_business(current, candidate, expected_diff)
    elif any(candidate["actions"].get(k) != v for k, v in current["actions"].items()):
        raise AdapterError("BUSINESS_ACTION_CHANGED")
    return {"mode": "DRY_RUN_ONLY", "guardMatches": True, "published": False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser("inspect", help="Show only structural hashes/inventory")
    inspect.add_argument("--snapshot", required=True)
    prep = commands.add_parser("prepare", help="Prepare a PRIVATE review package, never publish")
    prep.add_argument("--snapshot", required=True)
    prep.add_argument("--guard", required=True)
    prep.add_argument("--profile", required=True)
    prep.add_argument("--private-directory", required=True)
    verify = commands.add_parser("verify", help="Check a fresh snapshot; performs no writes")
    verify.add_argument("--snapshot", required=True)
    verify.add_argument("--package", required=True)
    args = parser.parse_args(argv)
    try:
        snapshot = load_json(private_input(args.snapshot))
        if args.command == "inspect":
            if not isinstance(snapshot, dict):
                raise AdapterError("INVALID_SNAPSHOT_OR_GUARD")
            if environment(snapshot.get("environmentUrl")) != ENVIRONMENT_URL:
                raise AdapterError("UNAPPROVED_ENVIRONMENT")
            decoded = json.loads(snapshot["clientdata"])
            parent, key = definition_location(decoded)
            result = {
                "mode": "DRY_RUN_ONLY", "environmentUrl": ENVIRONMENT_URL,
                "status": "INVENTORY_ONLY_NOT_A_PREPARATION",
                "automaticPatchSupported": None,
                "workflowId": guid(snapshot["workflowid"]), "etag": snapshot.get("@odata.etag"),
                "sourceSha256": source_digest(snapshot["clientdata"]),
                "knownOperations": operation_inventory(parent[key]),
            }
        elif args.command == "verify":
            result = verify_package(load_json(private_input(args.package)), snapshot)
        else:
            target = private_directory(args.private_directory)
            guard = load_json(args.guard)
            profile = load_json(args.profile)
            package = prepare(snapshot, guard, profile)
            stem = f"{guid(guard['workflowId'])}-{guard['sourceSha256']}"
            backup = target / f"{stem}.source-backup.json"
            candidate = target / f"{stem}.dry-run-package.json"
            if backup.exists() or candidate.exists():
                raise AdapterError("ARTIFACT_EXISTS_REFUSING_OVERWRITE")
            exclusive_json(backup, snapshot)
            exclusive_json(candidate, package)
            if load_json(backup) != snapshot or load_json(candidate) != package:
                raise AdapterError("ARTIFACT_VERIFICATION_FAILED")
            result = {
                "mode": "DRY_RUN_ONLY", "published": False,
                "status": package["status"],
                "transformation": package["transformation"],
                "releaseBlockers": package["releaseBlockers"],
                "businessActionCount": package["businessActionCount"],
                "addedActionCount": package["addedActionCount"],
                "sourceSha256": guard["sourceSha256"],
                "backedUp": True, "packageVerified": True,
            }
        print(json.dumps(result, indent=2))
        return 0
    except AdapterError as exc:
        print(f"Preparation stopped: {exc}", file=sys.stderr)
        return 2
    except (KeyError, TypeError, ValueError, AttributeError, OSError) as exc:
        # Connector configuration or malformed files must never spill source data.
        print("Preparation stopped: INVALID_INPUT_OR_PRIVATE_STORAGE", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
