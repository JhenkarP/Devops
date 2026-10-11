import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  API_CONTRACT,
  API_ENDPOINTS,
  API_VERSION_HEADER,
  validateRequest,
  validateResponse,
} from '../backend/api-contract.js';

const files = ['src/main.jsx', 'backend/server.js', 'ml-service/app.py', 'docker-compose.yml', '.env.example'];
for (const file of files) {
  await readFile(new URL(`../${file}`, import.meta.url));
  console.log(`OK ${file}`);
}

const frontend = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const backend = await readFile(new URL('../backend/server.js', import.meta.url), 'utf8');
const contractSource = await readFile(new URL('../backend/api-contract.js', import.meta.url), 'utf8');

assert.equal(API_CONTRACT.version, '1.1.0');
assert.ok(backend.includes('API_VERSION_HEADER'));
assert.ok(frontend.includes('API_VERSION_HEADER'));

for (const [name, endpoint] of Object.entries(API_ENDPOINTS)) {
  assert.ok(contractSource.includes(endpoint.path), `Contract source must declare ${endpoint.path}`);
  assert.ok(backend.includes(`API_ENDPOINTS.${name}.path`), `Backend must register ${name} from the contract`);
}

for (const route of ['amrVocabulary', 'amrGenomes', 'amrSequenceStatus', 'amrSequencePreflight', 'amrPredict', 'amrGenomePanel', 'rareDiseaseRank', 'analyses', 'analysisDetail', 'analysisFeedback']) {
  assert.ok(frontend.includes(`API_ENDPOINTS.${route}.path`), `Frontend must use the shared ${route} contract`);
}

assert.deepEqual(validateRequest('amrPredictRequest', {
  organism: 'Klebsiella pneumoniae',
  antibiotic: 'meropenem',
  products: ['resistance protein'],
}), []);
assert.deepEqual(validateRequest('amrGenomePanelRequest', { genome_id: '573.23123' }), []);
assert.ok(validateRequest('amrGenomePanelRequest', { genome_id: 'not-a-genome-id' }).length);
assert.ok(validateRequest('amrPredictRequest', {
  organism: 'Klebsiella pneumoniae',
  antibiotic: 'meropenem',
  patient_id: 'not-accepted',
}).some((error) => error.includes('Unexpected field: patient_id')));
assert.ok(validateRequest('rareDiseaseRankRequest', { phenotypes: 'delay', patient_name: 'not-accepted' }).length);
assert.ok(validateRequest('reviewFeedbackRequest', { decision: 'unknown' }).length);

const validAmrResponse = {
  analysis_id: '8e638949-e3ba-4db2-a1d9-c53fc1922812',
  prediction: 'Resistance signal',
  resistance_score: 0.62,
  score_semantics: 'Uncalibrated model score; not a probability.',
  decision_threshold: 0.2,
  evidence: ['resistance protein'],
  caveat: 'Research use only.',
  evaluation: {},
  evaluation_mode: 'trained_baseline_uncalibrated',
  model_version: 'amr-sgd-feature-baseline-1',
  model_sha256: 'a'.repeat(64),
  feature_vocabulary_version: 'amr-feature-vocabulary-1',
  feature_vocabulary_sha256: 'c'.repeat(64),
  dataset_version: 'cohort-v1',
  dataset_sha256: 'b'.repeat(64),
};
assert.deepEqual(validateResponse('amrPrediction', validAmrResponse), []);
assert.ok(validateResponse('amrPrediction', { ...validAmrResponse, score_semantics: 'probability' }).length);
assert.deepEqual(validateResponse('amrSequencePreflight', {
  analysis_id: validAmrResponse.analysis_id,
  workflow: 'sequence_native',
  status: 'preflight_complete',
  preflight: { report_version: 'fasta-preflight-1' },
  caller: { status: 'not_called' },
  model: { status: 'not_called' },
}), []);
assert.deepEqual(validateResponse('amrVocabulary', {
  vocabulary_version: 'amr-feature-vocabulary-1',
  model_version: 'amr-sgd-feature-baseline-1',
  dataset_version: 'cohort-v1',
  source_sha256: 'a'.repeat(64),
  source_split: 'train',
  source_records: 54041,
  sha256: 'c'.repeat(64),
  organisms: ['species a'],
  antibiotics: ['drug a'],
  products: ['enzyme a'],
  scope_version: 'amr-initial-scope-1',
  scope_status: 'exploratory_research_scope',
  scope_organism: 'species a',
  scope_pairs: [{ antibiotic: 'drug a' }],
  scope_limitations: ['Research scope only.'],
}), []);
assert.deepEqual(validateResponse('amrGenomeList', {
  catalog_version: 'amr-bvbrc-genome-catalog-1',
  catalog_sha256: 'a'.repeat(64),
  total: 1,
  genomes: [{ genome_id: '573.23123', organism: 'species a', detected_product_count: 2 }],
}), []);
assert.deepEqual(validateResponse('amrGenomePanel', {
  analysis_id: validAmrResponse.analysis_id,
  genome_id: '573.23123',
  organism: 'species a',
  detected_products: ['enzyme a'],
  antibiotic_panel: [{
    antibiotic: 'drug a',
    predicted_phenotype: 'R',
    resistance_score: 0.4,
    resistance_signal_flagged: true,
    interpretation: 'Resistance signal flagged',
    pair_evaluation: {
      records: 40,
      resistant_records: 20,
      susceptible_records: 20,
      support_status: 'descriptive_only',
      auroc: 0.9,
      auprc: 0.9,
      brier_score: 0.1,
      expected_calibration_error: 0.1,
      sensitivity: 0.8,
      specificity: 0.85,
      confidence_intervals_95: {
        auroc: [0.75, 1],
        auprc: [0.75, 1],
        sensitivity: [0.58, 0.92],
        specificity: [0.65, 0.95],
        brier_score: [0.05, 0.2],
        expected_calibration_error: [0.02, 0.2],
      },
    },
  }],
  flagged_count: 1,
  predicted_resistant_count: 1,
  predicted_susceptible_count: 0,
  panel_count: 1,
  score_semantics: 'Uncalibrated model score; not a probability.',
  decision_threshold: 0.2,
  caveat: 'Research only.',
  evaluation: {},
  model_version: validAmrResponse.model_version,
  model_sha256: validAmrResponse.model_sha256,
  dataset_version: validAmrResponse.dataset_version,
  dataset_sha256: validAmrResponse.dataset_sha256,
  feature_vocabulary_version: validAmrResponse.feature_vocabulary_version,
  feature_vocabulary_sha256: validAmrResponse.feature_vocabulary_sha256,
  genome_catalog_version: 'amr-bvbrc-genome-catalog-1',
  genome_catalog_sha256: 'd'.repeat(64),
  genome_source_sha256: 'e'.repeat(64),
  genome_source_snapshot: {},
}), []);
assert.deepEqual(validateResponse('rareDiseaseRank', {
  analysis_id: validAmrResponse.analysis_id,
  input_hpo_ids: ['HP:0000001'],
  normalization: [{ input: 'All', hpo_id: 'HP:0000001', matched_term: 'All', match_type: 'exact_name_or_synonym', candidates: [] }],
  candidates: [{ disease_id: 'OMIM:1', disease_name: 'Example', score: 0.4, supporting_terms: [], contradiction_score: 0, unreported_profile_terms: [], unreported_profile_term_count: 0 }],
  method: 'Resnik-style similarity.',
  score_semantics: 'Relative ranking score; not a probability or clinical likelihood.',
  caveat: 'Not a diagnosis.',
  evaluation_mode: 'hpo_resnik_relative_ranking',
  model_version: 'hpo-resnik-baseline-1',
  dataset_version: 'hpo-knowledge-1234567890abcdef',
  dataset_sha256: 'a'.repeat(64),
  artifacts: {},
}), []);
assert.deepEqual(validateResponse('health', {
  service: 'signallab-api',
  status: 'ok',
  dependencies: { database: 'ok', amr_model_service: 'ok', rare_disease_inference: 'ok' },
}), []);
const savedAnalysis = {
  id: validAmrResponse.analysis_id,
  workflow: 'amr',
  status: 'completed',
  input_data: { organism: 'klebsiella pneumoniae' },
  result_data: validAmrResponse,
  error_message: null,
  model_version: validAmrResponse.model_version,
  dataset_version: validAmrResponse.dataset_version,
  created_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
};
assert.deepEqual(validateResponse('analysisDetail', {
  analysis: savedAnalysis,
  feedback: [{ id: 'feedback-1', decision: 'accept', notes: '', created_at: '2026-01-01T00:00:02.000Z' }],
}), []);
assert.deepEqual(validateResponse('reviewFeedback', {
  feedback: {
    id: 'feedback-1',
    analysis_id: savedAnalysis.id,
    decision: 'accept',
    notes: '',
    created_at: '2026-01-01T00:00:02.000Z',
  },
}), []);
assert.deepEqual(validateResponse('analysisList', { analyses: [savedAnalysis] }), []);
assert.deepEqual(validateResponse('modelList', {
  models: [{ version: 'model-1', family: 'amr', description: 'test', metadata: {}, registered_at: '2026-01-01T00:00:00.000Z' }],
}), []);
assert.deepEqual(validateResponse('datasetList', {
  datasets: [{ version: 'dataset-1', source: 'test.jsonl', sha256: null, metadata: {}, registered_at: '2026-01-01T00:00:00.000Z' }],
}), []);

console.log(`API v${API_CONTRACT.version} request/response contracts are consistent.`);
