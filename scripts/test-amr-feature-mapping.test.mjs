import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapSequenceFeatures } from './map-amr-sequence-features.mjs';

const input = {
  contract_version: 'amr-sequence-contract-1',
  genome_id: 'sample-001',
  organism: { name: 'klebsiella pneumoniae', status: 'provided_unverified' },
  phenotype_status: 'not_predicted',
  features: [
    { determinant: 'blaKPC', type: 'acquired_gene' },
    { determinant: 'gyrA S83I', type: 'mutation' },
  ],
};

test('maps only explicitly configured determinants and exposes unmapped features', () => {
  const result = mapSequenceFeatures(input, {
    status: 'approved',
    mapping_version: 'reviewed-map-1',
    model_feature_vocabulary_version: 'amr-feature-vocabulary-1',
    mappings: { blaKPC: ['carbapenem resistance predicted region'] },
  });
  assert.deepEqual(result.model_products, ['carbapenem resistance predicted region']);
  assert.deepEqual(result.unmapped_features, [{ determinant: 'gyrA S83I', type: 'mutation' }]);
  assert.equal(result.mapping_status, 'blocked_unmapped_features');
  assert.equal(result.phenotype_status, 'not_predicted');
});
