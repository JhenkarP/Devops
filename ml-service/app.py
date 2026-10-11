import hashlib
import json
import os
import re
import sqlite3
from contextlib import closing
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from joblib import load
from sklearn.feature_extraction import FeatureHasher
from pydantic import BaseModel, Field, field_validator
from hpo_service import (
    HPO_MODEL_VERSION,
    HpoNormalizationError,
    normalize_hpo_inputs,
    rank_hpo_ids,
    rare_disease_metadata,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODEL_PATH = Path(os.environ.get('AMR_MODEL_PATH', PROJECT_ROOT / 'data/models/amr_feature_baseline.joblib'))
REPORT_PATH = Path(os.environ.get('AMR_MODEL_REPORT_PATH', PROJECT_ROOT / 'data/models/amr_feature_baseline_metrics.json'))
VOCABULARY_PATH = Path(os.environ.get('AMR_VOCABULARY_PATH', PROJECT_ROOT / 'data/models/amr_feature_vocabulary.json'))
GENOME_CATALOG_PATH = Path(os.environ.get('AMR_GENOME_CATALOG_PATH', PROJECT_ROOT / 'data/models/amr_genome_catalog.sqlite'))
GENOME_CATALOG_MANIFEST_PATH = Path(os.environ.get(
    'AMR_GENOME_CATALOG_MANIFEST_PATH',
    PROJECT_ROOT / 'data/models/amr_genome_catalog.manifest.json',
))
EXPECTED_MODEL_VERSION = os.environ.get('AMR_MODEL_VERSION', 'amr-sgd-feature-baseline-1')
EXPECTED_MODEL_SHA256 = os.environ.get(
    'AMR_MODEL_SHA256',
    '829b68359ac0b2d65cf22be19643be4435c786d0e8aade40af94ba58bf9b94d9',
)
DATASET_VERSION = os.environ.get('AMR_DATASET_VERSION', 'amr-baseline-cohort-a3c7b549296846c1')
DATASET_SHA256 = os.environ.get(
    'AMR_DATASET_SHA256',
    'a3c7b549296846c61eca74d2733c048fcbf1a2aa809f11c86fe673e7bdf6141e',
)
EXPECTED_VOCABULARY_SHA256 = os.environ.get(
    'AMR_VOCABULARY_SHA256',
    'd0712991dc7feb9de593ec68baa10d63fedf398105edea99e5385d4c3fc5701c',
)
SCOPE_PATH = Path(os.environ.get('AMR_SCOPE_PATH', PROJECT_ROOT / 'data/models/amr_scope.json'))
SEQUENCE_MODEL_PATH = Path(os.environ.get('SEQUENCE_MODEL_PATH', PROJECT_ROOT / 'data/models/sequence_amr.joblib'))
SEQUENCE_MODEL_REPORT_PATH = Path(os.environ.get('SEQUENCE_MODEL_REPORT_PATH', PROJECT_ROOT / 'data/models/sequence_amr_metrics.json'))
CAVEAT = (
    'Research baseline only; its raw score is not a calibrated probability and must not guide treatment. '
    'Confirm susceptibility with laboratory testing. The reported split does not establish performance '
    'on unseen physical laboratories.'
)

app = FastAPI(title='SignalLab ML service', version='0.2.0')


class AMRRequest(BaseModel):
    organism: str = Field(min_length=1, max_length=200)
    antibiotic: str = Field(min_length=1, max_length=200)
    products: list[str] = Field(default_factory=list, max_length=100)

    @field_validator('organism', 'antibiotic')
    @classmethod
    def normalize_category(cls, value: str) -> str:
        return re.sub(r'\s+', ' ', value.strip().lower())

    @field_validator('products')
    @classmethod
    def normalize_products(cls, values: list[str]) -> list[str]:
        normalized = []
        for value in values:
            product = re.sub(r'\s+', ' ', value.strip().lower())
            if not product:
                continue
            if len(product) > 300:
                raise ValueError('Each resistance product must be 300 characters or fewer.')
            if product not in normalized:
                normalized.append(product)
        return normalized


class AMRGenomePanelRequest(BaseModel):
    genome_id: str = Field(min_length=1, max_length=100, pattern=r'^\d+\.\d+$')

    @field_validator('genome_id')
    @classmethod
    def normalize_genome_id(cls, value: str) -> str:
        return value.strip()


class SequencePredictionRequest(BaseModel):
    organism: str = Field(min_length=1, max_length=200)
    antibiotic: str = Field(min_length=1, max_length=200)
    features: list[dict] = Field(default_factory=list, max_length=10000)
    taxonomy_status: str = Field(default='not_verified')
    assembly_quality_status: str = Field(default='not_assessed')

    @field_validator('organism', 'antibiotic')
    @classmethod
    def normalize_sequence_categories(cls, value: str) -> str:
        return re.sub(r'\s+', ' ', value.strip().lower())


class HpoNormalizeRequest(BaseModel):
    phenotypes: list[str] = Field(min_length=1, max_length=100)

    @field_validator('phenotypes')
    @classmethod
    def validate_phenotypes(cls, values: list[str]) -> list[str]:
        normalized = [value.strip() for value in values]
        if any(not value for value in normalized):
            raise ValueError('Phenotype terms cannot be empty.')
        return normalized


class HpoRankRequest(BaseModel):
    hpo_ids: list[str] = Field(min_length=1, max_length=100)
    top_k: int = Field(default=10, ge=1, le=50)

    @field_validator('hpo_ids')
    @classmethod
    def validate_hpo_ids(cls, values: list[str]) -> list[str]:
        return [value.strip().upper() for value in values]


@lru_cache(maxsize=1)
def load_amr_baseline() -> tuple[dict, dict, str]:
    if not MODEL_PATH.is_file() or not REPORT_PATH.is_file():
        raise RuntimeError('AMR model artifact or evaluation report is missing.')

    artifact_sha256 = hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest()
    if artifact_sha256 != EXPECTED_MODEL_SHA256:
        raise RuntimeError('AMR model artifact checksum does not match the configured version.')

    bundle = load(MODEL_PATH)
    report = json.loads(REPORT_PATH.read_text(encoding='utf-8'))
    if bundle.get('version') != EXPECTED_MODEL_VERSION or report.get('model_version') != EXPECTED_MODEL_VERSION:
        raise RuntimeError('AMR model artifact and evaluation report versions do not match configuration.')
    return bundle, report, artifact_sha256


@lru_cache(maxsize=1)
def load_sequence_model() -> tuple[dict, dict, str]:
    if not SEQUENCE_MODEL_PATH.is_file() or not SEQUENCE_MODEL_REPORT_PATH.is_file():
        raise RuntimeError('Sequence-native model artifact or evaluation report is missing.')
    artifact = load(SEQUENCE_MODEL_PATH)
    report = json.loads(SEQUENCE_MODEL_REPORT_PATH.read_text(encoding='utf-8'))
    if artifact.get('model_type') != 'sequence_determinant_amr_sgd' or report.get('model_type') != artifact['model_type']:
        raise RuntimeError('Sequence-native model artifact and evaluation report are incompatible.')
    if artifact.get('calibration_status') != 'calibrated' or report.get('calibration_status') != 'calibrated':
        raise RuntimeError('Sequence-native model is not calibrated.')
    return artifact, report, sha256_file(SEQUENCE_MODEL_PATH)


@lru_cache(maxsize=1)
def load_amr_vocabulary() -> dict:
    if not VOCABULARY_PATH.is_file():
        raise RuntimeError('AMR feature vocabulary is missing.')

    vocabulary = json.loads(VOCABULARY_PATH.read_text(encoding='utf-8'))
    expected_hash = vocabulary.get('sha256')
    payload = {key: value for key, value in vocabulary.items() if key != 'sha256'}
    encoded = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode('utf-8')
    actual_hash = hashlib.sha256(encoded).hexdigest()
    if actual_hash != expected_hash or actual_hash != EXPECTED_VOCABULARY_SHA256:
        raise RuntimeError('AMR feature vocabulary checksum does not match the configured version.')
    if vocabulary.get('model_version') != EXPECTED_MODEL_VERSION:
        raise RuntimeError('AMR feature vocabulary belongs to a different model version.')
    if vocabulary.get('dataset_version') != DATASET_VERSION or vocabulary.get('source_sha256') != DATASET_SHA256:
        raise RuntimeError('AMR feature vocabulary belongs to a different dataset version.')
    return vocabulary


@lru_cache(maxsize=1)
def load_amr_scope() -> dict:
    if not SCOPE_PATH.is_file():
        raise RuntimeError('AMR scope configuration is missing.')
    scope = json.loads(SCOPE_PATH.read_text(encoding='utf-8'))
    if not scope.get('scope_version') or not scope.get('organism') or not scope.get('pairs'):
        raise RuntimeError('AMR scope configuration is incomplete.')
    return scope


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


@lru_cache(maxsize=1)
def load_amr_genome_catalog() -> dict:
    if not GENOME_CATALOG_PATH.is_file() or not GENOME_CATALOG_MANIFEST_PATH.is_file():
        raise RuntimeError('AMR genome SQLite catalog or its manifest is missing; run data:build:amr-genome-catalog.')

    catalog = json.loads(GENOME_CATALOG_MANIFEST_PATH.read_text(encoding='utf-8'))
    expected_manifest_hash = catalog.get('manifest_sha256')
    manifest_payload = {key: value for key, value in catalog.items() if key != 'manifest_sha256'}
    actual_manifest_hash = hashlib.sha256(
        json.dumps(manifest_payload, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8'),
    ).hexdigest()
    if actual_manifest_hash != expected_manifest_hash:
        raise RuntimeError('AMR genome catalog manifest checksum does not match its contents.')

    if sha256_file(GENOME_CATALOG_PATH) != catalog.get('catalog_sha256'):
        raise RuntimeError('AMR genome SQLite catalog checksum does not match its manifest.')

    vocabulary = load_amr_vocabulary()
    if catalog.get('catalog_version') != 'amr-bvbrc-genome-catalog-2m-v1':
        raise RuntimeError('AMR genome feature catalog version is unsupported.')
    if catalog.get('model_version') != EXPECTED_MODEL_VERSION:
        raise RuntimeError('AMR genome feature catalog belongs to a different model version.')
    if catalog.get('dataset_version') != DATASET_VERSION or catalog.get('dataset_sha256') != DATASET_SHA256:
        raise RuntimeError('AMR genome feature catalog belongs to a different training dataset.')
    if catalog.get('feature_vocabulary_version') != vocabulary['vocabulary_version']:
        raise RuntimeError('AMR genome feature catalog belongs to a different feature vocabulary.')
    if catalog.get('feature_vocabulary_sha256') != vocabulary['sha256']:
        raise RuntimeError('AMR genome feature catalog vocabulary checksum does not match.')
    return catalog


def open_amr_genome_catalog() -> sqlite3.Connection:
    return sqlite3.connect(f'{GENOME_CATALOG_PATH.as_uri()}?mode=ro', uri=True)


def vocabulary_response(query: str | None = None, limit: int = 50) -> dict:
    vocabulary = load_amr_vocabulary()
    scope = load_amr_scope()
    products = vocabulary['products']
    if query:
        normalized_query = re.sub(r'\s+', ' ', query.strip().lower())
        products = [product for product in products if normalized_query in product][:limit]
    return {
        'vocabulary_version': vocabulary['vocabulary_version'],
        'model_version': vocabulary['model_version'],
        'dataset_version': vocabulary['dataset_version'],
        'source_sha256': vocabulary['source_sha256'],
        'source_split': vocabulary['source_split'],
        'source_records': vocabulary['source_records'],
        'sha256': vocabulary['sha256'],
        'organisms': vocabulary['organisms'],
        'antibiotics': vocabulary['antibiotics'],
        'products': products,
        'scope_version': scope['scope_version'],
        'scope_status': scope['status'],
        'scope_organism': scope['organism'],
        'scope_pairs': scope['pairs'],
        'scope_limitations': scope['limitations'],
    }


@app.get('/health')
def health():
    try:
        _, _, artifact_sha256 = load_amr_baseline()
        vocabulary = load_amr_vocabulary()
        scope = load_amr_scope()
        catalog = load_amr_genome_catalog()
        hpo_metadata = rare_disease_metadata()
    except Exception as error:
        raise HTTPException(status_code=503, detail=f'Model dependencies unavailable: {error}') from error
    return {
        'service': 'signallab-ml',
        'status': 'ready',
        'model_version': EXPECTED_MODEL_VERSION,
        'model_sha256': artifact_sha256,
        'dataset_version': DATASET_VERSION,
        'dataset_sha256': DATASET_SHA256,
        'vocabulary_version': vocabulary['vocabulary_version'],
        'vocabulary_sha256': vocabulary['sha256'],
        'amr_scope_version': scope['scope_version'],
        'genome_catalog_version': catalog['catalog_version'],
        'genome_catalog_sha256': catalog['catalog_sha256'],
        'evaluation_mode': 'trained_baseline_uncalibrated',
        'rare_disease_model_version': hpo_metadata['model_version'],
        'rare_disease_dataset_version': hpo_metadata['dataset_version'],
    }


@app.get('/rare-disease/metadata')
def get_rare_disease_metadata():
    try:
        return rare_disease_metadata()
    except Exception as error:
        raise HTTPException(status_code=503, detail='HPO artifacts are not ready.') from error


@app.post('/rare-disease/normalize')
def normalize_rare_disease_phenotypes(request: HpoNormalizeRequest):
    try:
        result = normalize_hpo_inputs(request.phenotypes)
    except Exception as error:
        raise HTTPException(status_code=503, detail='HPO normalization resources are not ready.') from error
    unresolved = [item for item in result['normalization'] if item['match_type'] in {'ambiguous', 'unmatched'}]
    if unresolved:
        raise HTTPException(status_code=422, detail={
            'message': 'Resolve every ambiguous or unmatched phenotype; no disease ranking was performed.',
            'normalization': result['normalization'],
        })
    return result


@app.post('/rare-disease/rank')
def rank_rare_disease(request: HpoRankRequest):
    try:
        result = rank_hpo_ids(request.hpo_ids, request.top_k)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=503, detail='HPO ranking resources are not ready.') from error
    if result['model_version'] != HPO_MODEL_VERSION:
        raise HTTPException(status_code=503, detail='HPO ranker version is inconsistent.')
    return result


@app.get('/amr/vocabulary')
def get_amr_vocabulary(q: str | None = None, limit: int = Query(default=50, ge=1, le=100)):
    try:
        return vocabulary_response(q, limit)
    except Exception as error:
        raise HTTPException(status_code=503, detail='AMR feature vocabulary is not ready.') from error


@app.get('/amr/genomes')
def get_amr_genomes(q: str | None = None, limit: int = Query(default=25, ge=1, le=50)):
    try:
        catalog = load_amr_genome_catalog()
        vocabulary = load_amr_vocabulary()
    except Exception as error:
        raise HTTPException(status_code=503, detail='AMR genome catalog is not ready.') from error

    query = re.sub(r'\s+', ' ', q.strip().lower()) if q else ''
    escaped_query = query.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    genome_pattern = f'{escaped_query}%'
    organism_pattern = f'%{escaped_query}%'
    organism_placeholders = ','.join('?' for _ in vocabulary['organisms'])
    predicate = f'''serving_eligible = 1 AND organism IN ({organism_placeholders})
        AND (? = '' OR genome_id LIKE ? ESCAPE '\\' OR organism LIKE ? ESCAPE '\\')'''
    values = [*vocabulary['organisms'], query, genome_pattern, organism_pattern]
    with closing(open_amr_genome_catalog()) as connection:
        total = connection.execute(f'SELECT count(*) FROM genomes WHERE {predicate}', values).fetchone()[0]
        rows = connection.execute(
            f'''SELECT genome_id, organism, product_count FROM genomes
                WHERE {predicate} ORDER BY organism, genome_id LIMIT ?''',
            [*values, limit],
        ).fetchall()
    matches = [
        {'genome_id': genome_id, 'organism': organism, 'detected_product_count': product_count}
        for genome_id, organism, product_count in rows
    ]
    return {
        'catalog_version': catalog['catalog_version'],
        'catalog_sha256': catalog['catalog_sha256'],
        'total': total,
        'genomes': matches,
    }


@app.post('/amr/predict')
def predict_amr(request: AMRRequest):
    try:
        bundle, report, artifact_sha256 = load_amr_baseline()
        vocabulary = load_amr_vocabulary()
        scope = load_amr_scope()
    except Exception as error:
        raise HTTPException(status_code=503, detail='AMR model is not ready.') from error

    unknown_organisms = [request.organism] if request.organism not in vocabulary['organisms'] else []
    unknown_antibiotics = [request.antibiotic] if request.antibiotic not in vocabulary['antibiotics'] else []
    unknown_products = [product for product in request.products if product not in vocabulary['products']]
    in_scope = scope['organism'] == request.organism and any(pair['antibiotic'] == request.antibiotic for pair in scope['pairs'])
    if unknown_organisms or unknown_antibiotics or unknown_products or not in_scope:
        raise HTTPException(status_code=422, detail={
            'message': 'Input contains values outside the trained model vocabulary; no prediction was made.',
            'unknown_organisms': unknown_organisms,
            'unknown_antibiotics': unknown_antibiotics,
            'unknown_products': unknown_products,
            'vocabulary_version': vocabulary['vocabulary_version'],
            'scope_version': scope['scope_version'],
            'scope_organism': scope['organism'],
            'scope_antibiotics': [pair['antibiotic'] for pair in scope['pairs']],
        })

    features = {
        f'antibiotic={request.antibiotic}': 1.0,
        f'organism={request.organism}': 1.0,
        'has_resistance_feature_calls': 1.0 if request.products else 0.0,
    }
    features.update({f'resistance_product={product}': 1.0 for product in request.products})
    matrix = bundle['hasher'].transform([features])
    class_labels = list(bundle['model'].classes_)
    if 0 not in class_labels or 1 not in class_labels:
        raise HTTPException(status_code=503, detail='AMR model does not have both resistant and susceptible classes.')

    score = float(bundle['model'].predict_proba(matrix)[0, class_labels.index(1)])
    threshold = float(report['validation']['threshold'])
    test_metrics = report.get('test', {})
    return {
        'prediction': 'Resistance signal' if score >= threshold else 'Below validation-selected threshold',
        'resistance_score': score,
        'score_semantics': 'Uncalibrated model score; not a probability.',
        'decision_threshold': threshold,
        'evidence': request.products or ['No resistance-product features supplied'],
        'caveat': CAVEAT,
        'evaluation': {
            'split_by': report['cohort_summary'].get('split_by'),
            'test_records': test_metrics.get('records'),
            'test_auroc': test_metrics.get('auroc'),
            'test_auprc': test_metrics.get('auprc'),
            'test_expected_calibration_error': test_metrics.get('expected_calibration_error'),
            'limitations': report.get('limitations', []),
        },
        'evaluation_mode': 'trained_baseline_uncalibrated',
        'model_version': EXPECTED_MODEL_VERSION,
        'model_sha256': artifact_sha256,
        'feature_vocabulary_version': vocabulary['vocabulary_version'],
        'feature_vocabulary_sha256': vocabulary['sha256'],
        'dataset_version': DATASET_VERSION,
        'dataset_sha256': DATASET_SHA256,
    }


@app.post('/amr/sequence/predict')
def predict_sequence_amr(request: SequencePredictionRequest):
    if request.taxonomy_status != 'verified':
        raise HTTPException(status_code=422, detail='Taxonomy verification is required before sequence-native prediction.')
    if request.assembly_quality_status != 'passed':
        raise HTTPException(status_code=422, detail='Assembly-quality gate must pass before sequence-native prediction.')
    try:
        artifact, report, model_sha256 = load_sequence_model()
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    model = artifact.get('models', {}).get(request.antibiotic)
    if model is None:
        raise HTTPException(status_code=422, detail=f'No trained sequence-native model exists for {request.antibiotic}.')
    values = {'organism=' + request.organism: 1.0, 'has_sequence_features': float(bool(request.features))}
    for feature in request.features:
        determinant = str(feature.get('determinant', '')).strip().lower()
        kind = str(feature.get('type', 'unknown')).strip().lower()
        if determinant:
            values[f'sequence_{kind}={determinant}'] = 1.0
    scores = model.predict_proba(FeatureHasher(n_features=artifact.get('hasher_features', 2**18), input_type='dict', alternate_sign=False).transform([values]))[0]
    classes = list(model.classes_)
    score = float(scores[classes.index(1)])
    threshold = float(artifact.get('decision_thresholds', {}).get(request.antibiotic, 0.5))
    return {
        'prediction': 'Resistance signal' if score >= threshold else 'Below validation-selected threshold',
        'resistance_probability': score,
        'score_semantics': 'Calibrated validation-held-out model probability; research use only.',
        'decision_threshold': threshold,
        'model_version': artifact.get('model_type'),
        'model_sha256': model_sha256,
        'evaluation': report.get('pairs', {}).get(request.antibiotic, {}),
        'caveat': 'This is not a treatment recommendation and requires laboratory confirmation.',
    }


@app.post('/amr/genome-panel')
def predict_amr_genome_panel(request: AMRGenomePanelRequest):
    try:
        bundle, report, artifact_sha256 = load_amr_baseline()
        vocabulary = load_amr_vocabulary()
        catalog = load_amr_genome_catalog()
        scope = load_amr_scope()
    except Exception as error:
        raise HTTPException(status_code=503, detail='AMR genome-analysis dependencies are not ready.') from error

    with closing(open_amr_genome_catalog()) as connection:
        row = connection.execute(
            '''SELECT organism, organism_conflict, source_record_count, source_feature_call_count,
                      train_label_records, validation_label_records, test_label_records,
                      product_count, serving_eligible
               FROM genomes WHERE genome_id = ?''',
            (request.genome_id,),
        ).fetchone()
        products = connection.execute(
            'SELECT product FROM genome_products WHERE genome_id = ? ORDER BY product',
            (request.genome_id,),
        ).fetchall() if row else []
    if row is None:
        raise HTTPException(status_code=404, detail={
            'message': 'Genome ID is not present in the bounded BV-BRC 2M feature catalog.',
            'catalog_version': catalog['catalog_version'],
        })
    organism, organism_conflict, source_record_count, source_feature_call_count, train_count, validation_count, test_count, product_count, serving_eligible = row
    if train_count or validation_count or not serving_eligible:
        raise HTTPException(status_code=422, detail={
            'message': 'This genome has eligible training or validation labels and is withheld from new panel inference.',
            'genome_id': request.genome_id,
            'train_label_records': train_count,
            'validation_label_records': validation_count,
        })
    if organism_conflict or organism not in vocabulary['organisms']:
        raise HTTPException(status_code=422, detail={
            'message': 'The genome has no unambiguous organism supported by this model; no panel was scored.',
            'genome_id': request.genome_id,
        })
    products = [product[0] for product in products]
    if not products or len(products) != product_count:
        raise HTTPException(status_code=422, detail={
            'message': 'The genome has no resistance-product calls shared with the trained model vocabulary; no panel was scored.',
            'genome_id': request.genome_id,
            'organism': organism,
        })

    antibiotics = [pair['antibiotic'] for pair in scope['pairs'] if pair['antibiotic'] in vocabulary['antibiotics']]
    feature_rows = []
    for antibiotic in antibiotics:
        features = {
            f'antibiotic={antibiotic}': 1.0,
            f'organism={organism}': 1.0,
            'has_resistance_feature_calls': 1.0,
        }
        features.update({f'resistance_product={product}': 1.0 for product in products})
        feature_rows.append(features)

    class_labels = list(bundle['model'].classes_)
    if 1 not in class_labels:
        raise HTTPException(status_code=503, detail='AMR model has no resistant class.')
    scores = bundle['model'].predict_proba(bundle['hasher'].transform(feature_rows))[:, class_labels.index(1)]
    threshold = float(report['validation']['threshold'])
    test_metrics = report.get('test', {})
    organism_pair_metrics = test_metrics.get('by_organism_antibiotic', {}).get(organism, {})
    panel = [
        {
            'antibiotic': antibiotic,
            'predicted_phenotype': 'R' if score >= threshold else 'S',
            'resistance_score': float(score),
            'resistance_signal_flagged': bool(score >= threshold),
            'interpretation': 'Resistance signal flagged' if score >= threshold else 'No resistance signal flagged; susceptibility is not established',
            'pair_evaluation': _pair_evaluation_summary(organism_pair_metrics.get(antibiotic)),
        }
        for antibiotic, score in zip(antibiotics, scores)
    ]
    panel.sort(key=lambda item: (-item['resistance_score'], item['antibiotic']))
    return {
        'genome_id': request.genome_id,
        'organism': organism,
        'detected_products': products,
        'source_feature_call_count': source_feature_call_count,
        'source_record_count': source_record_count,
        'genome_data_partition': 'held_out_test' if test_count else 'no_eligible_laboratory_label',
        'antibiotic_panel': panel,
        'flagged_count': sum(item['resistance_signal_flagged'] for item in panel),
        'predicted_resistant_count': sum(item['predicted_phenotype'] == 'R' for item in panel),
        'predicted_susceptible_count': sum(item['predicted_phenotype'] == 'S' for item in panel),
        'panel_count': len(panel),
        'score_semantics': 'Uncalibrated model score; not a probability.',
        'decision_threshold': threshold,
        'caveat': (
            'Research-only genome-ID lookup using precomputed BV-BRC resistance-product calls. '
            'R/S are model-predicted classes at the validation-selected threshold, not measured AST results. '
            'This panel is not a ranking of effective drugs. A predicted S does not establish susceptibility or antibiotic effectiveness and is not a treatment recommendation. '
            'Confirm every result with laboratory testing.'
        ),
        'evaluation': {
            'split_by': report['cohort_summary'].get('split_by'),
            'test_records': test_metrics.get('records'),
            'test_auroc': test_metrics.get('auroc'),
            'test_auprc': test_metrics.get('auprc'),
            'test_expected_calibration_error': test_metrics.get('expected_calibration_error'),
            'test_brier_score': test_metrics.get('brier_score'),
            'test_confidence_intervals_95': test_metrics.get('bootstrap_confidence_intervals_95', {}),
            'source_overlap_audit': report['cohort_summary'].get('source_overlap_audit', {}),
            'subgroup_evaluation': report.get('subgroup_evaluation', {}),
            'limitations': report.get('limitations', []),
        },
        'evaluation_mode': 'trained_baseline_uncalibrated',
        'model_version': EXPECTED_MODEL_VERSION,
        'model_sha256': artifact_sha256,
        'feature_vocabulary_version': vocabulary['vocabulary_version'],
        'feature_vocabulary_sha256': vocabulary['sha256'],
        'dataset_version': DATASET_VERSION,
        'dataset_sha256': DATASET_SHA256,
        'genome_catalog_version': catalog['catalog_version'],
        'genome_catalog_sha256': catalog['catalog_sha256'],
        'genome_source_sha256': catalog['enriched_source']['sha256'],
        'genome_source_snapshot': catalog['source_snapshot'],
    }


def _pair_evaluation_summary(metrics: dict | None) -> dict:
    if metrics is None:
        return {
            'records': 0,
            'resistant_records': 0,
            'susceptible_records': 0,
            'support_status': 'not_assessed',
            'auroc': None,
            'auprc': None,
            'brier_score': None,
            'expected_calibration_error': None,
            'sensitivity': None,
            'specificity': None,
            'confidence_intervals_95': {
                'auroc': None,
                'auprc': None,
                'sensitivity': None,
                'specificity': None,
                'brier_score': None,
                'expected_calibration_error': None,
            },
        }
    intervals = metrics.get('confidence_intervals_95', {})
    return {
        'records': metrics.get('records', 0),
        'resistant_records': metrics.get('resistant_records', 0),
        'susceptible_records': metrics.get('susceptible_records', 0),
        'support_status': metrics.get('support_status', 'insufficient_support'),
        'auroc': metrics.get('auroc'),
        'auprc': metrics.get('auprc'),
        'brier_score': metrics.get('brier_score'),
        'expected_calibration_error': metrics.get('expected_calibration_error'),
        'sensitivity': metrics.get('sensitivity'),
        'specificity': metrics.get('specificity'),
        'confidence_intervals_95': {
            'auroc': intervals.get('auroc'),
            'auprc': intervals.get('auprc'),
            'sensitivity': intervals.get('sensitivity'),
            'specificity': intervals.get('specificity'),
            'brier_score': intervals.get('brier_score'),
            'expected_calibration_error': intervals.get('expected_calibration_error'),
        },
    }
