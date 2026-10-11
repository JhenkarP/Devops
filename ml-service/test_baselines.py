import json
import hashlib
import shutil
import sqlite3
from contextlib import closing
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent))
from baselines import (
    assign_split,
    bootstrap_confidence_intervals,
    build_information_content,
    evaluate_profile_retrieval,
    evaluate_subgroup_predictions,
    feature_dict,
    genome_fold,
    make_ancestor_lookup,
    prepare_amr_cohort,
    rank_diseases,
    wilson_interval,
)
from build_vocabulary import build_vocabulary
from app import (
    AMRGenomePanelRequest,
    AMRRequest,
    MODEL_PATH,
    REPORT_PATH,
    load_amr_baseline,
    load_amr_genome_catalog,
    load_amr_scope,
    load_amr_vocabulary,
    open_amr_genome_catalog,
    predict_amr,
    predict_amr_genome_panel,
)
from evaluate_phenopacket_store import (
    evaluate_leave_publication_out,
    profiles_without_case_publication,
    select_cases,
)


class BaselineTests(unittest.TestCase):
    def test_initial_scope_has_held_out_support_for_every_configured_pair(self):
        scope = load_amr_scope()
        report = load_amr_baseline()[1]
        metrics_by_antibiotic = report['test']['by_organism_antibiotic'][scope['organism']]

        self.assertEqual(scope['status'], 'exploratory_research_scope')
        self.assertEqual(scope['organism'], 'klebsiella pneumoniae')
        for pair in scope['pairs']:
            metrics = metrics_by_antibiotic[pair['antibiotic']]
            self.assertGreaterEqual(metrics['records'], pair['minimum_held_out_records'])
            self.assertGreater(metrics['resistant_records'], 0)
            self.assertGreater(metrics['susceptible_records'], 0)
            self.assertEqual(metrics['support_status'], pair['validation_status'])

    def test_bootstrap_metric_intervals_are_deterministic_and_cover_supported_metrics(self):
        labels = [1] * 20 + [0] * 20
        probabilities = [0.8] * 20 + [0.2] * 20
        intervals = bootstrap_confidence_intervals(labels, probabilities, seed=71, replicates=30, stratified=True)

        self.assertEqual(intervals, bootstrap_confidence_intervals(labels, probabilities, seed=71, replicates=30, stratified=True))
        self.assertEqual(set(intervals), {'auroc', 'auprc', 'brier_score', 'expected_calibration_error'})
        self.assertTrue(all(intervals[metric][0] <= intervals[metric][1] for metric in intervals))

    def test_subgroup_metrics_report_support_and_wilson_uncertainty(self):
        labels = [1] * 20 + [0] * 20
        probabilities = [0.9] * 20 + [0.1] * 20
        metrics = evaluate_subgroup_predictions(labels, probabilities, 0.5)

        self.assertEqual(metrics['records'], 40)
        self.assertEqual(metrics['support_status'], 'descriptive_only')
        self.assertEqual(metrics['confidence_intervals_95']['sensitivity'][1], 1.0)
        self.assertEqual(metrics['confidence_intervals_95']['specificity'][1], 1.0)
        self.assertEqual(evaluate_subgroup_predictions([1, 0], [0.9, 0.1], 0.5)['support_status'], 'insufficient_support')
        self.assertIsNone(wilson_interval(0, 0))

    def test_model_loader_rejects_missing_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch('app.MODEL_PATH', Path(directory) / 'missing.joblib'), patch('app.REPORT_PATH', Path(directory) / 'missing.json'):
                load_amr_baseline.cache_clear()
                with self.assertRaisesRegex(RuntimeError, 'artifact or evaluation report is missing'):
                    load_amr_baseline()
        load_amr_baseline.cache_clear()

    def test_model_loader_rejects_corrupt_artifact_checksum(self):
        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory) / 'corrupt.joblib'
            report_path = Path(directory) / 'report.json'
            model_path.write_bytes(b'corrupt model bytes')
            report_path.write_text('{}', encoding='utf-8')
            with patch('app.MODEL_PATH', model_path), patch('app.REPORT_PATH', report_path), patch('app.EXPECTED_MODEL_SHA256', '0' * 64):
                load_amr_baseline.cache_clear()
                with self.assertRaisesRegex(RuntimeError, 'checksum does not match'):
                    load_amr_baseline()
        load_amr_baseline.cache_clear()

    def test_model_loader_rejects_mismatched_report_version(self):
        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory) / 'model.joblib'
            report_path = Path(directory) / 'report.json'
            shutil.copyfile(MODEL_PATH, model_path)
            report = json.loads(REPORT_PATH.read_text(encoding='utf-8'))
            report['model_version'] = 'different-model-version'
            report_path.write_text(json.dumps(report), encoding='utf-8')
            checksum = hashlib.sha256(model_path.read_bytes()).hexdigest()
            with patch('app.MODEL_PATH', model_path), patch('app.REPORT_PATH', report_path), patch('app.EXPECTED_MODEL_SHA256', checksum):
                load_amr_baseline.cache_clear()
                with self.assertRaisesRegex(RuntimeError, 'versions do not match configuration'):
                    load_amr_baseline()
        load_amr_baseline.cache_clear()

    def test_amr_vocabulary_uses_only_training_split_and_has_stable_checksum(self):
        records = [
            {"split": "train", "organism": " Species  A ", "antibiotic": "Drug A", "products": [" Enzyme X "]},
            {"split": "test", "organism": "Species B", "antibiotic": "Drug B", "products": ["Enzyme Y"]},
        ]
        with tempfile.TemporaryDirectory() as directory:
            cohort_path = Path(directory) / "cohort.jsonl"
            cohort_path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
            vocabulary = build_vocabulary(cohort_path, "model-v1", "dataset-v1")
            repeated = build_vocabulary(cohort_path, "model-v1", "dataset-v1")

        self.assertEqual(vocabulary["source_records"], 1)
        self.assertEqual(vocabulary["organisms"], ["species a"])
        self.assertEqual(vocabulary["antibiotics"], ["drug a"])
        self.assertEqual(vocabulary["products"], ["enzyme x"])
        self.assertEqual(vocabulary["sha256"], repeated["sha256"])

    def test_amr_service_uses_trained_artifact_and_reports_raw_score_semantics(self):
        product = load_amr_vocabulary()['products'][0]
        request = AMRRequest(
            organism=' Klebsiella   pneumoniae ',
            antibiotic=' Meropenem ',
            products=[f' {product} ', product],
        )

        self.assertEqual(request.organism, 'klebsiella pneumoniae')
        self.assertEqual(request.products, [product])
        result = predict_amr(request)

        self.assertEqual(result['model_version'], 'amr-sgd-feature-baseline-1')
        self.assertEqual(result['dataset_version'], 'amr-baseline-cohort-a3c7b549296846c1')
        self.assertEqual(result['evaluation_mode'], 'trained_baseline_uncalibrated')
        self.assertEqual(result['score_semantics'], 'Uncalibrated model score; not a probability.')
        self.assertGreaterEqual(result['resistance_score'], 0.0)
        self.assertLessEqual(result['resistance_score'], 1.0)
        self.assertEqual(result['decision_threshold'], 0.2)
        self.assertEqual(result['feature_vocabulary_version'], 'amr-feature-vocabulary-1')

    def test_amr_service_rejects_out_of_vocabulary_products(self):
        with self.assertRaises(HTTPException) as error:
            predict_amr(AMRRequest(
                organism='Klebsiella pneumoniae',
                antibiotic='Meropenem',
                products=['not a trained product'],
            ))

        self.assertEqual(error.exception.status_code, 422)
        self.assertEqual(error.exception.detail['unknown_products'], ['not a trained product'])
        self.assertEqual(error.exception.detail['vocabulary_version'], 'amr-feature-vocabulary-1')

    def test_genome_panel_uses_catalog_calls_and_scores_only_the_initial_scope(self):
        catalog = load_amr_genome_catalog()
        with closing(open_amr_genome_catalog()) as connection:
            genome = connection.execute(
                '''SELECT genome_id, organism, source_record_count, source_feature_call_count,
                          test_label_records, product_count
                   FROM genomes WHERE serving_eligible = 1 ORDER BY genome_id LIMIT 1''',
            ).fetchone()
            products = [row[0] for row in connection.execute(
                'SELECT product FROM genome_products WHERE genome_id = ? ORDER BY product', (genome[0],),
            )]

        result = predict_amr_genome_panel(AMRGenomePanelRequest(genome_id=genome[0]))

        self.assertEqual(result['genome_id'], genome[0])
        self.assertEqual(result['organism'], genome[1])
        self.assertEqual(result['detected_products'], products)
        self.assertEqual(result['source_record_count'], genome[2])
        self.assertEqual(result['source_feature_call_count'], genome[3])
        self.assertEqual(result['genome_data_partition'], 'held_out_test' if genome[4] else 'no_eligible_laboratory_label')
        scope_antibiotics = [pair['antibiotic'] for pair in load_amr_scope()['pairs']]
        self.assertEqual({item['antibiotic'] for item in result['antibiotic_panel']}, set(scope_antibiotics))
        self.assertEqual(result['panel_count'], len(scope_antibiotics))
        self.assertEqual(len(result['antibiotic_panel']), result['panel_count'])
        self.assertTrue(all(item['predicted_phenotype'] in {'R', 'S'} for item in result['antibiotic_panel']))
        self.assertEqual(result['predicted_resistant_count'], sum(item['predicted_phenotype'] == 'R' for item in result['antibiotic_panel']))
        self.assertEqual(result['predicted_susceptible_count'], sum(item['predicted_phenotype'] == 'S' for item in result['antibiotic_panel']))
        self.assertTrue(all(
            item['predicted_phenotype'] == ('R' if item['resistance_score'] >= result['decision_threshold'] else 'S')
            for item in result['antibiotic_panel']
        ))
        self.assertIn('not a ranking of effective drugs', result['caveat'])
        self.assertIn('not a treatment recommendation', result['caveat'])
        self.assertIn('Confirm every result with laboratory testing', result['caveat'])
        evaluation_report = load_amr_baseline()[1]
        expected_pair = evaluation_report['test']['by_organism_antibiotic'].get(genome[1], {})
        for item in result['antibiotic_panel']:
            pair = item['pair_evaluation']
            expected = expected_pair.get(item['antibiotic'])
            self.assertEqual(pair['records'], expected['records'] if expected else 0)
            self.assertEqual(pair['support_status'], expected['support_status'] if expected else 'not_assessed')
            self.assertEqual(pair['confidence_intervals_95']['sensitivity'], expected['confidence_intervals_95']['sensitivity'] if expected else None)
        self.assertEqual(result['genome_catalog_sha256'], catalog['catalog_sha256'])
        self.assertEqual(result['genome_source_sha256'], catalog['enriched_source']['sha256'])
        self.assertTrue(all('susceptible' not in item['interpretation'].lower() for item in result['antibiotic_panel']))
        with closing(open_amr_genome_catalog()) as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM genomes').fetchone()[0], catalog['source_genome_count'])
            self.assertEqual(connection.execute(
                'SELECT count(*) FROM genomes WHERE serving_eligible = 1 AND (train_label_records > 0 OR validation_label_records > 0)',
            ).fetchone()[0], 0)

    def test_genome_panel_rejects_ids_outside_the_bounded_catalog(self):
        with self.assertRaises(HTTPException) as error:
            predict_amr_genome_panel(AMRGenomePanelRequest(genome_id='999999.999999'))

        self.assertEqual(error.exception.status_code, 404)

    def test_genome_panel_rejects_training_and_validation_genomes(self):
        with closing(open_amr_genome_catalog()) as connection:
            genome_id, train_count, validation_count = connection.execute(
                '''SELECT genome_id, train_label_records, validation_label_records
                   FROM genomes WHERE train_label_records > 0 OR validation_label_records > 0
                   ORDER BY genome_id LIMIT 1''',
            ).fetchone()

        with self.assertRaises(HTTPException) as error:
            predict_amr_genome_panel(AMRGenomePanelRequest(genome_id=genome_id))

        self.assertEqual(error.exception.status_code, 422)
        self.assertGreaterEqual(
            error.exception.detail['train_label_records'] + error.exception.detail['validation_label_records'],
            1,
        )
        self.assertEqual(error.exception.detail['train_label_records'], train_count)
        self.assertEqual(error.exception.detail['validation_label_records'], validation_count)

    def test_genome_catalog_rejects_tampered_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            catalog_path = Path(directory) / 'catalog.sqlite'
            manifest_path = Path(directory) / 'catalog.manifest.json'
            with closing(sqlite3.connect(catalog_path)) as connection:
                connection.execute('CREATE TABLE tamper_test (value TEXT)')
            manifest = {
                'catalog_version': 'amr-bvbrc-genome-catalog-2m-v1',
                'catalog_sha256': hashlib.sha256(catalog_path.read_bytes()).hexdigest(),
            }
            manifest['manifest_sha256'] = hashlib.sha256(
                json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8'),
            ).hexdigest()
            manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
            catalog_path.write_bytes(catalog_path.read_bytes() + b'tampered')
            with patch('app.GENOME_CATALOG_PATH', catalog_path), patch('app.GENOME_CATALOG_MANIFEST_PATH', manifest_path):
                load_amr_genome_catalog.cache_clear()
                with self.assertRaisesRegex(RuntimeError, 'checksum does not match'):
                    load_amr_genome_catalog()
        load_amr_genome_catalog.cache_clear()

    def test_genome_split_is_deterministic(self):
        self.assertEqual(genome_fold("genome-123"), genome_fold("genome-123"))
        self.assertIn(genome_fold("genome-123"), {"train", "validation", "test"})

    def test_temporal_and_metadata_group_splits_use_explicit_holdouts(self):
        self.assertEqual(assign_split({"collection_year": 2016}, "temporal"), "train")
        self.assertEqual(assign_split({"collection_year": 2017}, "temporal"), "validation")
        self.assertEqual(assign_split({"collection_year": 2019}, "temporal"), "test")
        self.assertIsNone(assign_split({"collection_year": None}, "temporal"))
        self.assertEqual(
            assign_split({"laboratory": "held-out"}, "laboratory", "held-out", "validation"),
            "test",
        )
        self.assertEqual(
            assign_split({"laboratory": "validation"}, "laboratory", "held-out", "validation"),
            "validation",
        )

    def test_phenopacket_selection_uses_known_positive_terms_and_one_case_per_disease(self):
        packets = [
            {
                "id": "case-1",
                "phenotypicFeatures": [
                    {"type": {"id": "HP:1"}},
                    {"type": {"id": "HP:2"}, "excluded": True},
                    {"type": {"id": "HP:unknown"}},
                ],
                "diseases": [{"term": {"id": "OMIM:1", "label": "Disease one"}}],
                "metaData": {"externalReferences": [{"id": "PMID:1"}]},
            },
            {
                "id": "case-2",
                "phenotypicFeatures": [{"type": {"id": "HP:1"}}],
                "diseases": [{"term": {"id": "OMIM:1", "label": "Disease one"}}],
            },
            {
                "id": "case-unmapped",
                "phenotypicFeatures": [{"type": {"id": "HP:1"}}],
                "diseases": [{"term": {"id": "OMIM:2", "label": "Disease two"}}],
            },
        ]
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "packets.zip"
            with zipfile.ZipFile(archive_path, "w") as archive_file:
                for index, packet in enumerate(packets):
                    archive_file.writestr(f"store/notebooks/cohort/phenopackets/{index}.json", json.dumps(packet))
            with zipfile.ZipFile(archive_path) as archive_file:
                selected, summary = select_cases(archive_file, {"OMIM:1"}, {"HP:1"}, 10)

        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["phenotypes"], ["HP:1"])
        self.assertEqual(summary["packets_with_single_mapped_diagnosis"], 2)
        self.assertEqual(summary["unique_mapped_diseases"], 1)

    def test_case_publication_is_removed_from_every_candidate_profile(self):
        profiles = [
            {
                "disease_id": "OMIM:1",
                "present": [{"hpo_id": "HP:1"}, {"hpo_id": "HP:2"}],
                "absent": [{"hpo_id": "HP:3"}],
                "evidence": [
                    {"hpo_id": "HP:1", "reference": "PMID:100"},
                    {"hpo_id": "HP:1", "reference": "PMID:200"},
                    {"hpo_id": "HP:2", "reference": "PMID:100"},
                    {"hpo_id": "HP:3", "reference": "PMID:100"},
                ],
            },
            {
                "disease_id": "OMIM:2",
                "present": [{"hpo_id": "HP:4"}],
                "absent": [],
                "evidence": [{"hpo_id": "HP:4", "reference": "PMID:100"}],
            },
        ]

        filtered = profiles_without_case_publication(profiles, {"100"})

        self.assertEqual([profile["disease_id"] for profile in filtered], ["OMIM:1"])
        self.assertEqual([item["hpo_id"] for item in filtered[0]["present"]], ["HP:1"])
        self.assertEqual(filtered[0]["absent"], [])
        self.assertEqual([item["reference"] for item in filtered[0]["evidence"]], ["PMID:200"])

    def test_leave_publication_out_ranks_after_removing_case_evidence(self):
        profiles = [
            {
                "disease_id": "OMIM:1",
                "disease_name": "Target",
                "present": [{"hpo_id": "HP:1"}, {"hpo_id": "HP:2"}],
                "absent": [],
                "evidence": [
                    {"hpo_id": "HP:1", "reference": "PMID:100"},
                    {"hpo_id": "HP:2", "reference": "PMID:200"},
                ],
            },
            {
                "disease_id": "OMIM:2",
                "disease_name": "Alternative",
                "present": [{"hpo_id": "HP:1"}],
                "absent": [],
                "evidence": [{"hpo_id": "HP:1", "reference": "PMID:300"}],
            },
        ]
        cases = [{
            "disease_id": "OMIM:1",
            "packet_path": "PMID_100_case.json",
            "publication_references": ["PMID:100"],
            "phenotypes": ["HP:1"],
        }]

        result = evaluate_leave_publication_out(cases, profiles, make_ancestor_lookup({}), {"HP:1": "Term"})

        self.assertEqual(result["case_count"], 1)
        self.assertEqual(result["by_disease"]["OMIM:1"]["rank"], 2)
        self.assertEqual(result["by_disease"]["OMIM:1"]["held_out_pmids"], ["100"])

    def test_amr_cohort_filters_and_deduplicates(self):
        rows = [
            {"genome_id": "g1", "evidence_class": "laboratory", "label": "resistant", "antibiotic": "drug-a", "testing_method": "MIC", "resistance_feature_calls": [{"product": "enzyme X"}]},
            {"genome_id": "g1", "evidence_class": "laboratory", "label": "resistant", "antibiotic": "drug-a", "testing_method": "MIC", "resistance_feature_calls": [{"product": "enzyme X"}]},
            {"genome_id": "g2", "evidence_class": "computational", "label": "resistant", "antibiotic": "drug-a"},
            {"genome_id": "g3", "evidence_class": "laboratory", "label": "intermediate", "antibiotic": "drug-a"},
            {"genome_id": "g4", "evidence_class": "laboratory", "label": "susceptible", "antibiotic": "drug-b"},
        ]
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "input.jsonl"
            output_path = Path(directory) / "cohort.jsonl"
            input_path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            summary = prepare_amr_cohort(input_path, output_path, "genome", 0)
            selected = [json.loads(line) for line in output_path.read_text(encoding="utf-8").splitlines()]

        self.assertEqual(summary["eligible_lab_records"], 2)
        self.assertEqual(summary["duplicate_records_removed"], 1)
        self.assertEqual(summary["label_counts"], {"resistant": 1, "susceptible": 1})
        self.assertEqual(len(selected), 2)

    def test_cohort_reports_source_and_submitter_overlap_without_identifiers(self):
        rows = [
            {"genome_id": "g1", "source_id": "record-1", "source": "study-a", "laboratory": "submitter-a", "evidence_class": "laboratory", "label": "resistant", "antibiotic": "drug-a", "split": {"geography": "train"}},
            {"genome_id": "g2", "source_id": "record-1", "source": "study-a", "laboratory": "submitter-a", "evidence_class": "laboratory", "label": "susceptible", "antibiotic": "drug-b", "split": {"geography": "test"}},
            {"genome_id": "g3", "source_id": "record-3", "source": "study-b", "laboratory": "submitter-b", "evidence_class": "laboratory", "label": "resistant", "antibiotic": "drug-c", "split": {"geography": "train"}},
        ]
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / 'input.jsonl'
            output_path = Path(directory) / 'cohort.jsonl'
            input_path.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
            summary = prepare_amr_cohort(input_path, output_path, 'geography', 0)

        audit = summary['source_overlap_audit']
        self.assertEqual(audit['source_record_ids_in_multiple_splits'], 1)
        self.assertEqual(audit['source_groups_in_multiple_splits'], 1)
        self.assertEqual(audit['submitter_groups_in_multiple_splits'], 1)
        self.assertFalse(audit['physical_laboratory_identifiers_verified'])
        self.assertNotIn('record-1', json.dumps(audit))

    def test_model_features_do_not_include_identifiers(self):
        record = {"antibiotic": "drug-a", "organism": "species a", "products": ["enzyme x"]}
        features = feature_dict(record)
        self.assertIn("resistance_product=enzyme x", features)
        self.assertNotIn("genome_id", features)
        self.assertNotIn("source_id", features)

    def test_hpo_ranker_returns_supporting_term_evidence(self):
        profiles = [
            {"disease_id": "D:1", "disease_name": "Disease one", "present": [{"hpo_id": "HP:2"}], "absent": []},
            {"disease_id": "D:2", "disease_name": "Disease two", "present": [{"hpo_id": "HP:1"}], "absent": []},
        ]
        parents = {"HP:2": {"HP:1"}}
        ancestors = make_ancestor_lookup(parents)
        information_content = build_information_content(profiles, ancestors)
        ranked = rank_diseases(["HP:2"], profiles, ancestors, information_content, {"HP:2": "Specific term"}, 2)

        self.assertEqual(ranked[0]["disease_id"], "D:1")
        self.assertEqual(ranked[0]["supporting_terms"][0]["input_hpo_id"], "HP:2")

    def test_hpo_leave_one_out_masks_hidden_term_from_target_profile(self):
        profiles = [
            {"disease_id": "D:1", "disease_name": "Disease one", "present": [{"hpo_id": "HP:A"}, {"hpo_id": "HP:B"}], "absent": []},
            {"disease_id": "D:2", "disease_name": "Disease two", "present": [{"hpo_id": "HP:A"}, {"hpo_id": "HP:C"}], "absent": []},
        ]
        ancestors = make_ancestor_lookup({})
        information_content = build_information_content(profiles, ancestors)
        names = {"HP:A": "Shared", "HP:B": "Hidden one", "HP:C": "Hidden two"}
        report = evaluate_profile_retrieval(profiles, ancestors, information_content, names, 2)

        self.assertAlmostEqual(report["mean_reciprocal_rank"], 0.75)


if __name__ == "__main__":
    unittest.main()