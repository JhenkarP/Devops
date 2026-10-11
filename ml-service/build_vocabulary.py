import argparse
import hashlib
import json
import re
from pathlib import Path


def normalize(value: str) -> str:
    return re.sub(r'\s+', ' ', value.strip().lower())


def canonical_sha256(value: dict) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def build_vocabulary(cohort_path: Path, model_version: str, dataset_version: str) -> dict:
    source_sha256 = hashlib.sha256(cohort_path.read_bytes()).hexdigest()
    organisms = set()
    antibiotics = set()
    products = set()
    training_records = 0

    with cohort_path.open(encoding='utf-8') as cohort_file:
        for line in cohort_file:
            record = json.loads(line)
            if record.get('split') != 'train':
                continue
            training_records += 1
            organisms.add(normalize(record['organism']))
            antibiotics.add(normalize(record['antibiotic']))
            products.update(
                normalize(product)
                for product in record.get('products', [])
                if isinstance(product, str) and product.strip()
            )

    vocabulary = {
        'vocabulary_version': 'amr-feature-vocabulary-1',
        'model_version': model_version,
        'dataset_version': dataset_version,
        'source_sha256': source_sha256,
        'source_split': 'train',
        'source_records': training_records,
        'normalization': 'lowercase; trim and collapse consecutive whitespace',
        'organisms': sorted(organisms),
        'antibiotics': sorted(antibiotics),
        'products': sorted(products),
    }
    vocabulary['sha256'] = canonical_sha256(vocabulary)
    return vocabulary


def main() -> None:
    parser = argparse.ArgumentParser(description='Build the AMR model feature vocabulary from its training split.')
    parser.add_argument('--cohort', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--model-version', required=True)
    parser.add_argument('--dataset-version', required=True)
    parser.add_argument('--expected-source-sha256')
    args = parser.parse_args()

    vocabulary = build_vocabulary(args.cohort, args.model_version, args.dataset_version)
    if args.expected_source_sha256 and vocabulary['source_sha256'] != args.expected_source_sha256.lower():
        raise SystemExit('Cohort checksum does not match the expected dataset artifact.')

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(vocabulary, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({
        'output': str(args.output),
        'sha256': vocabulary['sha256'],
        'source_sha256': vocabulary['source_sha256'],
        'source_records': vocabulary['source_records'],
        'organisms': len(vocabulary['organisms']),
        'antibiotics': len(vocabulary['antibiotics']),
        'products': len(vocabulary['products']),
    }, indent=2))


if __name__ == '__main__':
    main()