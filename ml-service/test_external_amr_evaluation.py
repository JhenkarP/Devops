import hashlib
import json
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path

from joblib import dump
from sklearn.feature_extraction import FeatureHasher
from sklearn.linear_model import SGDClassifier

from baselines import feature_dict, genome_fold
from evaluate_external_amr import evaluate_external_cohort, validate_attestation


class ExternalAmrEvaluationTests(unittest.TestCase):
    def test_attestation_requires_measured_ast_and_verified_identity_semantics(self):
        manifest = {
            "dataset_name": "independent AST cohort",
            "source_url": "https://example.org/cohort",
            "independence_evidence": "separate source documentation",
            "laboratory_identity_evidence": "facility field definition",
            "isolate_identity_evidence": "isolate field definition",
            "license_or_access_terms": "research use permitted",
            "independent_of_training": True,
            "phenotype_evidence": "measured_ast",
            "laboratory_id_semantics": "physical_testing_facility",
            "isolate_id_semantics": "biological_isolate",
            "cohort_sha256": "abc123",
        }
        self.assertTrue(validate_attestation(manifest, "abc123")["attestations_are_self_declared"])

        manifest["laboratory_id_semantics"] = "submitter"
        with self.assertRaisesRegex(ValueError, "physical facility"):
            validate_attestation(manifest, "abc123")

        manifest["laboratory_id_semantics"] = "physical_testing_facility"
        manifest["phenotype_evidence"] = "computational_prediction"
        with self.assertRaisesRegex(ValueError, "measured antimicrobial"):
            validate_attestation(manifest, "abc123")

    def test_external_evaluator_reports_pair_and_lab_clustered_metrics(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            cohort_path = root / "external.jsonl"
            manifest_path = root / "manifest.json"
            model_path = root / "model.joblib"
            model_report_path = root / "model-report.json"
            vocabulary_path = root / "vocabulary.json"
            training_input_path = root / "training.jsonl"
            output_path = root / "external-report.json"

            hasher = FeatureHasher(n_features=64, input_type="dict", alternate_sign=False)
            training_rows = [
                {"organism": "organism a", "antibiotic": "drug a", "products": ["feature r"]},
                {"organism": "organism a", "antibiotic": "drug a", "products": ["feature s"]},
                {"organism": "organism b", "antibiotic": "drug b", "products": ["feature r"]},
                {"organism": "organism b", "antibiotic": "drug b", "products": ["feature s"]},
            ]
            classifier = SGDClassifier(loss="log_loss", random_state=7, max_iter=1000, tol=1e-4)
            classifier.fit(hasher.transform([feature_dict(row) for row in training_rows]), [1, 0, 1, 0])
            dump({"model": classifier, "hasher": hasher, "version": "test-model-1"}, model_path)
            model_report_path.write_text(json.dumps({"model_version": "test-model-1", "validation": {"threshold": 0.5}}), encoding="utf-8")
            vocabulary_path.write_text(json.dumps({
                "model_version": "test-model-1",
                "organisms": ["organism a"],
                "antibiotics": ["drug a"],
                "products": ["feature r", "feature s"],
            }), encoding="utf-8")

            training_genome = next(f"training-{index}" for index in range(1000) if genome_fold(f"training-{index}") == "train")
            training_input_path.write_text(json.dumps({
                "evidence_class": "laboratory",
                "label": "resistant",
                "genome_id": training_genome,
            }) + "\n", encoding="utf-8")
            external_rows = []
            for lab_index, laboratory_id in enumerate(("facility-a", "facility-b")):
                for label, products in (("resistant", ["feature r"]), ("susceptible", ["feature s"])):
                    external_rows.append({
                        "measurement_id": f"measurement-{lab_index}-{label}",
                        "isolate_id": f"isolate-{lab_index}-{label}",
                        "genome_id": f"external-{lab_index}-{label}",
                        "laboratory_id": laboratory_id,
                        "organism": "Organism A",
                        "antibiotic": "Drug A",
                        "label": label,
                        "products": products,
                        "evidence_class": "laboratory",
                        "testing_method": "broth dilution",
                    })
            external_rows.append({
                "measurement_id": "measurement-oov",
                "isolate_id": "isolate-oov",
                "genome_id": "external-oov",
                "laboratory_id": "facility-c",
                "organism": "Organism A",
                "antibiotic": "Drug A",
                "label": "susceptible",
                "products": ["unseen feature"],
                "evidence_class": "laboratory",
                "testing_method": "broth dilution",
            })
            cohort_path.write_text("".join(json.dumps(row) + "\n" for row in external_rows), encoding="utf-8")
            cohort_sha256 = hashlib.sha256(cohort_path.read_bytes()).hexdigest()
            manifest = {
                "dataset_name": "independent AST cohort",
                "source_url": "https://example.org/cohort",
                "independence_evidence": "separate source documentation",
                "laboratory_identity_evidence": "facility field definition",
                "isolate_identity_evidence": "isolate field definition",
                "license_or_access_terms": "research use permitted",
                "independent_of_training": True,
                "phenotype_evidence": "measured_ast",
                "laboratory_id_semantics": "physical_testing_facility",
                "isolate_id_semantics": "biological_isolate",
                "cohort_sha256": cohort_sha256,
            }
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            evaluate_external_cohort(Namespace(
                cohort=cohort_path,
                manifest=manifest_path,
                output=output_path,
                model=model_path,
                model_report=model_report_path,
                vocabulary=vocabulary_path,
                training_input=training_input_path,
            ))

            result = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(result["cohort_audit"]["records_scored"], 4)
            self.assertEqual(result["cohort_audit"]["records_excluded_out_of_vocabulary"], 1)
            self.assertEqual(result["cohort_audit"]["physical_laboratories_scored"], 2)
            self.assertEqual(result["cohort_audit"]["out_of_vocabulary"]["products"], ["unseen feature"])
            self.assertEqual(result["cohort_audit"]["train_or_validation_genome_overlap"], 0)
            self.assertIn("laboratory_cluster_bootstrap_confidence_intervals_95", result["aggregate"])
            pair = result["by_organism_antibiotic"]["organism a"]["drug a"]
            self.assertEqual(pair["laboratories"], 2)
            self.assertEqual(pair["records"], 4)
            self.assertIn("sensitivity", pair["sensitivity_specificity_wilson_intervals_95"])
            self.assertIn("auroc", pair["laboratory_cluster_bootstrap_confidence_intervals_95"])
            self.assertIn("human verification", result["limitations"][0])

            external_rows[0]["genome_id"] = training_genome
            cohort_path.write_text("".join(json.dumps(row) + "\n" for row in external_rows), encoding="utf-8")
            manifest["cohort_sha256"] = hashlib.sha256(cohort_path.read_bytes()).hexdigest()
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "overlaps 1 train/validation genome"):
                evaluate_external_cohort(Namespace(
                    cohort=cohort_path,
                    manifest=manifest_path,
                    output=output_path,
                    model=model_path,
                    model_report=model_report_path,
                    vocabulary=vocabulary_path,
                    training_input=training_input_path,
                ))


if __name__ == "__main__":
    unittest.main()