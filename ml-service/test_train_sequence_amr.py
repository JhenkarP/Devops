import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from train_sequence_amr import genome_split, normalize_record, train


class SequenceTrainerTests(unittest.TestCase):
    def test_trainer_rejects_missing_ast_or_feature_provenance(self):
        record = {
            "genome_id": "genome-1",
            "organism": "klebsiella pneumoniae",
            "antibiotic": "meropenem",
            "label": "R",
            "evidence_class": "laboratory",
            "features": [],
            "ast": {"measurement": "1"},
            "feature_provenance": {},
        }
        self.assertIsNone(normalize_record(record))

    def test_trainer_requires_provenance_and_reports_test_laboratories(self):
        records = []
        selected = {"train": set(), "validation": set(), "test": set()}
        index = 0
        while any(len(values) < 4 for values in selected.values()):
            genome_id = f"genome-{index}"
            split = genome_split(genome_id)
            if len(selected[split]) < 4:
                label = "R" if len(selected[split]) % 2 == 0 else "S"
                selected[split].add(genome_id)
                records.append({
                    "genome_id": genome_id,
                    "organism": "klebsiella pneumoniae",
                    "antibiotic": "meropenem",
                    "label": label,
                    "evidence_class": "laboratory",
                    "features": [{"determinant": "blaKPC", "type": "acquired_gene"}] if label == "R" else [],
                    "ast": {
                        "measurement": "1",
                        "measurement_unit": "mg/L",
                        "testing_method": "broth dilution",
                        "testing_standard": "CLSI 2026",
                        "isolate_id": f"isolate-{index}",
                        "laboratory_id": f"lab-{index % 2}",
                    },
                    "feature_provenance": {
                        "fasta_sha256": "a" * 64,
                        "caller_name": "AMRFinderPlus",
                        "caller_version": "4.2.7",
                        "database_version": "2026-08-07.1",
                        "feature_manifest_sha256": "b" * 64,
                    },
                })
            index += 1

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "cohort.jsonl"
            model_path = root / "model.joblib"
            report_path = root / "report.json"
            input_path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
            report = train(input_path, model_path, report_path, "klebsiella pneumoniae")

        pair = report["pairs"]["meropenem"]
        self.assertEqual(pair["status"], "trained")
        self.assertIn("decision_threshold", pair)
        self.assertIn("lab-0", pair["test_by_laboratory"])
        self.assertIn("lab-1", pair["test_by_laboratory"])
        self.assertEqual(report["calibration_status"], "not_calibrated")


if __name__ == "__main__":
    unittest.main()
