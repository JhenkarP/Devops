import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAmrfinderOutput } from './parse-amrfinder-output.mjs';

const metadata = {
  genome_id: 'sample-001',
  organism: 'klebsiella pneumoniae',
  tool_name: 'AMRFinderPlus',
  tool_version: '4.2.7',
  database_name: 'AMRFinderPlus database',
  database_version: '2026-08-07.1',
};

test('normalizes gene and mutation calls with pinned provenance', () => {
  const output = parseAmrfinderOutput([
    'Element symbol\tElement type\tMethod\tDrug Class\tResistance Mechanism',
    'blaKPC\tAMR gene\tHMM\tcarbapenem\tbeta-lactamase',
    'gyrA S83I\tAMR mutation\tPOINTFX\tfluoroquinolone\ttarget alteration',
    'blaKPC\tAMR gene\tHMM\tcarbapenem\tbeta-lactamase',
  ].join('\n'), metadata);
  assert.equal(output.phenotype_status, 'not_predicted');
  assert.equal(output.features.length, 2);
  assert.equal(output.features[0].tool_version, '4.2.7');
  assert.equal(output.features[1].type, 'mutation');
  assert.equal(output.caller.database_version, '2026-08-07.1');
});

test('rejects output without required AMRFinder columns', () => {
  assert.throws(() => parseAmrfinderOutput('Sequence name\tScore\nsample\t10', metadata), /Element symbol/);
});
