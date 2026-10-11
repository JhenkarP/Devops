#!/usr/bin/env python3
"""Stream the normalized BV-BRC cohort and audit exploratory species/drug scope."""

import argparse
import csv
import hashlib
import json
import sqlite3
import tempfile
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "data/amr_2m/processed/bvbrc_amr_2000000_deduplicated.jsonl"
DEFAULT_OUTPUT = ROOT / "data/models/amr_scope_audit.json"
DEFAULT_CSV = ROOT / "data/models/amr_scope_audit_pairs.csv"
PROCESSING_REPORT = ROOT / "data/amr_2m/processed/bvbrc_amr_processing_report.json"
LAB_AUDIT = ROOT / "data/models/amr_source_lab_identifier_audit.json"
BASELINE_REPORT = ROOT / "data/models/amr_feature_baseline_metrics.json"
BREAKPOINT_FIELDS = (
    "breakpoint", "breakpoint_value", "breakpoint_reference", "breakpoint_version", "breakpoint_year"
)
LABELS = ("resistant", "susceptible")


def present(value):
    return value is not None and str(value).strip().lower() not in {"", "unknown", "null", "n/a", "na"}


def normalize_organism(value):
    cleaned = str(value or "").replace('"', "").replace("'", "")
    tokens = " ".join(cleaned.split()).lower().split()
    if not tokens:
        return "unknown organism"
    if len(tokens) >= 2 and tokens[0] not in {"unknown", "uncultured"}:
        return " ".join(tokens[:2])
    return " ".join(tokens)


def normalize_antibiotic(value):
    antibiotic = " ".join(str(value or "").split()).lower()
    aliases = {
        "cipro": "ciprofloxacin",
        "trimethoprim / sulfamethoxazole": "trimethoprim-sulfamethoxazole",
        "trimethoprim/sulfamethoxazole": "trimethoprim-sulfamethoxazole",
    }
    return aliases.get(antibiotic, antibiotic)


def genome_split(genome_id):
    if not present(genome_id):
        return None
    digest = hashlib.sha256(str(genome_id).encode("utf-8")).digest()
    fold = int.from_bytes(digest[:4], "big") % 10
    return "train" if fold < 7 else "validation" if fold == 7 else "test"


def create_tables(connection):
    connection.executescript("""
        CREATE TABLE genome_labels (
            organism TEXT NOT NULL, antibiotic TEXT NOT NULL, genome_id TEXT NOT NULL, label TEXT NOT NULL,
            PRIMARY KEY (organism, antibiotic, genome_id, label)
        );
        CREATE TABLE protocol_genomes (
            organism TEXT NOT NULL, antibiotic TEXT NOT NULL, protocol TEXT NOT NULL,
            split TEXT NOT NULL, label TEXT NOT NULL, genome_id TEXT NOT NULL,
            PRIMARY KEY (organism, antibiotic, protocol, split, label, genome_id)
        );
        CREATE TABLE protocol_measured_genomes (
            organism TEXT NOT NULL, antibiotic TEXT NOT NULL, protocol TEXT NOT NULL,
            split TEXT NOT NULL, label TEXT NOT NULL, genome_id TEXT NOT NULL,
            numeric_measurement INTEGER NOT NULL,
            PRIMARY KEY (organism, antibiotic, protocol, split, label, genome_id)
        );
    """)


def aggregate_records(input_path, connection):
    pair_counts = defaultdict(Counter)
    pair_ast = defaultdict(Counter)
    protocol_records = defaultdict(Counter)
    evidence_counts = Counter()
    label_counts = Counter()
    breakpoint_counts = Counter()
    records_scanned = 0
    records_with_genome_id = 0
    records_with_organism = 0
    records_with_antibiotic = 0
    records_with_source_id = 0
    records_with_platform = 0
    records_with_publication = 0
    numeric_ast_measurements = 0
    laboratory_rs_with_genome_id = 0
    laboratory_rs_with_complete_protocol = 0
    digest = hashlib.sha256()
    cursor = connection.cursor()

    with Path(input_path).open("rb") as source:
        for raw_line in source:
            digest.update(raw_line)
            if not raw_line.strip():
                continue
            records_scanned += 1
            try:
                record = json.loads(raw_line)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError(f"Invalid JSON on input record {records_scanned}: {error}") from error
            if not isinstance(record, dict):
                raise ValueError(f"Input record {records_scanned} must be a JSON object.")

            evidence = str(record.get("evidence_class") or "unknown").strip().lower()
            label = str(record.get("label") or "unknown").strip().lower()
            organism = normalize_organism(record.get("organism"))
            antibiotic = normalize_antibiotic(record.get("antibiotic"))
            genome_id = str(record.get("genome_id") or "").strip()
            evidence_counts[evidence] += 1
            label_counts[label] += 1
            records_with_genome_id += bool(present(genome_id))
            records_with_organism += organism != "unknown organism"
            records_with_antibiotic += bool(antibiotic)
            records_with_source_id += bool(present(record.get("source_id")))
            records_with_platform += bool(present(record.get("testing_platform") or record.get("platform")))
            records_with_publication += bool(present(record.get("publication") or record.get("publication_id")))
            if present(record.get("measurement")):
                try:
                    float(str(record["measurement"]).strip())
                    numeric_ast_measurements += evidence == "laboratory"
                except ValueError:
                    pass
            for field in BREAKPOINT_FIELDS:
                breakpoint_counts[field] += bool(present(record.get(field)))
            if records_scanned % 100000 == 0:
                connection.commit()
                print(f"Audited {records_scanned:,} cohort rows", flush=True)
            if not antibiotic:
                continue

            key = (organism, antibiotic)
            pair_counts[key]["total"] += 1
            pair_counts[key][evidence if evidence in {"laboratory", "computational"} else "other"] += 1
            if evidence != "laboratory":
                continue

            pair_counts[key][f"label:{label}"] += 1
            if label not in LABELS:
                continue

            for field in ("source_id", "measurement", "measurement_unit", "measurement_sign", "testing_method",
                          "testing_standard", "testing_standard_year", "collection_year", "testing_platform",
                          "platform", "publication", "publication_id"):
                if present(record.get(field)):
                    normalized_field = "testing_platform" if field == "platform" else field
                    normalized_field = "publication" if field == "publication_id" else normalized_field
                    pair_ast[key][normalized_field] += 1
            if present(record.get("measurement")):
                try:
                    float(str(record["measurement"]).strip())
                    pair_ast[key]["numeric_measurement"] += 1
                except ValueError:
                    pass

            method = str(record.get("testing_method") or "").strip()
            standard = str(record.get("testing_standard") or "").strip()
            standard_year = str(record.get("testing_standard_year") or "").strip()
            protocol = " | ".join(value.lower() for value in (method, standard, standard_year)) \
                if all(present(value) for value in (method, standard, standard_year)) else None
            split = genome_split(genome_id)
            if present(genome_id):
                laboratory_rs_with_genome_id += 1
                cursor.execute(
                    "INSERT OR IGNORE INTO genome_labels VALUES (?, ?, ?, ?)",
                    (*key, genome_id, label),
                )
            if protocol and present(genome_id):
                laboratory_rs_with_complete_protocol += 1
                pair_ast[key]["complete_protocol"] += 1
                protocol_records[(*key, protocol)][label] += 1
                cursor.execute(
                    "INSERT OR IGNORE INTO protocol_genomes VALUES (?, ?, ?, ?, ?, ?)",
                    (*key, protocol, split, label, genome_id),
                )
                if present(record.get("measurement")) and present(record.get("measurement_unit")):
                    numeric_measurement = 0
                    try:
                        float(str(record["measurement"]).strip())
                        numeric_measurement = 1
                    except ValueError:
                        pass
                    cursor.execute(
                        "INSERT OR IGNORE INTO protocol_measured_genomes VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (*key, protocol, split, label, genome_id, numeric_measurement),
                    )

    connection.commit()
    summary = {
        "records_scanned": records_scanned,
        "sha256": digest.hexdigest(),
        "evidence_counts": dict(evidence_counts),
        "label_counts": dict(label_counts),
        "records_with_genome_id": records_with_genome_id,
        "records_with_organism": records_with_organism,
        "records_with_antibiotic": records_with_antibiotic,
        "records_with_source_id": records_with_source_id,
        "records_with_platform": records_with_platform,
        "records_with_publication": records_with_publication,
        "laboratory_numeric_ast_measurements": numeric_ast_measurements,
        "laboratory_rs_records_with_genome_id": laboratory_rs_with_genome_id,
        "laboratory_rs_records_with_complete_protocol": laboratory_rs_with_complete_protocol,
        "breakpoint_field_counts": dict(breakpoint_counts),
    }
    return pair_counts, pair_ast, protocol_records, summary


def floor_assessment(unique_genomes, train_per_class=100, test_per_class=30):
    checks = {
        "train_resistant": unique_genomes["train"]["resistant"] >= train_per_class,
        "train_susceptible": unique_genomes["train"]["susceptible"] >= train_per_class,
        "test_resistant": unique_genomes["test"]["resistant"] >= test_per_class,
        "test_susceptible": unique_genomes["test"]["susceptible"] >= test_per_class,
    }
    return {
        "meets_exploratory_floor": all(checks.values()),
        "checks": checks,
        "unmet_checks": [name for name, passed in checks.items() if not passed],
    }


def reported_protocols(protocols, detail_limit=3):
    eligible = [protocol for protocol in protocols if protocol["floor_assessment"]["meets_exploratory_floor"]]
    return eligible if eligible else protocols[:detail_limit]


def collect_pairs(connection, pair_counts, pair_ast, protocol_records, train_floor, test_floor):
    protocols_by_pair = defaultdict(list)
    for (organism, antibiotic, protocol), records in protocol_records.items():
        unique = {
            split: {label: 0 for label in LABELS}
            for split in ("train", "validation", "test")
        }
        rows = connection.execute(
            "SELECT split, label, COUNT(*) FROM ("
            "SELECT split, genome_id, MIN(label) AS label FROM protocol_genomes "
            "WHERE organism = ? AND antibiotic = ? AND protocol = ? "
            "GROUP BY split, genome_id HAVING COUNT(DISTINCT label) = 1) GROUP BY split, label",
            (organism, antibiotic, protocol),
        )
        for split, label, count in rows:
            unique[split][label] = count
        measured_unique = {
            split: {label: 0 for label in LABELS}
            for split in ("train", "validation", "test")
        }
        numeric_unique = {
            split: {label: 0 for label in LABELS}
            for split in ("train", "validation", "test")
        }
        for split, label, measured_count, numeric_count in connection.execute(
            "SELECT split, label, COUNT(*), SUM(numeric_measurement) FROM ("
            "SELECT split, genome_id, MIN(label) AS label, MAX(numeric_measurement) AS numeric_measurement "
            "FROM protocol_measured_genomes WHERE organism = ? AND antibiotic = ? AND protocol = ? "
            "GROUP BY split, genome_id HAVING COUNT(DISTINCT label) = 1) GROUP BY split, label",
            (organism, antibiotic, protocol),
        ):
            measured_unique[split][label] = measured_count
            numeric_unique[split][label] = numeric_count
        protocols_by_pair[(organism, antibiotic)].append({
            "protocol": protocol,
            "record_counts": dict(records),
            "unique_genomes": unique,
            "measured_ast_unique_genomes": measured_unique,
            "numeric_ast_unique_genomes": numeric_unique,
            "floor_assessment": floor_assessment(numeric_unique, train_floor, test_floor),
        })

    conflict_counts = {
        (organism, antibiotic): count
        for organism, antibiotic, count in connection.execute(
        "SELECT organism, antibiotic, COUNT(*) FROM ("
        "SELECT organism, antibiotic, genome_id FROM genome_labels GROUP BY organism, antibiotic, genome_id "
        "HAVING COUNT(DISTINCT label) > 1) GROUP BY organism, antibiotic"
        )
    }
    pairs = []
    for (organism, antibiotic), counts in pair_counts.items():
        if counts.get("laboratory", 0) == 0:
            continue
        labels = {label: counts.get(f"label:{label}", 0) for label in ("resistant", "susceptible", "intermediate", "nonsusceptible", "unknown")}
        genome_total = connection.execute(
            "SELECT COUNT(DISTINCT genome_id) FROM genome_labels WHERE organism = ? AND antibiotic = ?",
            (organism, antibiotic),
        ).fetchone()[0]
        protocols = sorted(
            protocols_by_pair[(organism, antibiotic)],
            key=lambda protocol: (
                -(protocol["numeric_ast_unique_genomes"]["test"]["resistant"] + protocol["numeric_ast_unique_genomes"]["test"]["susceptible"]),
                protocol["protocol"],
            ),
        )
        eligible_count = sum(protocol["floor_assessment"]["meets_exploratory_floor"] for protocol in protocols)
        protocol_details = reported_protocols(protocols)
        ast = pair_ast[(organism, antibiotic)]
        pairs.append({
            "organism": organism,
            "antibiotic": antibiotic,
            "record_counts": {key: counts.get(key, 0) for key in ("total", "laboratory", "computational", "other")},
            "laboratory_labels": labels,
            "laboratory_rs_records_with": {
                field: ast.get(field, 0) for field in (
                    "measurement", "measurement_unit", "measurement_sign", "testing_method",
                    "testing_standard", "testing_standard_year", "collection_year", "complete_protocol",
                    "source_id", "numeric_measurement", "testing_platform", "publication",
                )
            },
            "laboratory_rs_unique_genome_ids": genome_total,
            "contradictory_rs_genome_ids": conflict_counts.get((organism, antibiotic), 0),
            "complete_test_protocol_count": len(protocols),
            "eligible_protocol_count": eligible_count,
            "protocols": protocol_details,
            "protocol_details_omitted": len(protocols) - len(protocol_details),
        })
    return sorted(pairs, key=lambda pair: (pair["organism"], pair["antibiotic"]))


def choose_scope(pairs):
    qualifying = []
    for pair in pairs:
        eligible = [
            protocol for protocol in pair["protocols"]
            if protocol["floor_assessment"]["meets_exploratory_floor"]
        ]
        if eligible:
            chosen_protocol = sorted(
                eligible,
                key=lambda protocol: (
                    -(sum(protocol["numeric_ast_unique_genomes"][split][label] for split in ("train", "test") for label in LABELS)),
                    protocol["protocol"],
                ),
            )[0]
            qualifying.append((pair, chosen_protocol))
    if not qualifying:
        return {"status": "no_pair_meets_exploratory_floor", "selected_species": None, "selected_antibiotics": [], "candidate_pairs": []}

    organisms = defaultdict(list)
    for pair, protocol in qualifying:
        organisms[pair["organism"]].append((pair, protocol))
    selected_species, selected = sorted(
        organisms.items(),
        key=lambda item: (
            -len(item[1]),
            -sum(sum(protocol["numeric_ast_unique_genomes"][split][label] for split in ("train", "test") for label in LABELS) for _, protocol in item[1]),
            item[0],
        ),
    )[0]
    selected.sort(key=lambda item: (
        -(item[1]["numeric_ast_unique_genomes"]["test"]["resistant"] + item[1]["numeric_ast_unique_genomes"]["test"]["susceptible"]),
        item[0]["antibiotic"],
    ))
    return {
        "status": "exploratory_candidate_found",
        "selected_species": selected_species,
        "selected_antibiotics": [pair["antibiotic"] for pair, _ in selected],
        "candidate_pairs": [{
            "organism": pair["organism"],
            "antibiotic": pair["antibiotic"],
            "selected_protocol": protocol["protocol"],
            "unique_genomes": protocol["unique_genomes"],
            "measured_ast_unique_genomes": protocol["measured_ast_unique_genomes"],
            "numeric_ast_unique_genomes": protocol["numeric_ast_unique_genomes"],
        } for pair, protocol in selected],
    }


def optional_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def make_report(input_path, output_path, csv_path, train_floor=100, test_floor=30):
    input_path = Path(input_path)
    output_path = Path(output_path)
    csv_path = Path(csv_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="amr-scope-audit-") as temporary:
        connection = sqlite3.connect(Path(temporary) / "audit.sqlite")
        create_tables(connection)
        pair_counts, pair_ast, protocol_records, summary = aggregate_records(input_path, connection)
        pairs = collect_pairs(connection, pair_counts, pair_ast, protocol_records, train_floor, test_floor)
        connection.close()

    processing = optional_json(PROCESSING_REPORT)
    lab_audit = optional_json(LAB_AUDIT)
    baseline = optional_json(BASELINE_REPORT)
    expected_name = processing.get("deduplicated_output") if processing else None
    expected_count = processing.get("deduplicated_records") if processing else None
    input_matches = input_path.name == expected_name and summary["records_scanned"] == expected_count
    scope = choose_scope(pairs)
    report = {
        "schema_version": "amr-scope-audit-v1",
        "inputs": {
            "cohort": input_path.relative_to(ROOT).as_posix() if input_path.is_relative_to(ROOT) else str(input_path),
            "bytes": input_path.stat().st_size,
            "sha256": summary.pop("sha256"),
            "records_scanned": summary["records_scanned"],
            "malformed_records": 0,
            "deduplication_report_match": input_matches,
            "declared_deduplicated_records": expected_count,
        },
        "provisional_feasibility_floor": {
            "unique_genome_ids_per_class_train": train_floor,
            "unique_genome_ids_per_class_test": test_floor,
            "interpretation": "Exploratory project-scoping floor only; not a clinical acceptance criterion.",
            "split": "Deterministic genome-ID SHA-256 split matching ml-service/baselines.py: 70% train, 10% validation, 20% test.",
            "protocol": "Support must pass within one recorded testing-method + standard + standard-year stratum.",
            "measured_ast_requirement": "Counts require a numeric measurement and unit linked to the same genome, class, split, and protocol.",
        },
        "cohort_summary": summary,
        "checkpoints": [
            {"id": "source_integrity", "status": "complete" if input_matches else "needs_review", "result": "Input filename and row count match the existing deduplication report." if input_matches else "Input filename or row count does not match the existing deduplication report."},
            {"id": "evidence_separation", "status": "complete", "result": "Only laboratory R/S labels contribute to exploratory pair support; evidence and labels are reported separately."},
            {"id": "genome_linkage", "status": "partial", "result": f"{summary['laboratory_rs_records_with_genome_id']} laboratory R/S rows have a genome ID. IDs do not establish distinct biological isolates or available, quality-controlled assemblies."},
            {"id": "ast_metadata", "status": "partial", "result": f"{summary['laboratory_rs_records_with_complete_protocol']} laboratory R/S rows have a genome ID and complete method/standard/year; {summary['laboratory_numeric_ast_measurements']} laboratory rows have numeric AST measurements overall. Pair eligibility uses numeric value plus unit linked to the same genome and protocol. Explicit breakpoint metadata is absent from the normalized source schema."},
            {"id": "pair_support", "status": "complete", "result": f"{len(pairs)} species-antibiotic pairs summarized with unique genome support by split and AST protocol."},
            {"id": "breakpoint_verification", "status": "blocked", "result": "Testing standard/year is not a verified species-drug breakpoint table. Do not reinterpret numeric AST values or harmonize labels without the applicable versioned breakpoints."},
            {"id": "physical_laboratory_provenance", "status": "blocked", "result": "The existing source audit found no verified physical testing-facility identifier. Submitter/owner metadata cannot establish unseen-laboratory validation."},
            {"id": "exploratory_scope_selection", "status": "complete" if scope["candidate_pairs"] else "blocked", "result": f"Found a numeric-AST support candidate for {scope['selected_species']}; it is not a usable phenotype-model scope because breakpoint evidence is missing." if scope["candidate_pairs"] else "No pair meets the provisional floor using numeric AST value/unit linked to the genome and complete protocol."},
            {"id": "independent_external_validation", "status": "blocked", "result": "A separate cohort with verified independent physical-laboratory provenance is still required."},
        ],
        "data_limitations": {
            "physical_testing_laboratory_identifiers": (lab_audit or {}).get("candidate_lab_or_facility_fields", {}),
            "submitter_metadata_is_physical_lab_identity": False,
            "isolate_ids_present": False,
            "assemblies_present_in_amr_source": False,
            "explicit_breakpoint_values_or_references_present": any(summary["breakpoint_field_counts"].values()),
            "normalized_source_id_records": summary["records_with_source_id"],
            "platform_metadata_records": summary["records_with_platform"],
            "publication_metadata_records": summary["records_with_publication"],
            "testing_standard_and_year_are_sufficient_to_reconstruct_breakpoints": False,
            "scope_use": "Any selected scope is exploratory and does not support treatment selection or clinical susceptibility claims.",
        },
        "scope_recommendation": scope,
        "usable_model_scope": {
            "status": "blocked_missing_breakpoints" if not any(summary["breakpoint_field_counts"].values()) else "requires_breakpoint_review",
            "is_usable": False,
            "reason": "The cohort contains no explicit versioned species-drug breakpoint value/reference; AST labels cannot be independently harmonized or verified.",
            "support_candidate": scope["candidate_pairs"],
        },
        "qualifying_pair_count": sum(pair["eligible_protocol_count"] > 0 for pair in pairs),
        "below_floor_pairs": sorted(
            (pair for pair in pairs if pair["protocols"]),
            key=lambda pair: (
                -(pair["protocols"][0]["unique_genomes"]["test"]["resistant"] + pair["protocols"][0]["unique_genomes"]["test"]["susceptible"]),
                pair["organism"], pair["antibiotic"],
            ),
        )[:20],
        "pairs": pairs,
        "related_existing_evidence": {
            "model_version": (baseline or {}).get("model_version"),
            "scope_note": "The existing baseline uses organism, antibiotic, and resistance-product-name features; this audit does not imply a sequence-based phenotype model.",
        } if baseline else None,
    }
    from datetime import datetime, timezone
    report["generated_at"] = datetime.now(timezone.utc).isoformat()
    output_path.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    with csv_path.open("w", newline="", encoding="utf-8") as output:
        writer = csv.writer(output)
        writer.writerow((
            "organism", "antibiotic", "laboratory_records", "resistant_records", "susceptible_records",
            "unique_genome_ids", "contradictory_rs_genome_ids", "numeric_ast_records", "complete_protocol_records",
            "complete_protocol_count", "eligible_protocol_count",
        ))
        for pair in pairs:
            writer.writerow((
                pair["organism"], pair["antibiotic"], pair["record_counts"]["laboratory"],
                pair["laboratory_labels"]["resistant"], pair["laboratory_labels"]["susceptible"],
                pair["laboratory_rs_unique_genome_ids"], pair["contradictory_rs_genome_ids"],
                pair["laboratory_rs_records_with"]["numeric_measurement"],
                pair["laboratory_rs_records_with"]["complete_protocol"],
                pair["complete_test_protocol_count"], pair["eligible_protocol_count"],
            ))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--train-per-class", type=int, default=100)
    parser.add_argument("--test-per-class", type=int, default=30)
    arguments = parser.parse_args()
    if arguments.train_per_class < 1 or arguments.test_per_class < 1:
        parser.error("support floors must be positive integers")
    report = make_report(
        arguments.input, arguments.output, arguments.csv,
        arguments.train_per_class, arguments.test_per_class,
    )
    print(f"Wrote {arguments.output}")
    print(f"Wrote {arguments.csv}")
    print(json.dumps(report["scope_recommendation"], indent=2))


if __name__ == "__main__":
    main()