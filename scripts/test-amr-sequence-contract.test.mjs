import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AMR_SEQUENCE_CONTRACT_VERSION,
  validateAmrNormalizedFeatures,
  validateAmrSequenceInput,
} from '../shared/amr-sequence-contract.js';

const checksum = 'a'.repeat(64);
const preflight = {
  report_version: 'fasta-preflight-1',
  fasta_status: 'valid',
  input_sha256: checksum,
  contig_count: 3,
  total_bases: 5000,
};

test('accepts a FASTA manifest bound to a valid preflight report', () => {
  assert.deepEqual(validateAmrSequenceInput({
    contract_version: AMR_SEQUENCE_CONTRACT_VERSION,
    input_type: 'fasta',
    filename: 'sample-001.fasta.gz',
    content_sha256: checksum,
    preflight_report: preflight,
  }), []);
});

test('rejects an unbound or structurally incomplete FASTA manifest', () => {
  const errors = validateAmrSequenceInput({
    contract_version: AMR_SEQUENCE_CONTRACT_VERSION,
    input_type: 'fasta',
    filename: 'sample-001.txt',
    content_sha256: 'not-a-checksum',
    preflight_report: { ...preflight, input_sha256: 'b'.repeat(64), total_bases: 0 },
  });
  assert.ok(errors.some(error => error.includes('filename')));
  assert.ok(errors.some(error => error.includes('content_sha256')));
  assert.ok(errors.some(error => error.includes('input_sha256')));
  assert.ok(errors.some(error => error.includes('total_bases')));
});

test('requires pinned caller and database versions for sequence-derived features', () => {
  const valid = {
    contract_version: AMR_SEQUENCE_CONTRACT_VERSION,
    genome_id: 'sample-001',
    organism: { name: 'klebsiella pneumoniae', status: 'unconfirmed' },
    features: [{ determinant: 'blaKPC', type: 'acquired_gene', evidence: 'sequence_caller' }],
  };
  assert.ok(validateAmrNormalizedFeatures(valid).some(error => error.includes('tool and database versions')));
  assert.deepEqual(validateAmrNormalizedFeatures({
    ...valid,
    features: [{ ...valid.features[0], tool_name: 'AMRFinderPlus', tool_version: 'x', database_version: 'y' }],
  }), []);
});
