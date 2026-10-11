import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL('./acquire-bvbrc-ast.mjs', import.meta.url));

test('acquires only linked measured AST records and records rejections', async () => {
  const server = createServer((request, response) => {
    const page = new URL(request.url, 'http://localhost').searchParams.get('start') === '1000' ? [] : [
      { id: 'ast-1', genome_id: '573.1', antibiotic: 'meropenem', resistant_phenotype: 'Resistant', evidence: 'Laboratory', isolate_id: 'iso-1', laboratory_id: 'lab-1', measurement: '4', measurement_unit: 'mg/L', testing_method: 'broth dilution', testing_standard: 'CLSI' },
      { id: 'pred-1', genome_id: '573.2', antibiotic: 'meropenem', resistant_phenotype: 'Susceptible', evidence: 'Computational Method', isolate_id: 'iso-2', laboratory_id: 'lab-1', measurement: '2', measurement_unit: 'mg/L', testing_method: 'broth dilution', testing_standard: 'CLSI' },
    ];
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(page));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const directory = await mkdtemp(join(tmpdir(), 'signallab-bvbrc-'));
  try {
    const output = join(directory, 'cohort.jsonl');
    const manifest = join(directory, 'manifest.json');
    const raw = join(directory, 'raw.jsonl');
    await execFileAsync(process.execPath, [script, '--endpoint', `http://127.0.0.1:${port}/api/genome_drug/`, '--output', output, '--manifest', manifest, '--raw-output', raw]);
    const records = (await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
    const report = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(records.length, 1);
    assert.equal(records[0].evidence_class, 'laboratory');
    assert.equal(report.eligible_records, 1);
    assert.equal(report.rejected.computational_not_measured_AST, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
