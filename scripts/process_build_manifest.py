"""Generate the reviewable Stage 2 manifest from the sibling service contract, offline."""

import argparse
import json
from pathlib import Path

from process_schema import MANIFEST, PROJECT, TARGET, digest, validate_manifest


CONTRACT = PROJECT / "server" / "process-contract.json"
NAMES = {
    "rfd_processdefinition": ("Process definition", "Process definitions", "rfd_processdefinitions"),
    "rfd_processstagedefinition": ("Process stage definition", "Process stage definitions", "rfd_processstagedefinitions"),
    "rfd_processtransition": ("Process transition", "Process transitions", "rfd_processtransitions"),
    "rfd_emailprocess": ("Email process", "Email processes", "rfd_emailprocesses"),
    "rfd_emailprocessstage": ("Email process stage", "Email process stages", "rfd_emailprocessstages"),
    "rfd_emailprocessevent": ("Email process event", "Email process events", "rfd_emailprocessevents"),
    "rfd_emailprocesscase": ("Email process case", "Email process cases", "rfd_emailprocesscases"),
}
def build_manifest(contract):
    tables = []
    for source in contract["tables"]:
        name = source["logicalName"]
        singular, plural, entity_set = NAMES[name]
        columns = []
        for column in source["columns"]:
            field = {
                "logical_name": column["name"], "type": column["type"].lower(),
                "required": column.get("required", False),
            }
            if "maxLength" in column:
                field["max_length"] = column["maxLength"]
            if column.get("secured"):
                field["secured"] = True
            if column.get("referenceTarget"):
                field["reference_target"] = column["referenceTarget"]
                field["reference_kind"] = column["referenceKind"]
            if field["type"] == "lookup":
                target = column["target"]
                field.update(
                    target=target,
                    relationship=f"rfd_{name[4:]}_{column['name'][4:]}",
                    delete="Restrict" if target in NAMES else "RemoveLink",
                    merge="Cascade" if target == "contact" else "NoCascade",
                    navigation_property=column["name"],
                )
                if column["name"] in ("rfd_parentprocess", "rfd_parentexecution", "rfd_sourceevent"):
                    field["delete"] = "RemoveLink"
            columns.append(field)
        tables.append({
            "logical_name": name, "label": singular, "collection_label": plural,
            "entity_set": entity_set, "primary_id": source["primaryId"],
            "primary_name": source["primaryName"], "ownership": source["ownership"],
            "table_type": "Standard", "optimistic_concurrency": True,
            "columns": columns, "keys": source["alternateKeys"],
        })
    manifest = {
        "schema_version": 1,
        "target": dict(TARGET),
        "service_contract": "server\\process-contract.json",
        "service_table_contract_sha256": digest(contract["tables"]),
        "semantics": {
            "choice_storage": "Allowlisted case-sensitive strings, not custom Dataverse state/status reasons.",
            "definition_states": ["draft", "published", "retired"],
            "process_states": contract["processStates"],
            "execution_states": contract["executionStates"],
            "event_types": contract["eventTypes"],
            "key_integrity": "ApplicationRequired is not server enforcement. API/guards must reject null/empty keys.",
            "source_versions": "Decimal version strings preserve Dataverse row-version precision; compare numerically.",
            "event_payload": "Allowlisted sanitized canonical event envelope only; never free-form producer payloads.",
            "time": "DateAndTime/UserLocal metadata; producers send UTC and UI localizes.",
            "index_scope": "Alternate keys below create supported unique indexes; no fabricated SQL index DDL.",
            "overflow": "Reject overlength values; never truncate identifiers, source versions or hash input.",
        },
        "tables": tables,
        "seed": {
            "definition_code": "help-email",
            "version": 1,
            "name": "Help email - observed classification and Card Servicing routing",
            "coverage_version": "help-observed-v1-uninstrumented",
            "entry_stage": "intake",
            "allow_case_free_completion": False,
            "completion_note": (
                "Current Card and default branches explicitly Terminate(Failed). Successful host "
                "calls cannot imply end-to-end/no-case success. No-case completion stays disabled; "
                "card servicing requires a case, and host-call success is not financial success."
            ),
            "publication": "published",
            "stages": [
                {"code": "intake", "label": "Help email received", "phase": "intake", "lane": "help-flow",
                 "kind": "start", "order": 0, "required": True, "coverage": "uninstrumented",
                 "completion_authority": "intake"},
                {"code": "classify", "label": "Classify_Email", "phase": "classify", "lane": "help-flow",
                 "kind": "task", "order": 10, "required": True, "coverage": "uninstrumented",
                 "completion_authority": "workflow"},
                {"code": "route", "label": "Switch on classification", "phase": "route", "lane": "help-flow",
                 "kind": "gateway", "order": 20, "required": True, "coverage": "uninstrumented",
                 "completion_authority": "workflow"},
                {"code": "card-servicing", "label": "Card Servicing saved agent - host invocation only", "phase": "act", "lane": "saved-agent",
                 "kind": "subprocess", "order": 30, "required": False, "coverage": "opaque",
                 "completion_authority": "workflow"},
                {"code": "contact-lookup", "label": "Customer resolution - planned tool-observation overlay",
                 "phase": "identify", "lane": "instrumentation-overlay",
                 "kind": "task", "order": 35, "required": False, "coverage": "unknown",
                 "completion_authority": "tool"},
                {"code": "spam", "label": "SPAM / default", "phase": "route", "lane": "help-flow",
                 "kind": "task", "order": 40, "required": False, "coverage": "uninstrumented",
                 "completion_authority": "workflow"},
                {"code": "mock-response", "label": "Mock_Response_Agent", "phase": "act", "lane": "help-flow",
                 "kind": "subprocess", "order": 45, "required": False, "coverage": "opaque",
                 "completion_authority": "workflow"},
                {"code": "reviewcase", "label": "Case review and lifecycle", "phase": "review", "lane": "case-management",
                 "kind": "wait", "order": 50, "required": False, "coverage": "unknown",
                 "completion_authority": "case-observer"},
            ],
            "transitions": [
                {"code": "received", "from": "intake", "to": "classify", "label": "Received for classification",
                 "branch": "", "event": "received", "order": 0, "required": True},
                {"code": "classified", "from": "classify", "to": "route", "label": "Classification observed",
                 "branch": "", "event": "completed", "order": 10, "required": True},
                {"code": "card-route", "from": "route", "to": "card-servicing", "label": "Card Servicing",
                 "branch": "card-servicing", "event": "completed", "order": 20, "required": True},
                {"code": "default-spam", "from": "route", "to": "spam", "label": "SPAM / default",
                 "branch": "spam", "event": "completed", "order": 30, "required": True},
                {"code": "payment-direct-debits-route", "from": "route", "to": "mock-response",
                 "label": "Payment & direct debits - empty case reaches mock response",
                 "branch": "payment-direct-debits", "event": "completed", "order": 31, "required": True},
                {"code": "disputes-fraud-route", "from": "route", "to": "mock-response",
                 "label": "Disputes & fraud - empty case reaches mock response",
                 "branch": "disputes-fraud", "event": "completed", "order": 32, "required": True},
                {"code": "details-documents-route", "from": "route", "to": "mock-response",
                 "label": "Details & Documents - empty case reaches mock response",
                 "branch": "details-documents", "event": "completed", "order": 33, "required": True},
                {"code": "complaints-route", "from": "route", "to": "mock-response",
                 "label": "Complaints - empty case reaches mock response",
                 "branch": "complaints", "event": "completed", "order": 34, "required": True},
                {"code": "explicit-case-link", "from": "card-servicing", "to": "reviewcase",
                 "label": "Only if an actual blocking case is explicitly linked",
                 "branch": "case-linked", "event": "case-linked", "order": 40, "required": False},
            ],
        },
        "retention": {
            "proposed_event_days": 90, "approved": False,
            "policy": "No automated deletion. Preserve open summaries and case links. Mark truncated histories.",
            "relationships": "Never Cascade delete events. Source CRM deletes RemoveLink, tracking parents Restrict.",
        },
        "deployment_gates": [
            "Only metadata and definition seeds are provisioned; no runtime/business/email rows are written.",
            "Require Active alternate-key indexes before definition publication or producer enablement.",
            "Install and verify trusted API mutation guards, definition immutability and append-only event guards.",
            "Provision reviewed reader/producer/reviewer/retention-admin roles and identity field-security profiles.",
            "Prove two-user/team visibility and actual producer privileges; table links do not grant record access.",
            "Approve operations-team ownership and owner propagation for all runtime rows.",
            "Test live transaction/concurrency, duplicate replay, case lifecycle and schema round trips.",
            "Preserve observed Failed terminations; do not enable no-case completion from host success.",
            "Verify exact Help seed/profile/current-source delta hashes before definition publication.",
            "Export/unpack generated solution metadata after separately authorized live apply.",
        ],
    }
    for stage in manifest["seed"]["stages"]:
        stage["allow_case_free_completion"] = False
        stage["requires_case"] = stage["code"] == "card-servicing"
    return validate_manifest(manifest)


def reference_text(manifest):
    note_field = next(
        field["logical_name"] for table in manifest["tables"] for field in table["columns"]
        if field.get("reference_target") == "annotation"
    )
    lines = [
        "EMAIL PROCESS TRACKING - STAGE 2 SCHEMA REFERENCE",
        "Generated locally by scripts\\process_build_manifest.py --write.",
        "",
        "SOURCE OF TRUTH AND REVIEW",
        "config\\process-tracking-schema.json is the complete reviewable metadata manifest.",
        "server\\process-contract.json supplies service field names/types/lengths/requiredness.",
        "The manifest adds explicit table ownership, entity sets, relationship/cascade settings,",
        "the observed graph, security and deployment gates; it never invents service columns.",
        "Manifest SHA-256: " + digest(manifest),
        "Digest: entire parsed JSON, sorted keys, UTF-8, ensure_ascii=False, separators=(',', ':').",
        "A changed contract requires regeneration, review and a new explicitly approved hash.",
        "",
        "VERIFIED PROVISIONING RECORD - 2 OCTOBER 2026",
        "Authorized additive apply completed: 7 tables, 109 declared columns (83 scalar/name",
        "and 26 lookup columns/relationships), 7 Active alternate keys in RetailFinanceDemo.",
        "The 18 deterministic definition/stage/transition rows were verified and published.",
        "A subsequent identical apply performed ZERO writes. All four runtime tables were",
        "verified empty. No business records, emails, role grants, flows or deployments changed.",
        "Four newly created empty runtime primary-name defaults were corrected to the reviewed",
        "200/ApplicationRequired using exact table metadata IDs and full preserved metadata.",
        "Private parent-session files: process-schema-ready.json;",
        "RetailFinanceDemo-after-process-schema.zip; RetailFinanceDemo-after-process-schema",
        "(PAC-generated unpacked directory, all seven Entity.xml artifacts verified).",
        "Roles, field-security profile assignments and end-to-end producer tests remain gated.",
        "This dated evidence is not a substitute for running a fresh --inspect.",
        "",
        "SAFE COMMANDS (from the project root)",
        "python scripts\\process_build_manifest.py --check",
        "python scripts\\process_provision.py --dry-run",
        "python scripts\\process_provision.py --inspect",
        "python -m unittest discover -s scripts -p \"process_*test.py\" -v",
        "Dry run is offline and never loads auth. Inspect reads live identity and metadata only.",
        "Neither mode creates tables, seeds, messages, cases, plugins or runtime records.",
        "",
        "APPLY IS A SEPARATE AUTHORIZED ACTION; DO NOT RUN AS PART OF PREVIEW",
        "python scripts\\process_provision.py --apply --expected-manifest-sha256 <reviewed-hash>",
        "  --expected-url https://smc-diamond-service.crm.dynamics.com",
        "  --expected-solution RetailFinanceDemo --expected-publisher rfd",
        "  --expected-identity admin@diax47618638.onmicrosoft.com",
        "Pass these on one command line, or use normal PowerShell continuation.",
        "Add --schema-only to provision metadata without seeding/publishing the definition.",
        "There is no delete, replace, force, overwrite-schema, runtime-import or email-send mode.",
        "Preflight checks CLI and SDK identity, organization/environment URL and IDs, existing",
        "unmanaged solution and publisher; it rechecks immediately before metadata/seed writes.",
        "Apply refuses ALL writes on existing schema/seed drift, unmanaged-solution mismatch,",
        "unsupported target relationship capability or a missing explicit approval argument.",
        "",
        "SUPPORTED SDK / MANAGED CLI BOUNDARIES",
        "SDK clients come only from the initialized Scout scripts\\auth.py get_client.",
        "SDK reads columns/relationships/records, creates full 1:N relationships with a solution,",
        "and creates deterministic seed records. No token caches or credentials are inspected.",
        "Installed SDK tables.create has no ownership flag; column helpers lack exact lengths,",
        "requiredness and field security; alternate-key helper has no solution argument.",
        "For those gaps only, use managed dataverse api request with a fixed environment and",
        "MSCRM.SolutionUniqueName. No custom HTTP/auth client and no hand-authored solution XML.",
        "Metadata bodies use short-lived project-local JSON files, always removed in finally.",
        "Windows runs the installed PowerShell CLI wrapper with literal argv, avoiding cmd.exe",
        "percent/ampersand expansion and inline JSON length limits.",
        "",
        "PROVISIONING / IDEMPOTENCY",
        "Create missing tables, then missing scalar fields, lookups, and alternate keys.",
        "Never alter/delete unknown existing schema. Existing declared properties must match.",
        "Publish only these seven tables' metadata, not PublishAllXml.",
        "Poll all key indexes until Active (default 600 seconds); Failed/timeout is not ready.",
        "Only then create the reviewed definition as draft, stages and transitions using UUIDv5.",
        "Verify every scalar, typed reference and complete child-row set before publishing.",
        "Before any seed writes, validate Help producer stage authorities and six-route mapping;",
        "require a nonsuperseded current-source review delta with matching definitionSeed",
        "definitionCode/version/seedSha256. Metadata-only apply is available while this gate blocks.",
        "The only seed update permitted is the matching draft definition's state to published.",
        "A repeated identical run is a no-op; an interrupted draft resumes missing rows.",
        "An incomplete or edited published definition is never repaired/overwritten in place.",
        "Use a quiet definition-administration window: SDK record updates have no ETag option.",
        "The graph verification/publish sequence is not one transaction. Install immutable",
        "definition guards before enabling producers; use a new version for later graph changes.",
        "Observed runtime table-shell creation returned primary-name defaults (850/None).",
        "A narrowly scoped recovery flag --repair-created-primary TABLE=METADATA_GUID accepts",
        "only exact known created runtime table IDs, empty tables, the observed default shape,",
        "and no unrelated metadata drift. It preserves full attribute metadata/labels and sets",
        "only the reviewed rfd_name MaxLength=200 and ApplicationRequired, then republishes.",
        "Never use this recovery flag for an unknown preexisting table or a table with data.",
        "",
        "GRAPH AND PRODUCER MAP",
        "Observed receipt (intake/start), then Classify_Email (classify), then Switch (route).",
        "The actual received fact creates the intake execution; there is no synthetic success-end node.",
        "Observed routes: Card Servicing -> saved agent; SPAM/default -> explicit terminal.",
        "Four observed empty switch cases reach Mock_Response_Agent: payment-direct-debits,",
        "disputes-fraud, details-documents, complaints. Each required selected edge leads to",
        "the same optional workflow-authority mock-response host stage; its internals stay opaque.",
        "Existing Card/default Terminate(Failed) actions remain producer facts, not rewritten success.",
        "The saved agent is an opaque outer boundary. No invented internal tools or outcomes.",
        "Card-servicing completion authority is workflow, explicitly HOST INVOCATION ONLY.",
        "The observed InvokeAgent result settles this host span, never a financial-tool outcome.",
        "requirescase=true prevents host success becoming no-case completion. Actual financial",
        "tool stages require independently observed wrappers and are not invented in this version.",
        "contact-lookup is an OPTIONAL planned identify-phase tool-observation overlay, not a",
        "claim that saved-agent internals are instrumented. It has no graph dependency edge.",
        "Only an authorized real lookup wrapper may produce it and bind a caller-readable Contact.",
        "reviewcase is separate and reached only by an actual explicit case link.",
        "Seed coverage says uninstrumented/opaque/unknown, never falsely instrumented.",
        "Intake, classifier and switch are required; branch/review applicability is runtime evidence.",
        "All six switch transitions are required only when their normalized branch is selected.",
        "Their target stages are not unconditional requirements. Mock response is not evidence",
        "of a financial action or an invented no-case success.",
        "The service supports definition+stage gated no-case completion, but this observed",
        "definition disables it: both Card/default branches explicitly Terminate(Failed).",
        "No stage is marked no-case; card-servicing requirescase=true. A successful SPAM",
        "host call before the original Failed termination is not end-to-end success.",
        "Ingress carries full ProcessId and source run; transport retries retain event/span IDs.",
        "",
        "SOURCE REFERENCES AND DELETE BEHAVIOR",
        "Contact=contact/contactid; Case=incident/incidentid; Holding=rfd_financialaccount/",
        "rfd_financialaccountid; Email=email/activityid; Task=task/activityid;",
        "Note=annotation/annotationid; Workflow=workflow/workflowid.",
        "Native flow-run/conversation references remain external strings, never fake lookups.",
        "Read-only inspection on 2026-10-02: annotation's CanBePrimaryEntityInRelationship",
        "is false and immutable; all other listed targets plus systemuser allow relationships.",
        f"The canonical contract therefore uses nullable {note_field} String(36), marked",
        "referenceTarget=annotation/referenceKind=non-relational-guid. The service validates",
        "the GUID and caller's annotation read access; this is not a Dataverse lookup.",
        "There is no database FK/delete cleanup for this reference; retention/anonymization",
        "must handle unavailable notes explicitly. No annotation business row is modified.",
        "Source CRM lookups use RemoveLink: CRM deletion never cascades into event loss.",
        "Required tracking-parent lookups Restrict deletion while children/history exist.",
        "Optional parent process/execution and source-event references RemoveLink.",
        "No relationship uses Cascade delete. ApplicationRequired is a UI requirement, not",
        "a server integrity constraint: APIs/guards must reject empty/null runtime keys.",
        "Contact is mergeable: Dataverse requires Merge=Cascade for its relationships (this",
        "reparents links on merge; it is NOT Cascade delete). All other declared Merge settings",
        "are NoCascade. Event facts/digests remain immutable; prove merge/guard behavior in pilot.",
        "Reference: learn.microsoft.com/power-apps/developer/data-platform/",
        "configure-entity-relationship-cascading-behavior",
        "The unique process/case pair represents one-message/many-case and many-message/one-case.",
        "fixtures\\process-tracking-relations.json demonstrates both without creating live rows.",
        "",
        "SECURITY DESIGN / PERMISSION GATES",
        "Reader: configuration Read; scoped team/user runtime Read; no restricted identities.",
        "Producer: only reviewed API privileges plus necessary narrow runtime CRUD/Append/",
        "AppendTo in its operations-team scope; trusted mutation guards reject direct writes.",
        "Reviewer: Reader plus separately approved case business operations, not event writes.",
        "Definition administrator: configuration create/update only; immutable published graphs.",
        "Retention administrator: separately approved retention path; no blanket user delete.",
        "Raw InternetMessageId, locator, actual From, Reply-To, customer email and identity-source",
        "fields request IsSecured=true. A rejected security capability is a blocker, not a",
        "reason to silently create an unprotected field. Field-security profiles/grants require",
        "separate review and two-user/producer tests; roles/profiles are NOT installed here.",
        "Current admin preflight is not proof of producer/reader authorization.",
        "Runtime ownership must be assigned consistently by the service; a Case lookup does",
        "not grant access to the process, event or another user's identity columns.",
        "",
        "RETENTION AND ALM",
        "90-day event detail is a proposal, not an enabled deletion job. Keep open-process",
        "summaries/links until approved closure rules; flag histories after detail retention.",
        "No body, subject, prompt, reasoning, attachment, account/card number or arbitrary",
        "error payload belongs here. rfd_payloadjson is sanitized allowlisted event data only.",
        "Dry-run and inspect perform no writes. Seven tables were absent on the initial",
        "2026-10-02 read-only inspection. Subsequent inspect is authoritative after authorized apply.",
        "After separately authorized apply, parent-owned export/unpack captures server-generated",
        "solution artifacts. This tooling neither deploys, exports, commits nor sends emails.",
        "schema_ready means exact metadata and Active keys, not production readiness.",
        "production_ready remains false pending all deployment gates below.",
        "",
        "DEPLOYMENT GATES",
        *["- " + gate for gate in manifest["deployment_gates"]],
        "",
        "TABLE / COLUMN DICTIONARY",
        "R=ApplicationRequired; O=optional. Logical names/navigation names are lowercase.",
        "System primary IDs, ownerid, statecode/statuscode, audit timestamps and versionnumber",
        "are server-created columns and are not redeclared. Semantic rfd_state is a string.",
        "All tables are Standard with optimistic concurrency enabled. Plugin updates must",
        "still explicitly request IfRowVersionMatches; metadata alone is not concurrency control.",
    ]
    for table in manifest["tables"]:
        lines += [
            "", table["logical_name"] + " [" + table["ownership"] + "]",
            "  Entity set: " + table["entity_set"],
            "  Primary GUID: " + table["primary_id"] + "; display: " + table["primary_name"],
        ]
        for key in table["keys"]:
            lines.append("  Unique key " + key["name"] + ": " + ", ".join(key["columns"]))
        for field in table["columns"]:
            description = field["type"]
            if "max_length" in field:
                description += "(" + str(field["max_length"]) + ")"
            if field["type"] == "lookup":
                description += " -> " + field["target"] + "; delete=" + field["delete"]
                description += "; merge=" + field["merge"]
                description += "; relationship=" + field["relationship"]
            if field.get("secured"):
                description += "; field-security enabled"
            if field.get("reference_target"):
                description += "; validated non-relational GUID -> " + field["reference_target"]
            lines.append("  " + field["logical_name"] + ": " + description + ("; R" if field["required"] else "; O"))
    lines += [
        "", "SEMANTIC STRING ALLOWLISTS",
        "Definition states: " + ", ".join(manifest["semantics"]["definition_states"]),
        "Process states: " + ", ".join(manifest["semantics"]["process_states"]),
        "Execution states: " + ", ".join(manifest["semantics"]["execution_states"]),
        "Event types: " + ", ".join(manifest["semantics"]["event_types"]),
        "Not-started/unknown/uninstrumented are presentation states, not fabricated execution rows.",
        "",
    ]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", type=Path, default=CONTRACT)
    parser.add_argument("--write", action="store_true", help="Write the local generated manifest; never touches Dataverse.")
    parser.add_argument("--check", action="store_true", help="Fail if the generated manifest differs from the contract.")
    args = parser.parse_args()
    manifest = build_manifest(json.loads(args.contract.read_text(encoding="utf-8")))
    if args.write:
        MANIFEST.parent.mkdir(parents=True, exist_ok=True)
        MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        reference = PROJECT / "docs" / "process-schema-reference.txt"
        reference.parent.mkdir(parents=True, exist_ok=True)
        reference.write_text(reference_text(manifest), encoding="utf-8")
    if args.check:
        if not MANIFEST.exists() or json.loads(MANIFEST.read_text(encoding="utf-8")) != manifest:
            parser.error("The manifest is stale. Review the contract changes, then regenerate.")
    print(json.dumps({"manifest_sha256": digest(manifest), "tables": len(manifest["tables"]), "live_writes": 0}))


if __name__ == "__main__":
    main()
