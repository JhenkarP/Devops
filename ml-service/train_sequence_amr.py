"""Train antibiotic-specific AMR models from sequence-derived determinants and measured AST.

This is intentionally separate from the BV-BRC product-feature baseline. It requires
linked genome IDs, sequence-caller features, and laboratory R/S labels in the input.
"""

import argparse
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

from joblib import dump
from sklearn.feature_extraction import FeatureHasher
from sklearn.calibration import CalibratedClassifierCV
from sklearn.linear_model import SGDClassifier
from sklearn.metrics import average_precision_score, balanced_accuracy_score, f1_score, roc_auc_score


def read_jsonl(path):
    with Path(path).open(encoding="utf-8") as source:
        for line in source:
            if line.strip():
                yield json.loads(line)


def genome_split(genome_id):
    value = int.from_bytes(hashlib.sha256(str(genome_id).encode()).digest()[:4], "big") % 10
    return "train" if value < 7 else "validation" if value == 7 else "test"


def normalize_record(record):
    label = str(record.get("label", "")).strip().upper()
    if label in {"RESISTANT", "R"}:
        label = 1
    elif label in {"SUSCEPTIBLE", "S"}:
        label = 0
    else:
        return None
    genome_id = str(record.get("genome_id", "")).strip()
    organism = str(record.get("organism", "")).strip().lower()
    antibiotic = str(record.get("antibiotic", "")).strip().lower()
    ast = record.get("ast") or {}
    provenance = record.get("feature_provenance") or {}
    required_ast = ("measurement", "measurement_unit", "testing_method", "testing_standard", "isolate_id", "laboratory_id")
    required_provenance = ("fasta_sha256", "caller_name", "caller_version", "database_version", "feature_manifest_sha256")
    if not genome_id or not organism or not antibiotic or record.get("evidence_class") != "laboratory":
        return None
    if any(ast.get(key) in (None, "") for key in required_ast):
        return None
    if any(provenance.get(key) in (None, "") for key in required_provenance):
        return None
    determinants = []
    for feature in record.get("features", []):
        if isinstance(feature, str) and feature.strip():
            determinants.append(("unknown", feature.strip().lower()))
        elif isinstance(feature, dict) and feature.get("determinant"):
            determinants.append((str(feature.get("type") or "unknown").lower(), str(feature["determinant"]).strip().lower()))
    return {
        "genome_id": genome_id,
        "organism": organism,
        "antibiotic": antibiotic,
        "label": label,
        "isolate_id": str(ast["isolate_id"]),
        "laboratory_id": str(ast["laboratory_id"]),
        "features": sorted(set(determinants)),
        "split": genome_split(genome_id),
        "feature_provenance": provenance,
    }


def feature_dict(record):
    values = {f"organism={record['organism']}": 1.0, "has_sequence_features": float(bool(record["features"]))}
    for kind, determinant in record["features"]:
        values[f"sequence_{kind}={determinant}"] = 1.0
    return values


def metrics(labels, scores, threshold=0.5):
    if len(set(labels)) < 2:
        return {"records": len(labels), "auroc": None, "auprc": None, "f1": None, "balanced_accuracy": None, "status": "insufficient_test_classes"}
    predictions = [int(score >= threshold) for score in scores]
    return {
        "records": len(labels),
        "auroc": float(roc_auc_score(labels, scores)),
        "auprc": float(average_precision_score(labels, scores)),
        "f1": float(f1_score(labels, predictions)),
        "balanced_accuracy": float(balanced_accuracy_score(labels, predictions)),
        "status": "evaluated",
    }


def metrics_by_laboratory(rows, scores, threshold):
    grouped = defaultdict(lambda: ([], []))
    for row, score in zip(rows, scores):
        grouped[row["laboratory_id"]][0].append(row["label"])
        grouped[row["laboratory_id"]][1].append(score)
    return {
        laboratory_id: metrics(labels, laboratory_scores, threshold)
        for laboratory_id, (labels, laboratory_scores) in sorted(grouped.items())
    }


def select_threshold(labels, scores):
    candidates = sorted({0.0, 0.5, 1.0, *[float(score) for score in scores]})
    best = (0.5, -1.0)
    for threshold in candidates:
        predictions = [int(score >= threshold) for score in scores]
        value = balanced_accuracy_score(labels, predictions) if len(set(labels)) == 2 else -1.0
        if value > best[1] or (value == best[1] and abs(threshold - 0.5) < abs(best[0] - 0.5)):
            best = (threshold, value)
    return best[0]


def train(input_path, model_path, report_path, organism=None, calibrate=False):
    records = []
    rejected = Counter()
    for raw in read_jsonl(input_path):
        item = normalize_record(raw)
        if item is None:
            rejected["invalid_or_non_laboratory_record"] += 1
            continue
        if organism and item["organism"] != organism.lower():
            rejected["organism_out_of_scope"] += 1
            continue
        records.append(item)
    if not records:
        raise RuntimeError("No eligible sequence-feature records with measured R/S labels were found.")

    by_antibiotic = defaultdict(list)
    for record in records:
        by_antibiotic[record["antibiotic"]].append(record)
    models = {}
    report_pairs = {}
    hasher = FeatureHasher(n_features=2**18, input_type="dict", alternate_sign=False)
    for antibiotic, rows in sorted(by_antibiotic.items()):
        train_rows = [row for row in rows if row["split"] == "train"]
        validation_rows = [row for row in rows if row["split"] == "validation"]
        test_rows = [row for row in rows if row["split"] == "test"]
        if len({row["label"] for row in train_rows}) < 2:
            report_pairs[antibiotic] = {"status": "blocked_train_missing_class", "records": len(rows)}
            continue
        if len({row["label"] for row in validation_rows}) < 2:
            report_pairs[antibiotic] = {"status": "blocked_validation_missing_class", "records": len(rows)}
            continue
        if len({row["label"] for row in test_rows}) < 2:
            report_pairs[antibiotic] = {"status": "blocked_test_missing_class", "records": len(rows)}
            continue
        classifier = SGDClassifier(loss="log_loss", random_state=42, max_iter=1000, tol=1e-3)
        train_matrix = hasher.transform([feature_dict(row) for row in train_rows])
        validation_matrix = hasher.transform([feature_dict(row) for row in validation_rows])
        classifier.fit(train_matrix, [row["label"] for row in train_rows])
        if calibrate:
            calibrated = CalibratedClassifierCV(classifier, method="sigmoid", cv="prefit")
            calibrated.fit(validation_matrix, [row["label"] for row in validation_rows])
            classifier = calibrated
        validation_scores = classifier.predict_proba(validation_matrix)[:, list(classifier.classes_).index(1)]
        threshold = select_threshold([row["label"] for row in validation_rows], validation_scores)
        scores = classifier.predict_proba(hasher.transform([feature_dict(row) for row in test_rows]))[:, list(classifier.classes_).index(1)]
        report_pairs[antibiotic] = {
            "status": "trained",
            "train_records": len(train_rows),
            "validation_records": len(validation_rows),
            "test_records": len(test_rows),
            "test_laboratories": len({row["laboratory_id"] for row in test_rows}),
            "decision_threshold": threshold,
            "validation": metrics([row["label"] for row in validation_rows], validation_scores, threshold),
            "test": metrics([row["label"] for row in test_rows], scores, threshold),
            "test_by_laboratory": metrics_by_laboratory(test_rows, scores, threshold),
            "calibration_status": "calibrated" if calibrate else "not_calibrated",
        }
        models[antibiotic] = classifier

    if not models:
        raise RuntimeError("No antibiotic had both R and S records in the genome-disjoint training split.")
    thresholds = {antibiotic: report_pairs[antibiotic]["decision_threshold"] for antibiotic in models}
    artifact = {"model_type": "sequence_determinant_amr_sgd", "feature_schema": "amr-sequence-contract-1", "hasher_features": 2**18, "organism": organism.lower() if organism else None, "decision_thresholds": thresholds, "calibration_status": "calibrated" if calibrate else "not_calibrated", "calibration_method": "sigmoid_on_validation_split" if calibrate else None, "models": models}
    model_path = Path(model_path)
    report_path = Path(report_path)
    model_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    dump(artifact, model_path)
    report = {"model_type": artifact["model_type"], "input": str(input_path), "organism": artifact["organism"], "records": len(records), "genomes": len({row["genome_id"] for row in records}), "split": "deterministic genome-disjoint SHA-256 split (70/10/20)", "rejected": dict(rejected), "pairs": report_pairs, "calibration_status": artifact["calibration_status"], "limitations": ["Requires measured laboratory R/S labels linked to the same genome.", "Calibration uses the validation split and must be externally checked.", "This artifact does not establish clinical utility or treatment suitability."]}
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="JSONL with genome_id, organism, antibiotic, label, evidence_class, and features")
    parser.add_argument("--model", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--organism")
    parser.add_argument("--calibrate", action="store_true", help="Fit sigmoid calibration on each antibiotic validation split.")
    args = parser.parse_args()
    report = train(args.input, args.model, args.report, args.organism, args.calibrate)
    print(json.dumps({"records": report["records"], "genomes": report["genomes"], "pairs": len(report["pairs"])}, indent=2))


if __name__ == "__main__":
    main()
