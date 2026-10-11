import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from audit_amr_scope import (
    aggregate_records, choose_scope, collect_pairs, create_tables, floor_assessment, reported_protocols,
    genome_split, normalize_antibiotic, normalize_organism,
)


def pair(organism, antibiotic, train_r, train_s, test_r, test_s):
    return {
        "organism": organism,
        "antibiotic": antibiotic,
        "protocols": [{
            "protocol": "broth dilution | clsi | 2024",
            "unique_genomes": {
                "train": {"resistant": train_r, "susceptible": train_s},
                "validation": {"resistant": 20, "susceptible": 20},
                "test": {"resistant": test_r, "susceptible": test_s},
            },
            "measured_ast_unique_genomes": {
                "train": {"resistant": train_r, "susceptible": train_s},
                "validation": {"resistant": 20, "susceptible": 20},
                "test": {"resistant": test_r, "susceptible": test_s},
            },
            "numeric_ast_unique_genomes": {
                "train": {"resistant": train_r, "susceptible": train_s},
                "validation": {"resistant": 20, "susceptible": 20},
                "test": {"resistant": test_r, "susceptible": test_s},
            },
            "floor_assessment": floor_assessment({
                "train": {"resistant": train_r, "susceptible": train_s},
                "test": {"resistant": test_r, "susceptible": test_s},
            }),
        }],
    }


class AmrScopeAuditTests(unittest.TestCase):
    def test_normalizes_organism_and_common_antibiotic_aliases(self):
        self.assertEqual(normalize_organism(" Escherichia   coli "), "escherichia coli")
        self.assertEqual(normalize_organism("Pseudomonas aeruginosa strain 402"), "pseudomonas aeruginosa")
        self.assertEqual(normalize_organism("Salmonella enterica SRR3210392"), "salmonella enterica")
        self.assertEqual(normalize_organism('""Salmonella enterica strain N43448""'), "salmonella enterica")
        self.assertEqual(normalize_antibiotic("Cipro"), "ciprofloxacin")
        self.assertEqual(normalize_antibiotic("trimethoprim / sulfamethoxazole"), "trimethoprim-sulfamethoxazole")

    def test_reproduces_deterministic_genome_split(self):
        self.assertEqual(genome_split("GCF_000005845.2"), genome_split("GCF_000005845.2"))
        self.assertIsNone(genome_split(""))
        self.assertIn(genome_split("GCF_000005845.2"), {"train", "validation", "test"})

    def test_both_classes_must_meet_floor_within_protocol(self):
        enough = {"train": {"resistant": 100, "susceptible": 100}, "test": {"resistant": 30, "susceptible": 30}}
        too_sparse = {"train": {"resistant": 99, "susceptible": 100}, "test": {"resistant": 30, "susceptible": 30}}
        self.assertTrue(floor_assessment(enough)["meets_exploratory_floor"])
        self.assertEqual(floor_assessment(too_sparse)["unmet_checks"], ["train_resistant"])

    def test_selects_species_with_most_qualifying_drugs(self):
        result = choose_scope([
            pair("escherichia coli", "ciprofloxacin", 180, 300, 40, 80),
            pair("escherichia coli", "ampicillin", 120, 220, 32, 70),
            pair("escherichia coli", "colistin", 99, 220, 32, 70),
            pair("klebsiella pneumoniae", "meropenem", 200, 300, 50, 60),
        ])
        self.assertEqual(result["selected_species"], "escherichia coli")
        self.assertEqual(result["selected_antibiotics"], ["ciprofloxacin", "ampicillin"])

    def test_reports_no_candidate_below_floor(self):
        result = choose_scope([pair("klebsiella pneumoniae", "meropenem", 20, 100, 5, 50)])
        self.assertEqual(result["status"], "no_pair_meets_exploratory_floor")
        self.assertEqual(result["candidate_pairs"], [])

    def test_labelled_genomes_without_numeric_ast_do_not_qualify(self):
        candidate = pair("klebsiella pneumoniae", "meropenem", 200, 300, 50, 60)
        protocol = candidate["protocols"][0]
        protocol["numeric_ast_unique_genomes"] = {
            "train": {"resistant": 3, "susceptible": 4},
            "validation": {"resistant": 0, "susceptible": 0},
            "test": {"resistant": 1, "susceptible": 1},
        }
        protocol["floor_assessment"] = floor_assessment(protocol["numeric_ast_unique_genomes"])
        result = choose_scope([candidate])
        self.assertEqual(result["status"], "no_pair_meets_exploratory_floor")

    def test_protocol_details_keep_all_eligible_or_top_three_when_none_qualify(self):
        protocols = [
            {"protocol": str(index), "floor_assessment": {"meets_exploratory_floor": index in {5, 8}}}
            for index in range(10)
        ]
        self.assertEqual([protocol["protocol"] for protocol in reported_protocols(protocols)], ["5", "8"])
        for protocol in protocols:
            protocol["floor_assessment"]["meets_exploratory_floor"] = False
        self.assertEqual([protocol["protocol"] for protocol in reported_protocols(protocols)], ["0", "1", "2"])

    def test_aggregation_separates_evidence_and_counts_label_conflicts(self):
        records = [
            {"organism": "E. coli", "antibiotic": "Cipro", "evidence_class": "laboratory", "label": "resistant", "genome_id": "G1", "source_id": "M1", "measurement": "4", "measurement_unit": "mg/L", "testing_method": "broth", "testing_standard": "CLSI", "testing_standard_year": "2024"},
            {"organism": "E. coli", "antibiotic": "Cipro", "evidence_class": "laboratory", "label": "susceptible", "genome_id": "G1", "testing_method": "broth", "testing_standard": "CLSI", "testing_standard_year": "2024"},
            {"organism": "E. coli", "antibiotic": "Cipro", "evidence_class": "computational", "label": "resistant", "genome_id": "G2"},
        ]
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "cohort.jsonl"
            source.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
            connection = sqlite3.connect(":memory:")
            create_tables(connection)
            counts, ast, protocols, _ = aggregate_records(source, connection)
            pairs = collect_pairs(connection, counts, ast, protocols, 100, 30)
            connection.close()
        result = pairs[0]
        self.assertEqual(result["record_counts"]["laboratory"], 2)
        self.assertEqual(result["record_counts"]["computational"], 1)
        self.assertEqual(result["laboratory_labels"]["resistant"], 1)
        self.assertEqual(result["laboratory_labels"]["susceptible"], 1)
        self.assertEqual(result["contradictory_rs_genome_ids"], 1)
        self.assertEqual(result["protocols"][0]["unique_genomes"]["train"]["resistant"], 0)
        self.assertEqual(result["protocols"][0]["unique_genomes"]["train"]["susceptible"], 0)
        self.assertEqual(result["laboratory_rs_records_with"]["measurement"], 1)
        self.assertEqual(result["laboratory_rs_records_with"]["source_id"], 1)
        self.assertEqual(result["laboratory_rs_records_with"]["numeric_measurement"], 1)


if __name__ == "__main__":
    unittest.main()