import tempfile
import unittest
from pathlib import Path

from hpo_service import build_hpo_metadata, build_term_aliases, normalize_phenotypes


class HpoServiceTests(unittest.TestCase):
    def test_normalization_accepts_exact_ids_names_and_synonyms(self):
        terms = [
            {'id': 'HP:0000001', 'name': 'All', 'synonyms': []},
            {'id': 'HP:0001263', 'name': 'Global developmental delay', 'synonyms': ['Developmental delay']},
        ]
        aliases, names = build_term_aliases(terms)

        result = normalize_phenotypes(
            ['hp:0000001', ' global developmental delay ', 'DEVELOPMENTAL DELAY'],
            aliases,
            names,
        )

        self.assertEqual([item['hpo_id'] for item in result], ['HP:0000001', 'HP:0001263', 'HP:0001263'])
        self.assertEqual(result[0]['match_type'], 'exact_hpo_id')
        self.assertEqual(result[2]['match_type'], 'exact_name_or_synonym')

    def test_normalization_reports_ambiguous_and_unmatched_terms_without_guessing(self):
        terms = [
            {'id': 'HP:0000001', 'name': 'All', 'synonyms': ['shared phrase']},
            {'id': 'HP:0000002', 'name': 'Root', 'synonyms': ['shared phrase']},
        ]
        aliases, names = build_term_aliases(terms)

        result = normalize_phenotypes(['shared phrase', 'not an HPO term'], aliases, names)

        self.assertEqual(result[0]['match_type'], 'ambiguous')
        self.assertIsNone(result[0]['hpo_id'])
        self.assertEqual(len(result[0]['candidates']), 2)
        self.assertEqual(result[1]['match_type'], 'unmatched')
        self.assertIsNone(result[1]['hpo_id'])

    def test_dataset_identity_tracks_all_artifact_checksums(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = {}
            for name in ('profiles', 'graph', 'term_index'):
                path = Path(directory) / f'{name}.json'
                path.write_text(name, encoding='utf-8')
                paths[name] = path

            first = build_hpo_metadata(paths)
            paths['graph'].write_text('updated graph', encoding='utf-8')
            second = build_hpo_metadata(paths)

        self.assertNotEqual(first['dataset_version'], second['dataset_version'])
        self.assertEqual(len(first['dataset_sha256']), 64)
        self.assertEqual(set(first['artifacts']), {'profiles', 'graph', 'term_index'})

    def test_candidate_unreported_profile_terms_are_not_marked_absent(self):
        from hpo_service import attach_unreported_profile_terms

        candidate = {
            'disease_id': 'OMIM:1',
            'supporting_terms': [{'matched_disease_hpo_id': 'HP:1'}],
        }
        profiles = [{
            'disease_id': 'OMIM:1',
            'present': [{'hpo_id': 'HP:1'}, {'hpo_id': 'HP:2'}, {'hpo_id': 'HP:3'}],
        }]

        result = attach_unreported_profile_terms([candidate], profiles, {'HP:2': 'Term two', 'HP:3': 'Term three'})

        self.assertEqual(result[0]['unreported_profile_terms'], [
            {'hpo_id': 'HP:2', 'term': 'Term two'},
            {'hpo_id': 'HP:3', 'term': 'Term three'},
        ])
        self.assertEqual(result[0]['unreported_profile_term_count'], 2)


if __name__ == '__main__':
    unittest.main()