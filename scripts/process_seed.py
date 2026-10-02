"""Deterministic, immutable definition seeds; no runtime or business records."""

import json

from process_schema import CONFIG_TABLES, PROJECT, SchemaError, difference, seed_id


def publication_readiness(manifest):
    """Publication is distinct from flow activation; still pin the reviewed adapter graph."""
    gaps = []
    binding = None
    try:
        from instrument_email_flow import validate_help_seed, validate_profile

        binding = validate_help_seed(manifest["seed"])
        profile_path = PROJECT / "flow-templates" / "help-workflow.profile.example.json"
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
        validate_profile(profile)
        stages = {s["code"]: s for s in manifest["seed"]["stages"]}
        if any(
            observation["stageCode"] not in stages
            or stages[observation["stageCode"]]["completion_authority"] != "workflow"
            for observation in profile["observations"]
        ):
            gaps.append("Help producer profile stage/authority mismatch.")
        delta_path = PROJECT / "flow-templates" / "help-flow.current-source.review-delta.json"
        delta = json.loads(delta_path.read_text(encoding="utf-8"))
        if delta.get("mode", "").startswith("SUPERSEDED"):
            gaps.append("Current-source flow review delta is superseded.")
        if delta.get("definitionSeed") != binding:
            gaps.append("Current-source flow review delta does not pin this exact seed/version/hash.")
    except Exception as exc:
        gaps.append(f"Adapter/seed publication contract validation failed ({type(exc).__name__}).")
    return {"ready": not gaps, "gaps": gaps, "definition_binding": binding}


def expected_rows(manifest):
    graph = manifest["seed"]
    code, version = graph["definition_code"], graph["version"]
    definition_id = seed_id("definition", code, code, version)
    stage_ids = {s["code"]: seed_id("stage", s["code"], code, version) for s in graph["stages"]}
    rows = [{
        "table": "rfd_processdefinition", "id": definition_id,
        "values": {
            "rfd_name": graph["name"], "rfd_code": code, "rfd_version": version,
            "rfd_state": "published", "rfd_coverageversion": graph["coverage_version"],
            "rfd_allowcasefreecompletion": graph["allow_case_free_completion"],
        }, "lookups": {},
    }]
    for stage in graph["stages"]:
        rows.append({
            "table": "rfd_processstagedefinition", "id": stage_ids[stage["code"]],
            "values": {
                "rfd_name": stage["label"], "rfd_code": stage["code"],
                "rfd_phase": stage["phase"], "rfd_lane": stage["lane"],
                "rfd_nodekind": stage["kind"], "rfd_displayorder": stage["order"],
                "rfd_required": stage["required"], "rfd_coverage": stage["coverage"],
                "rfd_completionauthority": stage["completion_authority"],
                "rfd_allowcasefreecompletion": stage["allow_case_free_completion"],
                "rfd_requirescase": stage["requires_case"],
            },
            "lookups": {"rfd_definition": ("rfd_processdefinition", definition_id)},
        })
    for edge in graph["transitions"]:
        rows.append({
            "table": "rfd_processtransition", "id": seed_id("transition", edge["code"], code, version),
            "values": {
                "rfd_name": edge["label"], "rfd_code": edge["code"],
                "rfd_branchcode": edge["branch"] or None, "rfd_eventcode": edge["event"],
                "rfd_displayorder": edge["order"], "rfd_required": edge["required"],
            },
            "lookups": {
                "rfd_definition": ("rfd_processdefinition", definition_id),
                "rfd_fromstage": ("rfd_processstagedefinition", stage_ids[edge["from"]]),
                "rfd_tostage": ("rfd_processstagedefinition", stage_ids[edge["to"]]),
            },
        })
    tables = {t["logical_name"]: t for t in manifest["tables"]}
    for row in rows:
        fields = {f["logical_name"]: f for f in tables[row["table"]]["columns"]}
        for name, value in row["values"].items():
            if name not in fields or (
                isinstance(value, str) and len(value) > fields[name].get("max_length", 0)
            ):
                raise SchemaError("A definition seed value is outside the reviewed schema.")
    return rows


def inspect_seed(client, manifest, snapshot):
    expected = expected_rows(manifest)
    by_table = {}
    for row in expected:
        by_table.setdefault(row["table"], []).append(row)
    missing, conflicts, states = [], [], {}
    definition_id = expected[0]["id"]
    graph = manifest["seed"]
    for name, rows in by_table.items():
        live = snapshot.get(name)
        selected = {name + "id"}
        for row in rows:
            selected.update(row["values"])
            selected.update(f"_{field}_value" for field in row["lookups"])
        available = {f["LogicalName"] for f in (live or {}).get("Attributes", [])}
        needed = {field for row in rows for field in (*row["values"], *row["lookups"])}
        if live is None or not needed <= available:
            missing.extend({"table": name, "id": row["id"]} for row in rows)
            continue
        ids = {row["id"] for row in rows}
        id_filter = " or ".join(f"{name}id eq {key}" for key in sorted(ids))
        if name == "rfd_processdefinition":
            escaped_code = graph["definition_code"].replace("'", "''")
            scope = f"(rfd_code eq '{escaped_code}' and rfd_version eq {graph['version']})"
        else:
            scope = f"_rfd_definition_value eq {definition_id}"
        found = list(client.records.list(
            name, select=sorted(selected), filter=f"({scope}) or ({id_filter})",
        ))
        actual = {str(r[name + "id"]).lower(): r for r in found}
        if set(actual) - ids:
            conflicts.append(f"{name}: unknown row or alternate-key collision in this definition version")
        for row in rows:
            record = actual.get(row["id"])
            if record is None:
                missing.append({"table": name, "id": row["id"]})
                continue
            for field, value in row["values"].items():
                current = record.get(field)
                if name == "rfd_processdefinition" and field == "rfd_state":
                    states[row["id"]] = current
                    if current in ("draft", "published"):
                        continue
                if current != value:
                    conflicts.append(f"{name}.{field}: immutable seed differs")
            for field, (_, key) in row["lookups"].items():
                if str(record.get(f"_{field}_value") or "").lower() != key:
                    conflicts.append(f"{name}.{field}: immutable seed lookup differs")
    state = states.get(definition_id)
    if state == "published" and missing:
        conflicts.append("Published definition is incomplete; it cannot be repaired in place.")
    return {
        "missing": missing, "conflicts": sorted(set(conflicts)),
        "definition_state": state, "published": state == "published" and not missing and not conflicts,
        "expected_rows": len(expected),
    }


def provision_seed(client, manifest, snapshot):
    if not difference(manifest, snapshot)["schema_ready"]:
        raise SchemaError("Definition publication requires complete schema and Active alternate-key indexes.")
    report = inspect_seed(client, manifest, snapshot)
    if report["conflicts"]:
        raise SchemaError("Definition seed differs; no existing definition rows were overwritten.")
    if report["published"]:
        return 0
    rows = expected_rows(manifest)
    missing = {(r["table"], r["id"]) for r in report["missing"]}
    tables = {t["logical_name"]: t for t in manifest["tables"]}
    count = 0
    for row in rows:
        if row["table"] not in CONFIG_TABLES:
            raise SchemaError("The seeder is not permitted to write runtime or business records.")
        if (row["table"], row["id"]) not in missing:
            continue
        body = {row["table"] + "id": row["id"], **row["values"]}
        if row["table"] == "rfd_processdefinition":
            body["rfd_state"] = "draft"
        for field, (target, key) in row["lookups"].items():
            body[f"{field}@odata.bind"] = f"/{tables[target]['entity_set']}({key})"
        created = client.records.create(row["table"], body)
        if str(created).lower() != row["id"]:
            raise SchemaError("Dataverse did not preserve a deterministic seed GUID.")
        count += 1
    verified = inspect_seed(client, manifest, snapshot)
    if verified["missing"] or verified["conflicts"] or verified["definition_state"] != "draft":
        raise SchemaError("Definition graph validation failed; the seed was not published.")
    # This is the sole permitted seed update. Existing content is never upserted.
    client.records.update("rfd_processdefinition", rows[0]["id"], {"rfd_state": "published"})
    count += 1
    final = inspect_seed(client, manifest, snapshot)
    if not final["published"]:
        raise SchemaError("Definition publication could not be verified.")
    return count
