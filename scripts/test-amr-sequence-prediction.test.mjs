import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSequenceRequests } from './predict-amr-sequence.mjs';

test('blocks prediction when determinant mapping is incomplete', () => {
  assert.throws(() => buildSequenceRequests({ mapping_status: 'blocked_unmapped_features' }, ['meropenem']), /blocked/);
});

test('builds antibiotic requests from a complete reviewed mapping', () => {
  const requests = buildSequenceRequests({
    mapping_status: 'complete',
    genome_id: '123.4',
    organism: 'Klebsiella pneumoniae',
    model_products: ['carbapenem resistance predicted region'],
  }, ['meropenem', 'ceftriaxone']);
  assert.deepEqual(requests, [
    { organism: 'Klebsiella pneumoniae', antibiotic: 'meropenem', products: ['carbapenem resistance predicted region'] },
    { organism: 'Klebsiella pneumoniae', antibiotic: 'ceftriaxone', products: ['carbapenem resistance predicted region'] },
  ]);
});
