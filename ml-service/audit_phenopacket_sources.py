import argparse
import json
import re
import sys
import time
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from baselines import load_disease_resources
from evaluate_phenopacket_store import (
    PINNED_RELEASE,
    PINNED_SHA256,
    normalize_pmids,
    select_cases,
    sha256_file,
)

DEFAULT_STORE = ROOT / "data/rare_disease/phenopacket-store-0.1.27.zip"
DEFAULT_EVALUATION = ROOT / "data/models/hpo_phenopacket_case_metrics.json"
DEFAULT_REPORT = ROOT / "data/models/phenopacket_source_reuse_audit.json"
EUROPE_PMC_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"


def fetch_article_metadata(pmids, batch_size=40):
    records = {}
    request_errors = []
    unique_pmids = sorted(pmids)
    for offset in range(0, len(unique_pmids), batch_size):
        batch = unique_pmids[offset:offset + batch_size]
        query = " OR ".join(f"EXT_ID:{pmid}" for pmid in batch)
        url = f"{EUROPE_PMC_URL}?{urlencode({'query': query, 'format': 'json', 'resultType': 'core', 'pageSize': '1000'})}"
        request = Request(url, headers={"User-Agent": "SignalLab Phenopacket provenance audit"})
        try:
            with urlopen(request, timeout=30) as response:
                payload = json.load(response)
            for record in payload.get("resultList", {}).get("result", []):
                pmid = str(record.get("pmid") or record.get("id") or "")
                if pmid:
                    records[pmid] = {
                        "pmid": pmid,
                        "pmcid": record.get("pmcid"),
                        "doi": record.get("doi"),
                        "title": record.get("title"),
                        "journal": record.get("journalTitle"),
                        "year": record.get("pubYear"),
                        "is_open_access": record.get("isOpenAccess"),
                        "license": record.get("license"),
                        "europe_pmc_source": record.get("source"),
                        "record_url": f"https://europepmc.org/article/{record.get('source', 'MED')}/{pmid}",
                    }
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
            request_errors.append({"pmids": batch, "error": f"{type(error).__name__}: {error}"})
        if offset + batch_size < len(unique_pmids):
            time.sleep(0.15)
    return records, request_errors


def rank_metrics(disease_ids, ranks):
    selected = [ranks[disease_id]["rank"] for disease_id in disease_ids if disease_id in ranks]
    count = len(selected)
    return {
        "case_count": count,
        "top1": sum(rank == 1 for rank in selected) / count if count else None,
        "top5": sum(rank <= 5 for rank in selected) / count if count else None,
        "mean_reciprocal_rank": sum(1 / rank for rank in selected) / count if count else None,
    }


def main():
    parser = argparse.ArgumentParser(description="Audit publication overlap and reuse metadata for Phenopacket Store cases.")
    parser.add_argument("--store", type=Path, default=DEFAULT_STORE)
    parser.add_argument("--profiles", type=Path, default=ROOT / "data/rare_disease/processed/rare_disease_profiles.json")
    parser.add_argument("--graph", type=Path, default=ROOT / "data/rare_disease/processed/hpo_graph.json")
    parser.add_argument("--term-index", type=Path, default=ROOT / "data/rare_disease/processed/hpo_term_index.json")
    parser.add_argument("--evaluation", type=Path, default=DEFAULT_EVALUATION)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--max-cases", type=int, default=250)
    args = parser.parse_args()

    archive_sha256 = sha256_file(args.store)
    if args.store.name == f"phenopacket-store-{PINNED_RELEASE}.zip" and archive_sha256 != PINNED_SHA256:
        raise ValueError(f"Pinned Phenopacket Store archive checksum mismatch: {archive_sha256}")

    profiles, _, names = load_disease_resources(argparse.Namespace(
        profiles=args.profiles,
        graph=args.graph,
        term_index=args.term_index,
    ))
    profile_ids = {profile.get("disease_id") for profile in profiles}
    with zipfile.ZipFile(args.store) as archive:
        cases, cohort = select_cases(archive, profile_ids, set(names), args.max_cases)

    profile_pmids_to_diseases = defaultdict(set)
    for profile in profiles:
        for evidence in profile.get("evidence", []):
            for pmid in normalize_pmids([evidence.get("reference", "")]):
                profile_pmids_to_diseases[pmid].add(profile.get("disease_id"))

    case_pmids = {
        case["disease_id"]: normalize_pmids(case["publication_references"] + [case["packet_path"]])
        for case in cases
    }
    all_case_pmids = set().union(*case_pmids.values()) if case_pmids else set()
    article_records, request_errors = fetch_article_metadata(all_case_pmids)
    evaluation = json.loads(args.evaluation.read_text(encoding="utf-8"))
    ranks = evaluation.get("by_disease", {})

    case_audits = []
    for case in cases:
        disease_id = case["disease_id"]
        source_ids = sorted(case_pmids[disease_id])
        matching_profile_ids = sorted({
            profile_id
            for pmid in source_ids
            for profile_id in profile_pmids_to_diseases.get(pmid, set())
        })
        target_shared = sorted({
            pmid for pmid in source_ids
            if disease_id in profile_pmids_to_diseases.get(pmid, set())
        })
        articles = [article_records.get(pmid, {"pmid": pmid, "metadata_status": "not_found_or_query_failed"}) for pmid in source_ids]
        case_audits.append({
            "disease_id": disease_id,
            "packet_path": case["packet_path"],
            "source_pmids": source_ids,
            "shared_pmids_with_target_profile": target_shared,
            "overlap_with_any_candidate_profile": bool(matching_profile_ids),
            "matching_candidate_profile_ids": matching_profile_ids,
            "source_independence_screen": "shared_exact_pmid_with_candidate_profile_evidence" if matching_profile_ids else "no_exact_pmid_match_detected_other_source_overlap_not_excluded",
            "source_articles": articles,
            "case_content_reuse_clearance": "not_established",
        })

    independent_ids = [case["disease_id"] for case in cases if not case_pmids[case["disease_id"]].intersection(profile_pmids_to_diseases)]
    article_status_counts = Counter()
    for pmid in all_case_pmids:
        record = article_records.get(pmid)
        if record is None:
            article_status_counts["metadata_unavailable"] += 1
        elif record.get("license"):
            article_status_counts[f"explicit_license:{record['license']}"] += 1
        elif record.get("is_open_access") == "Y":
            article_status_counts["open_access_license_not_reported"] += 1
        elif record.get("is_open_access") == "N":
            article_status_counts["not_in_open_access_subset"] += 1
        else:
            article_status_counts["access_or_license_status_unspecified"] += 1

    packet_rights_fields = 0
    rights_keys = {"license", "rights", "copyright", "licenseurl", "rightsholder"}
    def scan_rights_fields(value):
        if isinstance(value, dict):
            return sum(key.lower().replace("_", "") in rights_keys for key in value) + sum(scan_rights_fields(child) for child in value.values())
        if isinstance(value, list):
            return sum(scan_rights_fields(child) for child in value)
        return 0
    with zipfile.ZipFile(args.store) as archive:
        for case in cases:
            packet = json.loads(archive.read(case["packet_path"]))
            packet_rights_fields += scan_rights_fields(packet)

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "release": PINNED_RELEASE,
            "archive": str(args.store),
            "sha256": archive_sha256,
            "publisher_sha256": PINNED_SHA256,
            "repository_license": "BSD-3-Clause applies to repository-licensed content; it does not itself establish rights to republish each source-derived case.",
        },
        "cohort": cohort,
        "source_independence_screen": {
            "method": "Exact PMID comparison of each selected packet's publication reference/path against evidence references across every disease candidate profile.",
            "unique_case_pmids": len(all_case_pmids),
            "unique_profile_evidence_pmids": len(profile_pmids_to_diseases),
            "cases_with_target_profile_pmid_overlap": sum(bool(item["shared_pmids_with_target_profile"]) for item in case_audits),
            "cases_with_any_candidate_profile_pmid_overlap": sum(item["overlap_with_any_candidate_profile"] for item in case_audits),
            "cases_with_only_non_target_profile_overlap": sum(item["overlap_with_any_candidate_profile"] and not item["shared_pmids_with_target_profile"] for item in case_audits),
            "cases_without_exact_profile_pmid_overlap": len(independent_ids),
            "pmid_disjoint_case_ranking_metrics": rank_metrics(independent_ids, ranks),
            "limitation": "PMID-disjoint means no exact PMID reference was found in any candidate profile evidence. It does not rule out shared cohorts, derivative publications, non-PMID references, or other source dependence.",
        },
        "reuse_terms_review": {
            "selected_packet_rights_fields_found": packet_rights_fields,
            "unique_cited_pmids": len(all_case_pmids),
            "article_access_license_metadata_counts": dict(article_status_counts),
            "europe_pmc_request_errors": request_errors,
            "case_content_clearance": "No selected case is cleared for redistribution by this audit. Packets contain no per-case rights fields; Europe PMC access status or article license metadata does not by itself grant rights to redistribute a derivative case abstraction.",
            "per_case_assessments": "Each selected case is marked not_established unless source-specific permission is independently documented; see case_audits.",
        },
        "calibration_assessment": {
            "status": "not_assessable_for_reliable_probability_calibration",
            "source_screened_case_count": len(independent_ids),
            "reason": "Only the exact-PMID-disjoint subset is eligible for an exploratory calibration split, and exact PMID disjointness is not proof of independence. This small, retrospective, publication-derived subset cannot support a reliable independent calibration cohort. The underlying ranker also emits similarity scores rather than probabilities.",
            "probabilities_emitted": False,
        },
        "article_records": [article_records[pmid] for pmid in sorted(article_records)],
        "case_audits": case_audits,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "report": str(args.report),
        "cohort": cohort,
        "source_independence_screen": report["source_independence_screen"],
        "reuse_terms_review": report["reuse_terms_review"],
        "calibration_assessment": report["calibration_assessment"],
    }, indent=2))


if __name__ == "__main__":
    main()
