import argparse
import hashlib
import json
import math
import random
import re
from collections import Counter, defaultdict
from functools import lru_cache
from pathlib import Path

from joblib import dump
from sklearn.feature_extraction import FeatureHasher
from sklearn.linear_model import SGDClassifier
from sklearn.metrics import (
    average_precision_score,
    balanced_accuracy_score,
    brier_score_loss,
    confusion_matrix,
    f1_score,
    roc_auc_score,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_AMR_INPUT = ROOT / "data/amr_2m/processed/bvbrc_amr_2000000_enriched.jsonl"
DEFAULT_AMR_COHORT = ROOT / "data/amr_2m/processed/amr_baseline_cohort.jsonl"
DEFAULT_AMR_MODEL = ROOT / "data/models/amr_feature_baseline.joblib"
DEFAULT_AMR_REPORT = ROOT / "data/models/amr_feature_baseline_metrics.json"
DEFAULT_DISEASE_PROFILES = ROOT / "data/rare_disease/processed/rare_disease_profiles.json"
DEFAULT_HPO_GRAPH = ROOT / "data/rare_disease/processed/hpo_graph.json"
DEFAULT_HPO_INDEX = ROOT / "data/rare_disease/processed/hpo_term_index.json"


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def read_jsonl(path):
    with path.open(encoding="utf-8") as source:
        for line in source:
            if line.strip():
                yield json.loads(line)


def genome_fold(genome_id):
    digest = hashlib.sha256(str(genome_id).encode("utf-8")).digest()
    fold = int.from_bytes(digest[:4], "big") % 10
    return "train" if fold < 7 else "validation" if fold == 7 else "test"


def assign_split(record, split_by, lab_test_group=None, lab_validation_group=None):
    if split_by == "genome":
        return genome_fold(record.get("genome_id")) if record.get("genome_id") else None
    if split_by == "temporal":
        year = record.get("collection_year")
        if not year:
            return None
        year = int(year)
        return "test" if year >= 2019 else "validation" if year >= 2017 else "train"
    if split_by == "laboratory":
        group = record.get("laboratory") or record.get("owner")
        if not group:
            return None
        if group == lab_test_group:
            return "test"
        if group == lab_validation_group:
            return "validation"
        return "train"
    split = record.get("split") or {}
    value = split.get(split_by)
    return value if value in {"train", "validation", "test"} else None


def prepare_amr_cohort(input_path, output_path, split_by, max_labeled, lab_test_group=None, lab_validation_group=None):
    scanned = 0
    eligible = 0
    skipped_splits = 0
    split_counts = Counter()
    label_counts = Counter()
    feature_counts = Counter()
    seen_records = set()
    source_record_splits = defaultdict(set)
    source_group_splits = defaultdict(set)
    submitter_group_splits = defaultdict(set)
    duplicates_removed = 0

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="\n") as output:
        for record in read_jsonl(input_path):
            scanned += 1
            if scanned % 100000 == 0:
                print(f"Scanned {scanned:,} enriched AMR rows; selected {eligible:,} eligible lab rows", flush=True)
            if record.get("evidence_class") != "laboratory":
                continue
            label = record.get("label")
            if label not in {"resistant", "susceptible"}:
                continue
            split = assign_split(record, split_by, lab_test_group, lab_validation_group)
            if split is None:
                skipped_splits += 1
                continue

            deduplication_key = (
                record.get("genome_id"),
                record.get("antibiotic"),
                record.get("evidence_class"),
                record.get("testing_method"),
                record.get("testing_standard"),
                record.get("testing_standard_year"),
                label,
                record.get("measurement"),
                record.get("measurement_unit"),
                record.get("measurement_sign"),
                record.get("collection_year"),
            )
            if deduplication_key in seen_records:
                duplicates_removed += 1
                continue
            seen_records.add(deduplication_key)

            for value, memberships in (
                (record.get("source_id"), source_record_splits),
                (record.get("source"), source_group_splits),
                (record.get("laboratory") or record.get("owner"), submitter_group_splits),
            ):
                if value:
                    memberships[str(value)].add(split)

            products = sorted({
                re.sub(r"\s+", " ", str(feature.get("product") or "").strip().lower())
                for feature in record.get("resistance_feature_calls", [])
                if feature.get("product") and str(feature.get("product")).strip()
            })
            item = {
                "label": 1 if label == "resistant" else 0,
                "split": split,
                "antibiotic": str(record.get("antibiotic") or "unknown").strip().lower(),
                "organism": str(record.get("organism") or "unknown").strip().lower(),
                "products": products,
            }
            output.write(json.dumps(item, separators=(",", ":")) + "\n")
            eligible += 1
            split_counts[split] += 1
            label_counts[label] += 1
            feature_counts["with_features" if products else "without_features"] += 1
            if max_labeled and eligible >= max_labeled:
                break

    return {
        "input_records_scanned": scanned,
        "eligible_lab_records": eligible,
        "duplicate_records_removed": duplicates_removed,
        "records_skipped_for_split": skipped_splits,
        "split_counts": dict(split_counts),
        "label_counts": dict(label_counts),
        "feature_availability": dict(feature_counts),
        "split_by": split_by,
        "source_overlap_audit": {
            "source_record_ids_observed": len(source_record_splits),
            "source_record_ids_in_multiple_splits": sum(len(splits) > 1 for splits in source_record_splits.values()),
            "source_groups_observed": len(source_group_splits),
            "source_groups_in_multiple_splits": sum(len(splits) > 1 for splits in source_group_splits.values()),
            "submitter_groups_observed": len(submitter_group_splits),
            "submitter_groups_in_multiple_splits": sum(len(splits) > 1 for splits in submitter_group_splits.values()),
            "physical_laboratory_identifiers_verified": False,
            "interpretation": "Source IDs identify records; source grouping is unavailable when the source field is absent. Laboratory/owner values are submitter metadata, not verified physical facilities.",
        },
        "laboratory_group_policy": {
            "test_group": lab_test_group,
            "validation_group": lab_validation_group,
            "interpretation": "Submitter/owner metadata group holdout; source metadata does not verify these groups as physical laboratories.",
        } if split_by == "laboratory" else None,
        "label_policy": "Laboratory evidence only; resistant and susceptible labels only. Intermediate, nonsusceptible, unknown, and computational records are excluded.",
        "features": ["antibiotic", "organism", "resistance-associated product names"],
        "excluded_identifiers": ["genome_id", "source_id", "laboratory", "collection_year"],
    }


def feature_dict(record):
    features = {
        f"antibiotic={record['antibiotic']}": 1.0,
        f"organism={record['organism']}": 1.0,
        "has_resistance_feature_calls": 1.0 if record["products"] else 0.0,
    }
    for product in record["products"]:
        features[f"resistance_product={product}"] = 1.0
    return features


def batches_for_split(path, split, batch_size=1024):
    batch = []
    for record in read_jsonl(path):
        if record["split"] != split:
            continue
        batch.append(record)
        if len(batch) >= batch_size:
            yield batch
            batch = []
    if batch:
        yield batch


def rows_to_matrix(hasher, records):
    return hasher.transform([feature_dict(record) for record in records])


def expected_calibration_error(labels, probabilities, bins=10):
    if not labels:
        return None
    total = len(labels)
    error = 0.0
    for index in range(bins):
        lower = index / bins
        upper = (index + 1) / bins
        members = [
            position for position, probability in enumerate(probabilities)
            if lower <= probability < upper or (index == bins - 1 and probability == 1.0)
        ]
        if not members:
            continue
        confidence = sum(probabilities[position] for position in members) / len(members)
        accuracy = sum(labels[position] for position in members) / len(members)
        error += len(members) / total * abs(confidence - accuracy)
    return error


def evaluate_predictions(labels, probabilities, threshold):
    if not labels:
        return {"records": 0}
    predictions = [int(value >= threshold) for value in probabilities]
    tn, fp, fn, tp = confusion_matrix(labels, predictions, labels=[0, 1]).ravel().tolist()
    return {
        "records": len(labels),
        "resistant_records": sum(labels),
        "susceptible_records": len(labels) - sum(labels),
        "threshold": threshold,
        "auroc": float(roc_auc_score(labels, probabilities)) if len(set(labels)) == 2 else None,
        "auprc": float(average_precision_score(labels, probabilities)) if len(set(labels)) == 2 else None,
        "f1": float(f1_score(labels, predictions, zero_division=0)),
        "sensitivity": float(tp / (tp + fn)) if tp + fn else None,
        "specificity": float(tn / (tn + fp)) if tn + fp else None,
        "balanced_accuracy": float(balanced_accuracy_score(labels, predictions)) if len(set(labels)) == 2 else None,
        "brier_score": float(brier_score_loss(labels, probabilities)),
        "expected_calibration_error": expected_calibration_error(labels, probabilities),
        "confusion_matrix": {"true_negative": tn, "false_positive": fp, "false_negative": fn, "true_positive": tp},
    }


def percentile_interval(values, lower_probability=0.025, upper_probability=0.975):
    if not values:
        return None
    ordered = sorted(values)

    def percentile(probability):
        position = probability * (len(ordered) - 1)
        lower_index = math.floor(position)
        upper_index = math.ceil(position)
        fraction = position - lower_index
        return ordered[lower_index] * (1 - fraction) + ordered[upper_index] * fraction

    lower_bound = float(percentile(lower_probability))
    upper_bound = float(percentile(upper_probability))
    return [min(lower_bound, upper_bound), max(lower_bound, upper_bound)]


def bootstrap_confidence_intervals(labels, probabilities, seed=0, replicates=500, stratified=False):
    interval_values = {"auroc": [], "auprc": [], "brier_score": [], "expected_calibration_error": []}
    if not labels:
        return {metric: None for metric in interval_values}

    randomizer = random.Random(seed)
    if stratified:
        negative_scores = [score for label, score in zip(labels, probabilities) if label == 0]
        positive_scores = [score for label, score in zip(labels, probabilities) if label == 1]
        if not negative_scores or not positive_scores:
            return {metric: None for metric in interval_values}
    else:
        negative_scores = positive_scores = None

    for _ in range(replicates):
        if stratified:
            sample_labels = [0] * len(negative_scores) + [1] * len(positive_scores)
            sample_scores = (
                [randomizer.choice(negative_scores) for _ in negative_scores]
                + [randomizer.choice(positive_scores) for _ in positive_scores]
            )
        else:
            indexes = [randomizer.randrange(len(labels)) for _ in labels]
            sample_labels = [labels[index] for index in indexes]
            sample_scores = [probabilities[index] for index in indexes]

        if len(set(sample_labels)) == 2:
            interval_values["auroc"].append(float(roc_auc_score(sample_labels, sample_scores)))
            interval_values["auprc"].append(float(average_precision_score(sample_labels, sample_scores)))
        interval_values["brier_score"].append(float(brier_score_loss(sample_labels, sample_scores)))
        interval_values["expected_calibration_error"].append(expected_calibration_error(sample_labels, sample_scores))

    return {metric: percentile_interval(values) for metric, values in interval_values.items()}


def wilson_interval(successes, total, z=1.96):
    if total == 0:
        return None
    proportion = successes / total
    denominator = 1 + z * z / total
    center = (proportion + z * z / (2 * total)) / denominator
    margin = z * math.sqrt(proportion * (1 - proportion) / total + z * z / (4 * total * total)) / denominator
    return [max(0.0, center - margin), min(1.0, center + margin)]


def evaluate_subgroup_predictions(labels, probabilities, threshold, seed=0):
    metrics = evaluate_predictions(labels, probabilities, threshold)
    matrix = metrics["confusion_matrix"]
    metrics["confidence_intervals_95"] = {
        "auroc": None,
        "auprc": None,
        "sensitivity": wilson_interval(matrix["true_positive"], matrix["true_positive"] + matrix["false_negative"]),
        "specificity": wilson_interval(matrix["true_negative"], matrix["true_negative"] + matrix["false_positive"]),
        "brier_score": None,
        "expected_calibration_error": None,
    }
    metrics["support_status"] = (
        "insufficient_support"
        if metrics["records"] < 30 or min(metrics["resistant_records"], metrics["susceptible_records"]) < 10
        else "descriptive_only"
    )
    if metrics["support_status"] == "descriptive_only":
        metrics["confidence_intervals_95"].update(
            bootstrap_confidence_intervals(labels, probabilities, seed=seed, stratified=True),
        )
    return metrics


def predict_split(model, hasher, cohort_path, split):
    labels = []
    probabilities = []
    antibiotics = []
    organisms = []
    for records in batches_for_split(cohort_path, split):
        matrix = rows_to_matrix(hasher, records)
        batch_probabilities = model.predict_proba(matrix)[:, 1].tolist()
        labels.extend(record["label"] for record in records)
        probabilities.extend(batch_probabilities)
        antibiotics.extend(record["antibiotic"] for record in records)
        organisms.extend(record["organism"] for record in records)
    return labels, probabilities, antibiotics, organisms


def select_threshold(labels, probabilities):
    if not labels or len(set(labels)) < 2:
        return 0.5
    candidates = [step / 100 for step in range(10, 91, 5)]
    return max(
        candidates,
        key=lambda threshold: (
            balanced_accuracy_score(labels, [int(score >= threshold) for score in probabilities]),
            -abs(threshold - 0.5),
        ),
    )


def train_amr(args):
    cohort_path = args.cohort
    cohort_summary = prepare_amr_cohort(
        args.input,
        cohort_path,
        args.split_by,
        args.max_labeled,
        args.lab_test_group,
        args.lab_validation_group,
    )
    if cohort_summary["split_counts"].get("train", 0) == 0:
        raise ValueError("No eligible training records. Check input evidence labels and split selection.")

    hasher = FeatureHasher(n_features=args.hash_features, input_type="dict", alternate_sign=False)
    model = SGDClassifier(loss="log_loss", alpha=args.alpha, random_state=args.seed, average=True)
    classes = [0, 1]
    for records in batches_for_split(cohort_path, "train"):
        model.partial_fit(rows_to_matrix(hasher, records), [record["label"] for record in records], classes=classes)

    validation_labels, validation_scores, _, _ = predict_split(model, hasher, cohort_path, "validation")
    threshold = select_threshold(validation_labels, validation_scores)
    test_labels, test_scores, antibiotics, organisms = predict_split(model, hasher, cohort_path, "test")
    test_metrics = evaluate_predictions(test_labels, test_scores, threshold)
    test_metrics["bootstrap_confidence_intervals_95"] = bootstrap_confidence_intervals(
        test_labels,
        test_scores,
        seed=args.seed,
    )

    by_antibiotic = defaultdict(lambda: ([], []))
    by_organism_antibiotic = defaultdict(lambda: ([], []))
    for organism, antibiotic, label, probability in zip(organisms, antibiotics, test_labels, test_scores):
        by_antibiotic[antibiotic][0].append(label)
        by_antibiotic[antibiotic][1].append(probability)
        by_organism_antibiotic[(organism, antibiotic)][0].append(label)
        by_organism_antibiotic[(organism, antibiotic)][1].append(probability)
    test_metrics["by_antibiotic"] = {
        antibiotic: evaluate_predictions(labels, scores, threshold)
        for antibiotic, (labels, scores) in sorted(by_antibiotic.items())
    }
    pair_metrics = {}
    for (organism, antibiotic), (labels, scores) in sorted(by_organism_antibiotic.items()):
        pair_seed = int.from_bytes(hashlib.sha256(f"{organism}\0{antibiotic}".encode("utf-8")).digest()[:4], "big")
        pair_metrics.setdefault(organism, {})[antibiotic] = evaluate_subgroup_predictions(
            labels,
            scores,
            threshold,
            seed=pair_seed,
        )
    test_metrics["by_organism_antibiotic"] = pair_metrics
    model_path = args.model
    model_path.parent.mkdir(parents=True, exist_ok=True)
    dump({"model": model, "hasher": hasher, "version": "amr-sgd-feature-baseline-1"}, model_path)

    report = {
        "model_version": "amr-sgd-feature-baseline-1",
        "input": str(args.input),
        "cohort": str(cohort_path),
        "model_artifact": str(model_path),
        "cohort_summary": cohort_summary,
        "validation": evaluate_predictions(validation_labels, validation_scores, threshold),
        "test": test_metrics,
        "subgroup_evaluation": {
            "threshold_source": "global validation balanced-accuracy selection; no subgroup thresholds were tuned",
            "interval_method": "95% Wilson score intervals for sensitivity/specificity; deterministic stratified percentile bootstrap intervals (500 replicates) for AUROC, AUPRC, Brier score, and ECE when support is adequate",
            "aggregate_interval_method": "95% non-stratified percentile bootstrap intervals (500 replicates) for test AUROC, AUPRC, Brier score, and ECE",
            "minimum_support": {"records": 30, "records_per_class": 10},
            "minimum_support_is_clinical_acceptance_rule": False,
            "support_status_interpretation": {
                "insufficient_support": "Below the minimum support rule; metrics are unstable and descriptive only.",
                "descriptive_only": "Meets an exploratory reporting floor only; this is not evidence of clinical utility or reliable organism/drug-level performance.",
            },
            "source_overlap_limitation": "The genome-disjoint split prevents genome ID overlap. The source-overlap audit counts record-ID and available source/submitter groups, but source IDs identify records and submitter metadata does not establish source/isolate or physical-laboratory independence.",
        },
        "evaluation_warnings": ["No records were assigned to the held-out test split; test metrics are unavailable."] if not test_labels else [],
        "threshold_selected_on": "validation balanced accuracy",
        "limitations": [
            "Research baseline only; not for treatment decisions.",
            "Only laboratory-evidence resistant/susceptible labels are used; other labels and computational predictions are excluded.",
            "Features intentionally exclude genome IDs, source IDs, laboratory, and collection year.",
            "The genome split hashes genome IDs deterministically; the laboratory split holds out explicit owner metadata groups, the temporal split uses year cutoffs (train through 2016, validation 2017-2018, test 2019 onward), and geography uses precomputed assignments.",
            "A record without resistance-associated product calls remains in the cohort with a no-feature indicator.",
        ],
    }
    write_json(args.report, report)
    print(json.dumps({"model": report["model_version"], "cohort": cohort_summary, "test": {key: value for key, value in test_metrics.items() if key != "by_antibiotic"}}, indent=2))


def load_disease_resources(args):
    profiles = json.loads(args.profiles.read_text(encoding="utf-8"))
    graph = json.loads(args.graph.read_text(encoding="utf-8"))
    term_index = json.loads(args.term_index.read_text(encoding="utf-8"))
    parents = defaultdict(set)
    for edge in graph.get("edges", []):
        parents[edge["child"]].add(edge["parent"])
    names = {term["id"]: term.get("name") for term in term_index}
    return profiles, parents, names


def make_ancestor_lookup(parents):
    cache = {}

    def ancestors(term):
        if term in cache:
            return cache[term]
        found = {term}
        queue = [term]
        while queue:
            current = queue.pop()
            for parent in parents.get(current, ()):
                if parent not in found:
                    found.add(parent)
                    queue.append(parent)
        cache[term] = found
        return found

    return ancestors


def build_information_content(profiles, ancestors):
    counts = Counter()
    for profile in profiles:
        disease_terms = set()
        for item in profile.get("present", []):
            disease_terms.update(ancestors(item["hpo_id"]))
        counts.update(disease_terms)
    disease_count = max(len(profiles), 1)
    return {term: -math.log((count + 1) / (disease_count + 1)) for term, count in counts.items()}


def make_similarity_lookup(ancestors, information_content, max_ic):
    @lru_cache(maxsize=500000)
    def similarity(left, right):
        if right < left:
            left, right = right, left
        common = ancestors(left).intersection(ancestors(right))
        return max((information_content.get(term, 0.0) for term in common), default=0.0) / max_ic

    return similarity


def score_disease(input_terms, profile, similarity, names, include_supporting_terms=True):
    present = profile.get("present", [])
    absent = profile.get("absent", [])
    supporting = []
    present_total = 0.0
    absent_total = 0.0
    for input_term in input_terms:
        best = (0.0, None)
        for item in present:
            term_similarity = similarity(input_term, item["hpo_id"])
            if term_similarity > best[0]:
                best = (term_similarity, item["hpo_id"])
        present_total += best[0]
        if include_supporting_terms and best[1]:
            supporting.append({
                "input_hpo_id": input_term,
                "input_term": names.get(input_term),
                "matched_disease_hpo_id": best[1],
                "matched_disease_term": names.get(best[1]),
                "similarity": best[0],
            })
        absent_total += max((similarity(input_term, item["hpo_id"]) for item in absent), default=0.0)
    positive = present_total / max(len(input_terms), 1)
    contradiction = absent_total / max(len(input_terms), 1)
    return max(0.0, positive - 0.5 * contradiction), supporting, contradiction


def rank_diseases(input_terms, profiles, ancestors, information_content, names, top_k):
    max_ic = max(information_content.values(), default=1.0) or 1.0
    similarity = make_similarity_lookup(ancestors, information_content, max_ic)
    ranked = []
    for profile in profiles:
        score, supporting, contradiction = score_disease(input_terms, profile, similarity, names)
        ranked.append({
            "disease_id": profile.get("disease_id"),
            "disease_name": profile.get("disease_name"),
            "score": score,
            "supporting_terms": supporting,
            "contradiction_score": contradiction,
        })
    return sorted(ranked, key=lambda item: (-item["score"], item["disease_name"] or ""))[:top_k]


def evaluate_profile_retrieval(profiles, ancestors, information_content, names, max_diseases):
    max_ic = max(information_content.values(), default=1.0) or 1.0
    similarity = make_similarity_lookup(ancestors, information_content, max_ic)
    reciprocal_ranks = []
    top1 = 0
    top5 = 0
    evaluated = 0
    for profile in profiles:
        terms = [item["hpo_id"] for item in profile.get("present", [])]
        if len(terms) < 2:
            continue
        hidden = terms[-1]
        observed = terms[:-1]
        target = profile.get("disease_id")
        masked_target = {
            **profile,
            "present": [item for item in profile.get("present", []) if item["hpo_id"] != hidden],
        }
        target_score, _, _ = score_disease(observed, masked_target, similarity, names, False)
        target_name = profile.get("disease_name") or ""
        preceding = 0
        for candidate in profiles:
            if candidate.get("disease_id") == target:
                continue
            candidate_score, _, _ = score_disease(observed, candidate, similarity, names, False)
            candidate_name = candidate.get("disease_name") or ""
            if candidate_score > target_score or (candidate_score == target_score and candidate_name < target_name):
                preceding += 1
        rank = preceding + 1
        evaluated += 1
        reciprocal_ranks.append(1 / rank)
        top1 += int(rank == 1)
        top5 += int(rank <= 5)
        if evaluated >= max_diseases:
            break
    return {
        "model_version": "hpo-resnik-baseline-1",
        "evaluator_version": "leave-one-out-mask-target-v2",
        "evaluation_type": "leave-one-present-phenotype-out knowledge-profile self-consistency; not patient validation",
        "diseases_evaluated": evaluated,
        "top1": top1 / evaluated if evaluated else None,
        "top5": top5 / evaluated if evaluated else None,
        "mean_reciprocal_rank": sum(reciprocal_ranks) / evaluated if evaluated else None,
    }


def run_rare_disease(args):
    profiles, parents, names = load_disease_resources(args)
    ancestors = make_ancestor_lookup(parents)
    information_content = build_information_content(profiles, ancestors)
    if args.self_test:
        report = evaluate_profile_retrieval(profiles, ancestors, information_content, names, args.max_diseases)
        report["generated_at"] = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
        report["profiles_source"] = str(args.profiles)
    else:
        input_terms = sorted(set(term.strip() for term in args.phenotypes.split(",") if term.strip()))
        if not input_terms:
            raise ValueError("Provide comma-separated HPO identifiers with --phenotypes or select --self-test.")
        report = {
            "model_version": "hpo-resnik-baseline-1",
            "input_hpo_ids": input_terms,
            "candidates": rank_diseases(input_terms, profiles, ancestors, information_content, names, args.top_k),
            "method": "Normalized Resnik-style similarity using HPO ancestor information content from disease profiles, with absent-phenotype contradiction penalty.",
            "limitations": [
                "Research ranking only; not a clinical diagnosis.",
                "Disease profiles are knowledge annotations, not a patient validation cohort.",
                "Only supplied HPO identifiers are used; normalize free text before ranking.",
            ],
        }
    write_json(args.report, report)
    print(json.dumps(report, indent=2))


def build_parser():
    parser = argparse.ArgumentParser(description="Train and evaluate SignalLab Phase 4 research baselines.")
    commands = parser.add_subparsers(dest="command", required=True)

    amr = commands.add_parser("amr", help="Train the laboratory-label-only resistance-feature baseline.")
    amr.add_argument("--input", type=Path, default=DEFAULT_AMR_INPUT)
    amr.add_argument("--cohort", type=Path, default=DEFAULT_AMR_COHORT)
    amr.add_argument("--model", type=Path, default=DEFAULT_AMR_MODEL)
    amr.add_argument("--report", type=Path, default=DEFAULT_AMR_REPORT)
    amr.add_argument("--split-by", choices=["genome", "temporal", "laboratory", "geography"], default="genome")
    amr.add_argument("--lab-test-group", default="PATRIC@patricbrc.org")
    amr.add_argument("--lab-validation-group", default="PATRIC")
    amr.add_argument("--max-labeled", type=int, default=0, help="Optional smoke-test cap on eligible labeled rows; 0 uses all rows.")
    amr.add_argument("--hash-features", type=int, default=262144)
    amr.add_argument("--alpha", type=float, default=0.0001)
    amr.add_argument("--seed", type=int, default=42)
    amr.set_defaults(run= train_amr)

    rare = commands.add_parser("rare", help="Rank disease profiles or run a knowledge-profile self-consistency check.")
    rare.add_argument("--profiles", type=Path, default=DEFAULT_DISEASE_PROFILES)
    rare.add_argument("--graph", type=Path, default=DEFAULT_HPO_GRAPH)
    rare.add_argument("--term-index", type=Path, default=DEFAULT_HPO_INDEX)
    rare.add_argument("--phenotypes", default="")
    rare.add_argument("--top-k", type=int, default=10)
    rare.add_argument("--self-test", action="store_true")
    rare.add_argument("--max-diseases", type=int, default=100)
    rare.add_argument("--report", type=Path, default=ROOT / "data/models/hpo_baseline_metrics.json")
    rare.set_defaults(run=run_rare_disease)
    return parser


def main():
    args = build_parser().parse_args()
    args.run(args)


if __name__ == "__main__":
    main()