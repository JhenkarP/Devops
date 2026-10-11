import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const DEFAULT_ENDPOINT = 'https://www.bv-brc.org/api/genome_drug/';
const DEFAULT_ORGANISM = 'klebsiella pneumoniae';
const DEFAULT_ANTIBIOTICS = ['meropenem', 'ciprofloxacin', 'gentamicin', 'ceftriaxone'];
const PAGE_SIZE = 1000;

function value(args, flag, fallback = null) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function first(record, keys) {
  return keys.map(key => record[key]).find(value => value !== undefined && value !== null && String(value).trim() !== '');
}

function classifyPhenotype(value) {
  const normalized = normalize(value);
  if (normalized === 'resistant' || normalized === 'r') return 'resistant';
  if (normalized === 'susceptible' || normalized === 's') return 'susceptible';
  return null;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fetchPage(endpoint, organism, start) {
  const separator = endpoint.includes('?') ? '&' : '?';
  const url = `${endpoint}${separator}eq(organism_name,${encodeURIComponent(organism)})&limit(${PAGE_SIZE})&start(${start})`;
  const response = await fetch(url, { headers: { 'User-Agent': 'SignalLab/0.1 research-data-client' } });
  if (!response.ok) throw new Error(`BV-BRC returned ${response.status} ${response.statusText} for ${url}`);
  const payload = await response.json();
  if (Array.isArray(payload)) return payload;
  return payload.response?.docs || payload.response || payload.data || payload.results || [];
}

const args = process.argv.slice(2);
const endpoint = value(args, '--endpoint', process.env.BV_BRC_GENOME_DRUG_ENDPOINT || DEFAULT_ENDPOINT);
const organism = normalize(value(args, '--organism', DEFAULT_ORGANISM));
const antibiotics = (value(args, '--antibiotics', DEFAULT_ANTIBIOTICS.join(',')) || '').split(',').map(normalize).filter(Boolean);
const output = resolve(value(args, '--output', 'data/external_amr/bvbrc_ast_cohort.jsonl'));
const manifestPath = resolve(value(args, '--manifest', 'data/external_amr/bvbrc_ast_manifest.json'));
const sourceRowsPath = resolve(value(args, '--raw-output', `${output}.source.jsonl`));
await mkdir(dirname(output), { recursive: true });
const sourceRows = [];
const records = [];
const rejected = {};
let start = 0;
while (true) {
  const page = await fetchPage(endpoint, organism, start);
  if (!page.length) break;
  for (const row of page) {
    sourceRows.push(row);
    const antibiotic = normalize(first(row, ['antibiotic', 'antibiotic_name']));
    const phenotype = classifyPhenotype(first(row, ['resistant_phenotype', 'phenotype', 'resistance_phenotype']));
    const evidence = normalize(first(row, ['evidence', 'evidence_class']));
    const genomeId = String(first(row, ['genome_id', 'genome']) || '').trim();
    const isolateId = String(first(row, ['isolate_id', 'isolate', 'biosample_accession']) || '').trim();
    const laboratoryId = String(first(row, ['laboratory_id', 'lab_id', 'laboratory', 'lab_name']) || '').trim();
    const measurement = String(first(row, ['measurement', 'mic', 'measurement_value']) || '').trim();
    const measurementUnit = String(first(row, ['measurement_unit', 'mic_unit', 'unit']) || '').trim();
    const testingMethod = String(first(row, ['testing_method', 'method']) || '').trim();
    const testingStandard = String(first(row, ['testing_standard', 'standard']) || '').trim();
    let reason = null;
    if (!antibiotics.includes(antibiotic)) reason = 'out_of_scope_antibiotic';
    else if (!phenotype) reason = 'missing_R_or_S_phenotype';
    else if (!genomeId) reason = 'missing_genome_id';
    else if (!isolateId) reason = 'missing_isolate_id';
    else if (!laboratoryId) reason = 'missing_laboratory_id';
    else if (!measurement || !measurementUnit || !testingMethod || !testingStandard) reason = 'missing_AST_metadata';
    else if (evidence.includes('computational') || evidence.includes('predicted')) reason = 'computational_not_measured_AST';
    if (reason) { rejected[reason] = (rejected[reason] || 0) + 1; continue; }
    records.push({
      measurement_id: String(first(row, ['measurement_id', 'id']) || `${genomeId}:${antibiotic}:${records.length}`),
      isolate_id: isolateId,
      genome_id: genomeId,
      laboratory_id: laboratoryId,
      organism,
      antibiotic,
      label: phenotype,
      products: [],
      evidence_class: 'laboratory',
      ast: { measurement, measurement_unit: measurementUnit, testing_method: testingMethod, testing_standard: testingStandard },
      source: { provider: 'BV-BRC/PATRIC', source_record_id: String(first(row, ['id']) || '') },
    });
  }
  if (page.length < PAGE_SIZE) break;
  start += PAGE_SIZE;
}
const canonical = records.map(record => `${JSON.stringify(record)}\n`).join('');
await writeFile(output, canonical);
await writeFile(sourceRowsPath, sourceRows.map(row => `${JSON.stringify(row)}\n`).join(''));
const outputBytes = Buffer.from(canonical);
const manifest = {
  dataset_name: 'BV-BRC genome_drug measured AST acquisition',
  source_url: endpoint,
  organism,
  antibiotics,
  downloaded_at: new Date().toISOString(),
  source_records_scanned: sourceRows.length,
  eligible_records: records.length,
  rejected,
  cohort_sha256: sha256(outputBytes),
  independent_of_training: false,
  status: records.length ? 'acquired_training_candidate_requires_review' : 'blocked_no_eligible_measured_AST_records',
  limitations: [
    'BV-BRC/PATRIC records are a training-candidate source, not an independent validation cohort.',
    'The importer refuses records without explicit isolate, physical laboratory, AST measurement, method, and standard fields.',
    'Genome sequence and AMRFinderPlus feature linkage must be acquired separately before sequence-native training.',
  ],
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ output, manifest: manifestPath, scanned: sourceRows.length, eligible: records.length, rejected }, null, 2));
