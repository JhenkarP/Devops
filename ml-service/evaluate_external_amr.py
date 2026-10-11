import argparse
import hashlib
import json
import random
import re
from collections import defaultdict
from pathlib import Path

from joblib import load
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

from baselines import (
    DEFAULT_AMR_INPUT,
    DEFAULT_AMR_MODEL,
    DEFAULT_AMR_REPORT,
    ROOT,
    evaluate_predictions,
    expected_calibration_error,
    feature_dict,
    genome_fold,
    percentile_interval,
    read_jsonl,
    wilson_interval,
)


REQUIRED_ATTESTATIONS = {
    "dataset_name": str,
    "source_url": str,
    "independence_evidence": str,
    "laboratory_identity_evidence": str,
    "isolate_identity_evidence": str,
    "license_or_access_terms": str,
}
REQUIRED_COHORT_FIELDS = {
    "measurement_id",
    "isolate_id",
    "genome_id",
    "laboratory_id",
    "organism",
    "antibiotic",
    "label",
    "products",
    "evidence_class",
    "testing_method",
}


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_attestation(manifest, cohort_sha256):
    missing = [field for field in REQUIRED_ATTESTATIONS if not isinstance(manifest.get(field), str) or not manifest[field].strip()]
    if missing:
        raise ValueError(f"Manifest is missing required provenance fields: {', '.join(sorted(missing))}")
    if manifest.get("independent_of_training") is not True:
        raise ValueError("Manifest must attest that this cohort is independent of model training and tuning.")
    if manifest.get("phenotype_evidence") != "measured_ast":
        raise ValueError("Only measured antimicrobial susceptibility test labels are eligible for external evaluation.")
    if manifest.get("laboratory_id_semantics") != "physical_testing_facility":
        raise ValueError("laboratory_id must identify a physical facility that performed the susceptibility test.")
    if manifest.get("isolate_id_semantics") != "biological_isolate":
        raise ValueError("isolate_id must identify the biological isolate, not a record or genome submission.")
    if manifest.get("cohort_sha256") != cohort_sha256:
        raise ValueError("Cohort SHA-256 does not match the checksum declared in the manifest.")
    return {
        "declared_independent_of_training": True,
        "phenotype_evidence": "measured_ast",
        "laboratory_id_semantics": "physical_testing_facility",
        "isolate_id_semantics": "biological_isolate",
        "attestations_are_self_declared": True,
        "verification_limitation": "The evaluator checks declarations and cited evidence references; a reviewer must verify source documentation and facility identity.",
    }


def training_genomes(input_path):
    genomes = set()
    for record in read_jsonl(input_path):
        if record.get("evidence_class") != "laboratory" or record.get("label") not in {"resistant", "susceptible"}:
            continue
        genome_id = record.get("genome_id")
        if genome_id and genome_fold(genome_id) in {"train", "validation"}:
            genomes.add(str(genome_id))
    return genomes


def group_bootstrap_intervals(labels, scores, groups, seed=42, replicates=500):
    members_by_group = defaultdict(list)
    for index, group in enumerate(groups):
        members_by_group[group].append(index)
    group_names = sorted(members_by_group)
    if len(group_names) < 2:
        return {metric: None for metric in ("auroc", "auprc", "brier_score", "expected_calibration_error")}

    randomizer = random.Random(seed)
    values = {metric: [] for metric in ("auroc", "auprc", "brier_score", "expected_calibration_error")}
    for _ in range(replicates):
        sampled_groups = [randomizer.choice(group_names) for _ in group_names]
        indexes = [index for group in sampled_groups for index in members_by_group[group]]
        sampled_labels = [labels[index] for index in indexes]
        sampled_scores = [scores[index] for index in indexes]
        if len(set(sampled_labels)) == 2:
            values["auroc"].append(float(roc_auc_score(sampled_labels, sampled_scores)))
            values["auprc"].append(float(average_precision_score(sampled_labels, sampled_scores)))
        values["brier_score"].append(float(brier_score_loss(sampled_labels, sampled_scores)))
        values["expected_calibration_error"].append(expected_calibration_error(sampled_labels, sampled_scores))
    return {metric: percentile_interval(intervals) for metric, intervals in values.items()}


def evaluate_external_cohort(args):
    cohort_sha256 = sha256_file(args.cohort)
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    attestation = validate_attestation(manifest, cohort_sha256)

    report = json.loads(args.model_report.read_text(encoding="utf-8"))
    vocabulary = json.loads(args.vocabulary.read_text(encoding="utf-8"))
    bundle = load(args.model)
    if bundle.get("version") != report.get("model_version"):
        raise ValueError("Model artifact and model report versions do not match.")
    if vocabulary.get("model_version") != report.get("model_version"):
        raise ValueError("Feature vocabulary and model report versions do not match.")
    threshold = report.get("validation", {}).get("threshold")
    if not isinstance(threshold, (int, float)):
        raise ValueError("Model report does not contain a validation-selected threshold.")

    known_training_genomes = training_genomes(args.training_input)
    seen_measurements = set()
    class_labels = list(bundle["model"].classes_)
    if 1 not in class_labels:
        raise ValueError("Model artifact does not contain a resistant class.")
    labels = []
    scores = []
    lab_ids = []
    observed_lab_ids = set()
    isolate_ids = set()
    genome_ids = set()
    pair_records = defaultdict(lambda: ([], [], []))
    lab_records = defaultdict(lambda: ([], []))
    overlap_genomes = set()
    excluded_oov_records = 0
    oov_organisms = set()
    oov_antibiotics = set()
    oov_products = set()
    vocabulary_organisms = set(vocabulary.get("organisms", []))
    vocabulary_antibiotics = set(vocabulary.get("antibiotics", []))
    vocabulary_products = set(vocabulary.get("products", []))
    scanned = 0

    for record in read_jsonl(args.cohort):
        scanned += 1
        if not isinstance(record, dict):
            raise ValueError(f"External record {scanned} must be a JSON object.")
        missing = REQUIRED_COHORT_FIELDS - record.keys()
        if missing:
            raise ValueError(f"External record {scanned} is missing fields: {', '.join(sorted(missing))}")
        if record["evidence_class"] != "laboratory" or record["label"] not in {"resistant", "susceptible"}:
            raise ValueError(f"External record {scanned} is not a measured laboratory R/S observation.")
        if not isinstance(record["products"], list) or not all(isinstance(product, str) for product in record["products"]):
            raise ValueError(f"External record {scanned} products must be a list of strings.")

        measurement_id = str(record["measurement_id"] or "").strip()
        isolate_id = str(record["isolate_id"] or "").strip()
        genome_id = str(record["genome_id"] or "").strip()
        laboratory_id = str(record["laboratory_id"] or "").strip()
        organism = re.sub(r"\s+", " ", str(record["organism"] or "").strip().lower())
        antibiotic = re.sub(r"\s+", " ", str(record["antibiotic"] or "").strip().lower())
        if not all((measurement_id, isolate_id, genome_id, laboratory_id, organism, antibiotic, str(record["testing_method"] or "").strip())):
            raise ValueError(f"External record {scanned} has an empty required identifier or test field.")
        if measurement_id in seen_measurements:
            raise ValueError(f"Duplicate measurement_id in external cohort: {measurement_id}")
        seen_measurements.add(measurement_id)
        if genome_id in known_training_genomes:
            overlap_genomes.add(genome_id)
        observed_lab_ids.add(laboratory_id)

        products = sorted({re.sub(r"\s+", " ", product.strip().lower()) for product in record["products"] if product.strip()})
        organism_oov = organism not in vocabulary_organisms
        antibiotic_oov = antibiotic not in vocabulary_antibiotics
        product_oov = set(products) - vocabulary_products
        if organism_oov or antibiotic_oov or product_oov:
            excluded_oov_records += 1
            if organism_oov:
                oov_organisms.add(organism)
            if antibiotic_oov:
                oov_antibiotics.add(antibiotic)
            oov_products.update(product_oov)
            continue
        row = {"organism": organism, "antibiotic": antibiotic, "products": products}
        score = float(bundle["model"].predict_proba(bundle["hasher"].transform([feature_dict(row)]))[0][class_labels.index(1)])
        label = int(record["label"] == "resistant")
        labels.append(label)
        scores.append(score)
        lab_ids.append(laboratory_id)
        isolate_ids.add(isolate_id)
        genome_ids.add(genome_id)
        pair = pair_records[(organism, antibiotic)]
        pair[0].append(label)
        pair[1].append(score)
        pair[2].append(laboratory_id)
        lab_records[laboratory_id][0].append(label)
        lab_records[laboratory_id][1].append(score)

    if overlap_genomes:
        preview = ", ".join(sorted(overlap_genomes)[:5])
        raise ValueError(f"External cohort overlaps {len(overlap_genomes)} train/validation genomes (examples: {preview}).")
    if len(set(lab_ids)) < 2:
        raise ValueError("At least two independently identified physical testing facilities are required.")
    if not labels or len(set(labels)) < 2:
        raise ValueError("External cohort must contain both resistant and susceptible observations.")

    aggregate = evaluate_predictions(labels, scores, threshold)
    aggregate["laboratory_cluster_bootstrap_confidence_intervals_95"] = group_bootstrap_intervals(labels, scores, lab_ids)
    by_pair = {}
    for (organism, antibiotic), (pair_labels, pair_scores, pair_labs) in sorted(pair_records.items()):
        metrics = evaluate_predictions(pair_labels, pair_scores, threshold)
        matrix = metrics["confusion_matrix"]
        metrics["sensitivity_specificity_wilson_intervals_95"] = {
            "sensitivity": wilson_interval(
                matrix["true_positive"],
                matrix["true_positive"] + matrix["false_negative"],
            ),
            "specificity": wilson_interval(
                matrix["true_negative"],
                matrix["true_negative"] + matrix["false_positive"],
            ),
        }
        metrics["laboratories"] = len(set(pair_labs))
        metrics["laboratory_cluster_bootstrap_confidence_intervals_95"] = group_bootstrap_intervals(
            pair_labels,
            pair_scores,
            pair_labs,
            seed=int.from_bytes(hashlib.sha256(f"{organism}\0{antibiotic}".encode()).digest()[:4], "big"),
        )
        by_pair.setdefault(organism, {})[antibiotic] = metrics

    by_laboratory = {
        laboratory: evaluate_predictions(lab_labels, lab_scores, threshold)
        for laboratory, (lab_labels, lab_scores) in sorted(lab_records.items())
    }
    result = {
        "evaluation_type": "locked external measured-AST cohort; facilities held out from model development by provenance attestation",
        "dataset_name": manifest["dataset_name"],
        "source_url": manifest["source_url"],
        "cohort_sha256": cohort_sha256,
        "model_version": report["model_version"],
        "model_sha256": sha256_file(args.model),
        "threshold_source": "existing validation split; not retuned on external cohort",
        "threshold": threshold,
        "attestation": attestation,
        "cohort_audit": {
            "records": scanned,
            "records_scored": len(labels),
            "records_excluded_out_of_vocabulary": excluded_oov_records,
            "unique_measurements": len(seen_measurements),
            "unique_isolates": len(isolate_ids),
            "unique_genomes": len(genome_ids),
            "physical_laboratories_observed": len(observed_lab_ids),
            "physical_laboratories_scored": len(set(lab_ids)),
            "out_of_vocabulary": {
                "organisms": sorted(oov_organisms),
                "antibiotics": sorted(oov_antibiotics),
                "products": sorted(oov_products),
            },
            "train_or_validation_genome_overlap": 0,
            "genome_overlap_scope": "Exact genome_id matching only; aliases and unlinked biological duplicates require source-specific crosswalks.",
        },
        "aggregate": aggregate,
        "by_laboratory": by_laboratory,
        "by_organism_antibiotic": by_pair,
        "limitations": [
            "The manifest's facility, isolate, independence, and rights claims require human verification against the cited source documentation.",
            "Cluster bootstrap resamples physical laboratories; intervals are unavailable for one-laboratory organism/antibiotic pairs.",
            "Cluster-bootstrap intervals can be unstable when only a small number of physical laboratories are available.",
            "Pairs with sparse support remain descriptive and do not establish clinical utility.",
            "Scores remain uncalibrated; the validation-selected threshold is not a treatment cutoff.",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "cohort_audit": result["cohort_audit"], "aggregate": aggregate}, indent=2))


def build_parser():
    parser = argparse.ArgumentParser(description="Evaluate the locked AMR model on an independently attested measured-AST cohort.")
    parser.add_argument("--cohort", type=Path, required=True, help="Canonical JSONL external records; see IMPLEMENTATION_PLAN.md for the schema.")
    parser.add_argument("--manifest", type=Path, required=True, help="Provenance and independence attestation JSON.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", type=Path, default=DEFAULT_AMR_MODEL)
    parser.add_argument("--model-report", type=Path, default=DEFAULT_AMR_REPORT)
    parser.add_argument("--vocabulary", type=Path, default=ROOT / "data/models/amr_feature_vocabulary.json")
    parser.add_argument("--training-input", type=Path, default=DEFAULT_AMR_INPUT)
    return parser


if __name__ == "__main__":
    evaluate_external_cohort(build_parser().parse_args())