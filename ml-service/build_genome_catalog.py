import argparse
import hashlib
import json
import os
import sqlite3
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VOCABULARY_PATH = ROOT / 'data/models/amr_feature_vocabulary.json'
MANIFEST_PATH = ROOT / 'data/manifest.json'
ENRICHMENT_REPORT_PATH = ROOT / 'data/amr_2m/processed/bvbrc_amr_enrichment_report.json'
DEFAULT_INPUT_PATH = ROOT / 'data/amr_2m/processed/bvbrc_amr_2000000_enriched.jsonl'
DEFAULT_OUTPUT_PATH = ROOT / 'data/models/amr_genome_catalog.sqlite'
PRIOR_CATALOG_PATH = ROOT / 'data/models/amr_genome_catalog.json'
CATALOG_VERSION = 'amr-bvbrc-genome-catalog-2m-v1'
MODEL_VERSION = 'amr-sgd-feature-baseline-1'
DATASET_VERSION = 'amr-baseline-cohort-a3c7b549296846c1'
DATASET_SHA256 = 'a3c7b549296846c61eca74d2733c048fcbf1a2aa809f11c86fe673e7bdf6141e'


def normalize(value):
    return ' '.join(str(value or '').strip().lower().split())


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def genome_fold(genome_id):
    digest = hashlib.sha256(str(genome_id).encode('utf-8')).digest()
    return int.from_bytes(digest[:4], 'big') % 10


def load_prior_genome_ids(path):
    if not path.is_file():
        return set()
    with path.open(encoding='utf-8') as source:
        catalog = json.load(source)
    return {record['genome_id'] for record in catalog.get('genomes', []) if record.get('genome_id')}


def count(connection, query):
    return connection.execute(query).fetchone()[0]


def build_catalog(input_path, output_path, prior_catalog_path):
    vocabulary = json.loads(VOCABULARY_PATH.read_text(encoding='utf-8'))
    if vocabulary.get('model_version') != MODEL_VERSION or vocabulary.get('dataset_version') != DATASET_VERSION:
        raise ValueError('AMR vocabulary does not match the configured model and training dataset.')

    data_manifest = json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))
    source_snapshot = next(
        (entry for entry in data_manifest['sources'] if entry['name'] == 'amr_2m/bvbrc_genome_amr.json'),
        None,
    )
    if not source_snapshot or not source_snapshot.get('sha256'):
        raise ValueError('The 2M BV-BRC source checksum is missing from data/manifest.json.')
    source_path = ROOT / 'data' / source_snapshot['name']
    raw_source_sha256 = sha256_file(source_path)
    if raw_source_sha256 != source_snapshot['sha256']:
        raise ValueError('The raw 2M BV-BRC source does not match data/manifest.json.')

    enrichment_report = json.loads(ENRICHMENT_REPORT_PATH.read_text(encoding='utf-8'))
    if enrichment_report.get('records') != 2_000_000 or enrichment_report.get('metadata_request_failures') != 0 or enrichment_report.get('feature_request_failures') != 0:
        raise ValueError('The 2M enrichment report is incomplete or records request failures.')

    known_organisms = set(vocabulary['organisms'])
    known_products = set(vocabulary['products'])
    prior_ids = load_prior_genome_ids(prior_catalog_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path = output_path.resolve()
    manifest_path = output_path.with_suffix('.manifest.json')
    handle, temporary_name = tempfile.mkstemp(prefix=f'.{output_path.name}.', suffix='.tmp', dir=output_path.parent)
    os.close(handle)
    temporary_path = Path(temporary_name)

    source_digest = hashlib.sha256()
    source_records = 0
    rows_with_calls = 0
    source_genomes = set()
    prior_overlap = set()

    try:
        connection = sqlite3.connect(temporary_path)
        connection.execute('PRAGMA journal_mode=OFF')
        connection.execute('PRAGMA synchronous=OFF')
        connection.execute('PRAGMA temp_store=FILE')
        connection.execute('PRAGMA cache_size=-65536')
        connection.execute('PRAGMA page_size=4096')
        connection.executescript('''
            CREATE TABLE catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE genomes (
                genome_id TEXT PRIMARY KEY,
                organism TEXT,
                organism_conflict INTEGER NOT NULL DEFAULT 0,
                source_record_count INTEGER NOT NULL DEFAULT 0,
                source_feature_call_count INTEGER NOT NULL DEFAULT 0,
                train_label_records INTEGER NOT NULL DEFAULT 0,
                validation_label_records INTEGER NOT NULL DEFAULT 0,
                test_label_records INTEGER NOT NULL DEFAULT 0,
                product_count INTEGER NOT NULL DEFAULT 0,
                serving_eligible INTEGER NOT NULL DEFAULT 0
            ) WITHOUT ROWID;
            CREATE TABLE genome_products (
                genome_id TEXT NOT NULL,
                product TEXT NOT NULL,
                PRIMARY KEY (genome_id, product),
                FOREIGN KEY (genome_id) REFERENCES genomes(genome_id)
            ) WITHOUT ROWID;
        ''')

        upsert_genome = '''
            INSERT INTO genomes (
                genome_id, organism, source_record_count, source_feature_call_count,
                train_label_records, validation_label_records, test_label_records
            ) VALUES (?, ?, 1, ?, ?, ?, ?)
            ON CONFLICT(genome_id) DO UPDATE SET
                organism = CASE
                    WHEN genomes.organism_conflict = 1 THEN NULL
                    WHEN excluded.organism IS NULL THEN genomes.organism
                    WHEN genomes.organism IS NULL THEN excluded.organism
                    WHEN genomes.organism = excluded.organism THEN genomes.organism
                    ELSE NULL
                END,
                organism_conflict = CASE
                    WHEN genomes.organism_conflict = 1 THEN 1
                    WHEN genomes.organism IS NOT NULL AND excluded.organism IS NOT NULL
                         AND genomes.organism <> excluded.organism THEN 1
                    ELSE 0
                END,
                source_record_count = genomes.source_record_count + 1,
                source_feature_call_count = genomes.source_feature_call_count + excluded.source_feature_call_count,
                train_label_records = genomes.train_label_records + excluded.train_label_records,
                validation_label_records = genomes.validation_label_records + excluded.validation_label_records,
                test_label_records = genomes.test_label_records + excluded.test_label_records
        '''

        with input_path.open('rb') as source, connection:
            for raw_line in source:
                source_digest.update(raw_line)
                if not raw_line.strip():
                    continue
                record = json.loads(raw_line)
                source_records += 1
                genome_id = str(record.get('genome_id') or '').strip()
                if not genome_id:
                    continue

                source_genomes.add(genome_id)
                if genome_id in prior_ids:
                    prior_overlap.add(genome_id)

                calls = record.get('resistance_feature_calls')
                calls = calls if isinstance(calls, list) else []
                if calls:
                    rows_with_calls += 1
                products = {
                    normalize(call.get('product'))
                    for call in calls
                    if isinstance(call, dict) and normalize(call.get('product')) in known_products
                }

                label = normalize(record.get('label'))
                is_eligible_label = record.get('evidence_class') == 'laboratory' and label in {'resistant', 'susceptible'}
                fold = genome_fold(genome_id) if is_eligible_label else None
                train_count = int(fold is not None and fold < 7)
                validation_count = int(fold == 7)
                test_count = int(fold is not None and fold >= 8)
                connection.execute(
                    upsert_genome,
                    (genome_id, normalize(record.get('organism')) or None, len(calls), train_count, validation_count, test_count),
                )
                if products:
                    connection.executemany(
                        'INSERT OR IGNORE INTO genome_products (genome_id, product) VALUES (?, ?)',
                        ((genome_id, product) for product in products),
                    )

        connection.execute('''
            UPDATE genomes
            SET product_count = (
                SELECT count(*) FROM genome_products WHERE genome_products.genome_id = genomes.genome_id
            )
        ''')
        connection.executemany(
            'INSERT INTO catalog_meta (key, value) VALUES (?, ?)',
            [
                ('catalog_version', CATALOG_VERSION),
                ('model_version', MODEL_VERSION),
                ('dataset_version', DATASET_VERSION),
                ('dataset_sha256', DATASET_SHA256),
                ('feature_vocabulary_version', vocabulary['vocabulary_version']),
                ('feature_vocabulary_sha256', vocabulary['sha256']),
                ('source_records', str(source_records)),
                ('source_records_with_feature_calls', str(rows_with_calls)),
                ('source_genome_count', str(len(source_genomes))),
                ('source_artifact_sha256', source_digest.hexdigest()),
                ('source_snapshot_sha256', raw_source_sha256),
            ],
        )
        connection.execute('''
            UPDATE genomes SET serving_eligible = 1
            WHERE organism_conflict = 0
              AND organism IN ({})
              AND product_count > 0
              AND train_label_records = 0
              AND validation_label_records = 0
        '''.format(','.join('?' for _ in known_organisms)), sorted(known_organisms))
        connection.execute('CREATE INDEX idx_genomes_serving_organism ON genomes(serving_eligible, organism, genome_id)')
        connection.execute('CREATE INDEX idx_genomes_serving_id ON genomes(serving_eligible, genome_id)')

        counts = {
            'source_genome_count': count(connection, 'SELECT count(*) FROM genomes'),
            'model_compatible_genome_count': count(connection, 'SELECT count(*) FROM genomes WHERE organism_conflict = 0 AND product_count > 0'),
            'serving_genome_count': count(connection, 'SELECT count(*) FROM genomes WHERE serving_eligible = 1'),
            'held_out_test_genome_count': count(connection, 'SELECT count(*) FROM genomes WHERE serving_eligible = 1 AND test_label_records > 0'),
            'unlabeled_genome_count': count(connection, 'SELECT count(*) FROM genomes WHERE serving_eligible = 1 AND test_label_records = 0'),
            'excluded_train_validation_genome_count': count(connection, 'SELECT count(*) FROM genomes WHERE train_label_records > 0 OR validation_label_records > 0'),
            'organism_conflict_genome_count': count(connection, 'SELECT count(*) FROM genomes WHERE organism_conflict = 1'),
            'prior_10k_genome_overlap_count': len(prior_overlap),
        }
        prior_overlap_train = 0
        prior_overlap_validation = 0
        for genome_id in prior_overlap:
            row = connection.execute(
                'SELECT train_label_records, validation_label_records FROM genomes WHERE genome_id = ?',
                (genome_id,),
            ).fetchone()
            if row:
                prior_overlap_train += int(row[0] > 0)
                prior_overlap_validation += int(row[1] > 0)
        counts['prior_10k_overlap_training_genome_count'] = prior_overlap_train
        counts['prior_10k_overlap_validation_genome_count'] = prior_overlap_validation
        integrity = connection.execute('PRAGMA integrity_check').fetchone()[0]
        if integrity != 'ok':
            raise RuntimeError(f'Generated genome catalog failed SQLite integrity check: {integrity}')
        connection.commit()
        connection.close()

        database_sha256 = sha256_file(temporary_path)
        result_manifest = {
            'catalog_version': CATALOG_VERSION,
            'catalog_sha256': database_sha256,
            'source_snapshot': {
                'name': source_snapshot['name'],
                'url': source_snapshot['url'],
                'accessed_at': source_snapshot.get('accessed_at'),
                'version': source_snapshot.get('version'),
                'sha256': raw_source_sha256,
            },
            'enriched_source': {
                'name': str(input_path.relative_to(ROOT)),
                'sha256': source_digest.hexdigest(),
                'enrichment_report_sha256': sha256_file(ENRICHMENT_REPORT_PATH),
            },
            'source_scope': 'Precomputed BV-BRC resistance-product calls from the capped 2M export; training/validation genomes are excluded from serving.',
            'source_records': source_records,
            'source_records_with_feature_calls': rows_with_calls,
            **counts,
            'model_version': MODEL_VERSION,
            'dataset_version': DATASET_VERSION,
            'dataset_sha256': DATASET_SHA256,
            'feature_vocabulary_version': vocabulary['vocabulary_version'],
            'feature_vocabulary_sha256': vocabulary['sha256'],
        }
        result_manifest['manifest_sha256'] = hashlib.sha256(canonical_json(result_manifest)).hexdigest()
        temporary_manifest = manifest_path.with_suffix(manifest_path.suffix + '.tmp')
        temporary_manifest.write_bytes(canonical_json(result_manifest) + b'\n')
        os.replace(temporary_path, output_path)
        os.replace(temporary_manifest, manifest_path)
        return result_manifest
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description='Build a 2M-cohort SQLite genome feature catalog.')
    parser.add_argument('--input', type=Path, default=DEFAULT_INPUT_PATH)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT_PATH)
    parser.add_argument('--prior-catalog', type=Path, default=PRIOR_CATALOG_PATH)
    args = parser.parse_args()
    result = build_catalog(args.input, args.output, args.prior_catalog)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()