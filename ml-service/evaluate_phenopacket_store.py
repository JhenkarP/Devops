import argparse
import hashlib
import json
import math
import re
import sys
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from baselines import build_information_content, load_disease_resources, make_ancestor_lookup, make_similarity_lookup, score_disease


DEFAULT_STORE = ROOT / "data/rare_disease/phenopacket-store-0.1.27.zip"
DEFAULT_REPORT = ROOT / "data/models/hpo_phenopacket_case_metrics.json"
PINNED_RELEASE = "0.1.27"
PINNED_SHA256 = "d0c70005bb09b87035087516252b6b539fbc0415be7c664b73c9cde7eedf205a"
PINNED_COMMIT = "3f3619800b2c949f8bfb457a122346c2fae7e482"


def select_cases(archive, profile_ids, known_hpo_ids, max_cases):
    cases_by_disease = defaultdict(list)
    packet_count = 0
    packets_with_diagnosis_and_hpo = 0
    mapped_packets = 0

    for packet_path in sorted(archive.namelist()):
        is_repository_archive_packet = "/phenopackets/" in packet_path
        is_release_asset_packet = packet_path.startswith(f"{PINNED_RELEASE}/") and packet_path.endswith(".json")
        if not (is_repository_archive_packet or is_release_asset_packet):
            continue
        packet_count += 1
        try:
            packet = json.loads(archive.read(packet_path))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue

        phenotypes = sorted({
            feature.get("type", {}).get("id")
            for feature in packet.get("phenotypicFeatures", [])
            if not feature.get("excluded", False)
            and feature.get("type", {}).get("id") in known_hpo_ids
        })
        disease_ids = sorted({
            disease.get("term", {}).get("id")
            for disease in packet.get("diseases", [])
            if disease.get("term", {}).get("id") in profile_ids
        })
        if not phenotypes or not disease_ids:
            continue
        packets_with_diagnosis_and_hpo += 1
        if len(disease_ids) != 1:
            continue

        mapped_packets += 1
        disease_id = disease_ids[0]
        case = {
            "packet_path": packet_path,
            "disease_id": disease_id,
            "disease_name": next(
                disease.get("term", {}).get("label")
                for disease in packet.get("diseases", [])
                if disease.get("term", {}).get("id") == disease_id
            ),
            "phenotypes": phenotypes,
            "publication_references": [
                reference.get("id")
                for reference in packet.get("metaData", {}).get("externalReferences", [])
                if reference.get("id")
            ],
        }
        digest = hashlib.sha256(packet_path.encode("utf-8")).hexdigest()
        cases_by_disease[disease_id].append((digest, case))

    one_case_per_disease = [
        min(cases, key=lambda item: item[0])[1]
        for cases in cases_by_disease.values()
    ]
    selected = sorted(
        one_case_per_disease,
        key=lambda case: hashlib.sha256(case["packet_path"].encode("utf-8")).hexdigest(),
    )[:max_cases]
    summary = {
        "phenopacket_files_found": packet_count,
        "packets_with_mapped_diagnosis_and_known_hpo_terms": packets_with_diagnosis_and_hpo,
        "packets_with_single_mapped_diagnosis": mapped_packets,
        "unique_mapped_diseases": len(cases_by_disease),
        "selected_cases": len(selected),
    }
    return selected, summary


def target_rank(case, profiles, names, similarity):
    target_profile = next(profile for profile in profiles if profile.get("disease_id") == case["disease_id"])
    target_score, _, _ = score_disease(case["phenotypes"], target_profile, similarity, names, False)
    target_name = target_profile.get("disease_name") or ""
    preceding = 0
    for candidate in profiles:
        if candidate.get("disease_id") == case["disease_id"]:
            continue
        candidate_score, _, _ = score_disease(case["phenotypes"], candidate, similarity, names, False)
        candidate_name = candidate.get("disease_name") or ""
        if candidate_score > target_score or (candidate_score == target_score and candidate_name < target_name):
            preceding += 1
    return preceding + 1


def evaluate_cases(cases, profiles, ancestors, information_content, names):
    max_ic = max(information_content.values(), default=1.0) or 1.0
    similarity = make_similarity_lookup(ancestors, information_content, max_ic)
    reciprocal_ranks = []
    top1 = 0
    top5 = 0
    by_disease = {}
    for index, case in enumerate(cases, start=1):
        rank = target_rank(case, profiles, names, similarity)
        reciprocal_ranks.append(1 / rank)
        top1 += int(rank == 1)
        top5 += int(rank <= 5)
        by_disease[case["disease_id"]] = {"rank": rank, "phenotype_count": len(case["phenotypes"])}
        if index % 10 == 0:
            print(f"Evaluated {index}/{len(cases)} disease-stratified cases", flush=True)

    count = len(cases)
    return {
        "top1": top1 / count if count else None,
        "top5": top5 / count if count else None,
        "mean_reciprocal_rank": sum(reciprocal_ranks) / count if count else None,
        "by_disease": by_disease,
    }


def evaluate_leave_publication_out(cases, profiles, ancestors, names):
    reciprocal_ranks = []
    top1 = 0
    top5 = 0
    by_disease = {}
    held_out_pmids = set()
    candidate_counts = []
    skipped = defaultdict(int)

    for index, case in enumerate(cases, start=1):
        case_pmids = normalize_pmids(case["publication_references"] + [case["packet_path"]])
        if not case_pmids:
            skipped["missing_case_pmid"] += 1
            continue

        held_out_pmids.update(case_pmids)
        candidate_profiles = profiles_without_case_publication(profiles, case_pmids)
        target_profile = next(
            (profile for profile in candidate_profiles if profile.get("disease_id") == case["disease_id"]),
            None,
        )
        if target_profile is None:
            skipped["target_profile_has_no_remaining_positive_evidence"] += 1
            continue

        information_content = build_information_content(candidate_profiles, ancestors)
        max_ic = max(information_content.values(), default=1.0) or 1.0
        similarity = make_similarity_lookup(ancestors, information_content, max_ic)
        rank = target_rank(case, candidate_profiles, names, similarity)
        reciprocal_ranks.append(1 / rank)
        top1 += int(rank == 1)
        top5 += int(rank <= 5)
        candidate_counts.append(len(candidate_profiles))
        by_disease[case["disease_id"]] = {
            "rank": rank,
            "phenotype_count": len(case["phenotypes"]),
            "held_out_pmids": sorted(case_pmids),
            "candidate_count": len(candidate_profiles),
        }
        if index % 10 == 0:
            print(f"Evaluated {index}/{len(cases)} leave-publication-out cases", flush=True)

    count = len(reciprocal_ranks)
    return {
        "method": "For each case, remove evidence rows citing any of its PMIDs from every disease candidate before rebuilding information content and ranking.",
        "case_count": count,
        "top1": top1 / count if count else None,
        "top5": top5 / count if count else None,
        "mean_reciprocal_rank": sum(reciprocal_ranks) / count if count else None,
        "unique_held_out_pmids": len(held_out_pmids),
        "average_candidate_count": sum(candidate_counts) / len(candidate_counts) if candidate_counts else None,
        "skipped_cases": dict(skipped),
        "by_disease": by_disease,
        "limitation": "Exact PMID evidence is withheld, but shared cohorts, derivative publications, and unlinked source references may remain; this is not proof of independent or clinical validation.",
    }


def perturb_case(case, fraction, mode, known_hpo_ids):
    terms = case["phenotypes"]
    count = min(len(terms), max(1, math.ceil(len(terms) * fraction)))
    ordered = sorted(terms, key=lambda term: hashlib.sha256(f"{case['packet_path']}|{mode}|{term}".encode()).hexdigest())
    if mode == "missing":
        retained = set(ordered[count:])
        if not retained:
            retained = {ordered[0]}
        return {**case, "phenotypes": sorted(retained)}

    retained = ordered[count:]
    distractors = sorted(known_hpo_ids.difference(terms))
    replacements = []
    for index in range(count):
        seed = hashlib.sha256(f"{case['packet_path']}|noise|{index}".encode()).digest()
        replacements.append(distractors[int.from_bytes(seed[:8], "big") % len(distractors)])
    return {**case, "phenotypes": sorted(set(retained + replacements))}


def normalize_pmids(values):
    pmids = set()
    for value in values:
        pmids.update(re.findall(r"(?i)PMID\s*[:_ ]\s*(\d+)", str(value)))
    return pmids


def profiles_without_case_publication(profiles, case_pmids):
    filtered_profiles = []
    for profile in profiles:
        remaining_evidence = [
            item for item in profile.get("evidence", [])
            if not normalize_pmids([item.get("reference", "")]).intersection(case_pmids)
        ]
        supported_hpo_ids = {item.get("hpo_id") for item in remaining_evidence}
        present = [item for item in profile.get("present", []) if item.get("hpo_id") in supported_hpo_ids]
        if not present:
            continue
        absent = [item for item in profile.get("absent", []) if item.get("hpo_id") in supported_hpo_ids]
        filtered_profiles.append({
            **profile,
            "present": present,
            "absent": absent,
            "evidence": remaining_evidence,
        })
    return filtered_profiles


def literature_overlap(cases, profiles):
    profiles_by_id = {profile.get("disease_id"): profile for profile in profiles}
    overlapping_cases = []
    for case in cases:
        case_pmids = normalize_pmids(case["publication_references"] + [case["packet_path"]])
        profile = profiles_by_id[case["disease_id"]]
        profile_pmids = normalize_pmids(item.get("reference") for item in profile.get("evidence", []))
        shared = sorted(case_pmids.intersection(profile_pmids))
        if shared:
            overlapping_cases.append({"disease_id": case["disease_id"], "shared_pmids": shared})
    return {
        "cases_with_detected_target_profile_pmid_overlap": len(overlapping_cases),
        "case_count": len(cases),
        "overlapping_cases": overlapping_cases,
        "limitation": "Exact PMID overlap is screened; absent PMID overlap does not establish source independence.",
    }


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description="Exploratory case-level HPO ranking evaluation on Phenopacket Store.")
    parser.add_argument("--store", type=Path, default=DEFAULT_STORE)
    parser.add_argument("--profiles", type=Path, default=ROOT / "data/rare_disease/processed/rare_disease_profiles.json")
    parser.add_argument("--graph", type=Path, default=ROOT / "data/rare_disease/processed/hpo_graph.json")
    parser.add_argument("--term-index", type=Path, default=ROOT / "data/rare_disease/processed/hpo_term_index.json")
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--max-cases", type=int, default=250)
    parser.add_argument("--robustness-cases", type=int, default=100)
    args = parser.parse_args()

    actual_sha256 = sha256_file(args.store)
    if args.store.name == f"phenopacket-store-{PINNED_RELEASE}.zip" and actual_sha256 != PINNED_SHA256:
        raise ValueError(f"Pinned Phenopacket Store archive checksum mismatch: {actual_sha256}")

    profiles, parents, names = load_disease_resources(argparse.Namespace(
        profiles=args.profiles,
        graph=args.graph,
        term_index=args.term_index,
    ))
    profile_ids = {profile.get("disease_id") for profile in profiles}
    known_hpo_ids = set(names)
    ancestors = make_ancestor_lookup(parents)
    information_content = build_information_content(profiles, ancestors)

    with zipfile.ZipFile(args.store) as archive:
        cases, cohort_summary = select_cases(archive, profile_ids, known_hpo_ids, args.max_cases)
    metrics = evaluate_cases(cases, profiles, ancestors, information_content, names)
    leave_publication_out = evaluate_leave_publication_out(cases, profiles, ancestors, names)
    robustness_cases = cases[:args.robustness_cases]
    robustness = {}
    for label, fraction, mode in (
        ("missing_25_percent", 0.25, "missing"),
        ("missing_50_percent", 0.50, "missing"),
        ("noisy_25_percent", 0.25, "noisy"),
    ):
        perturbed = [perturb_case(case, fraction, mode, known_hpo_ids) for case in robustness_cases]
        robustness[label] = evaluate_cases(perturbed, profiles, ancestors, information_content, names)
    overlap = literature_overlap(cases, profiles)
    report = {
        "model_version": "hpo-resnik-baseline-1",
        "evaluator_version": "phenopacket-store-release-disease-stratified-robustness-v2",
        "evaluation_type": "exploratory retrospective case-level disease retrieval with per-case exact-PMID evidence withholding; not prospective or clinical validation",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "archive": str(args.store),
            "release": PINNED_RELEASE,
            "commit": PINNED_COMMIT,
            "url": f"https://github.com/monarch-initiative/phenopacket-store/releases/download/{PINNED_RELEASE}/all_phenopackets.zip",
            "sha256": actual_sha256,
            "publisher_sha256": PINNED_SHA256,
            "repository_license": "BSD-3-Clause for repository content; per-case paper/source reuse terms may differ.",
        },
        "selection_policy": "At most one case per mapped OMIM disease; deterministic SHA-256 ordering; positive, known HPO terms only; one mapped diagnosis required.",
        "cohort": cohort_summary,
        "metrics": {key: value for key, value in metrics.items() if key != "by_disease"},
        "by_disease": metrics["by_disease"],
        "leave_publication_out": {
            key: value for key, value in leave_publication_out.items() if key != "by_disease"
        } | {"by_disease": leave_publication_out["by_disease"]},
        "robustness": {
            "case_count": len(robustness_cases),
            "perturbation_policy": "Deterministic per-packet phenotype deletion or replacement; minimum one retained/replacement term.",
            "metrics": {label: {key: value for key, value in result.items() if key != "by_disease"} for label, result in robustness.items()},
        },
        "calibration_assessment": {
            "status": "not_assessable",
            "reason": "The ranker emits normalized similarity scores, not probabilities; no probability calibration is claimed. A calibration model requires a larger independent case cohort and a held-out calibration split.",
        },
        "literature_overlap_screen": overlap,
        "limitations": [
            "This disease-stratified sample is an exploratory development benchmark, not a comprehensive or prospective validation.",
            "The release repository is BSD-3-Clause, but case phenotypes were curated from publications; individual source reuse terms require review before redistribution.",
            "Exact PMID overlap with target disease-profile evidence is reported; other source overlap may remain.",
            "Similarity scores are not probabilities, so probability calibration is not assessed.",
        ],
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"cohort": cohort_summary, "metrics": report["metrics"], "report": str(args.report)}, indent=2))


if __name__ == "__main__":
    main()