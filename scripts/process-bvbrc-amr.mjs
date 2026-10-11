import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parser } from 'stream-json';
import { streamArray } from 'stream-json/streamers/stream-array.js';

const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
const outputDirectory = join(dataDirectory, 'amr_2m', 'processed');
const [sourceName = 'amr_2m/bvbrc_genome_amr.json', outputName = 'bvbrc_amr_2000000_normalized.jsonl'] = process.argv.slice(2);
const sourcePath = join(dataDirectory, sourceName);
const outputPath = join(outputDirectory, outputName);
const temporaryPath = `${outputPath}.partial`;
const reportPath = join(outputDirectory, 'bvbrc_amr_processing_report.json');
const deduplicatedPath = join(outputDirectory, 'bvbrc_amr_2000000_deduplicated.jsonl');
const deduplicatedTemporaryPath = `${deduplicatedPath}.partial`;
const conflictsPath = join(outputDirectory, 'bvbrc_amr_2000000_conflicts.jsonl');
const conflictsTemporaryPath = `${conflictsPath}.partial`;
const databasePath = join(outputDirectory, '.bvbrc_amr_dedupe.sqlite');
const text = value => String(value ?? '').trim();
const lower = value => text(value).toLowerCase();
const antibioticAliases = new Map([
  ['cipro', 'ciprofloxacin'],
  ['trimethoprim-sulfamethoxazole', 'trimethoprim-sulfamethoxazole'],
  ['trimethoprim/sulfamethoxazole', 'trimethoprim-sulfamethoxazole']
]);

function normalizeLabel(value) {
  const label = lower(value);
  if (label.startsWith('resist')) return 'resistant';
  if (label.startsWith('suscept')) return 'susceptible';
  if (label.startsWith('intermed')) return 'intermediate';
  if (label.startsWith('nonsuscept')) return 'nonsusceptible';
  return 'unknown';
}

function normalizeRecord(record) {
  const evidence = text(record.evidence) || 'unspecified';
  const normalizedEvidence = lower(evidence).includes('laboratory')
    ? 'laboratory'
    : lower(evidence).includes('computational') ? 'computational' : 'other';
  const rawPhenotype = text(record.resistant_phenotype || record.phenotype || record.resistance);
  const antibiotic = lower(record.antibiotic || record.drug).replace(/\s+/g, ' ');
  return {
    source_id: text(record.id) || null,
    genome_id: text(record.genome_id || record.genome_identifier || record.genome) || null,
    organism: text(record.organism || record.species || record.genome_name) || 'Unknown organism',
    antibiotic: antibioticAliases.get(antibiotic) || antibiotic.replace(/\s*\/\s*/g, '/'),
    label: normalizeLabel(rawPhenotype),
    raw_phenotype: rawPhenotype || null,
    label_evidence: rawPhenotype ? normalizedEvidence : null,
    evidence,
    evidence_class: normalizedEvidence,
    computational_method: text(record.computational_method) || null,
    computational_method_version: text(record.computational_method_version) || null,
    measurement: text(record.measurement || record.measurement_value) || null,
    measurement_unit: text(record.measurement_unit) || null,
    measurement_sign: text(record.measurement_sign) || null,
    testing_method: text(record.laboratory_typing_method || record.testing_method) || null,
    testing_standard: text(record.testing_standard) || null,
    testing_standard_year: text(record.testing_standard_year) || null,
    collection_year: text(record.collection_year || record.year) || null,
    feature_status: 'not-joined'
  };
}

async function writeChunk(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, 'drain');
}

await mkdir(outputDirectory, { recursive: true });
await rm(databasePath, { force: true });
const sourceStats = await stat(sourcePath);
const output = createWriteStream(temporaryPath, { encoding: 'utf8' });
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA journal_mode = OFF;
  PRAGMA synchronous = OFF;
  CREATE TABLE unique_records (
    dedup_key TEXT PRIMARY KEY,
    source_order INTEGER NOT NULL,
    genome_id TEXT NOT NULL,
    antibiotic TEXT NOT NULL,
    evidence_class TEXT NOT NULL,
    testing_method TEXT NOT NULL,
    testing_standard TEXT NOT NULL,
    testing_standard_year TEXT NOT NULL,
    label TEXT NOT NULL,
    record_json TEXT NOT NULL
  ) WITHOUT ROWID;
`);
const insertUnique = database.prepare(`
  INSERT OR IGNORE INTO unique_records (
    dedup_key, source_order, genome_id, antibiotic, evidence_class,
    testing_method, testing_standard, testing_standard_year, label, record_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const checksum = createHash('sha256');
const batchSize = 20000;
const evidenceCounts = {};
const labelCounts = {};
const evidenceLabelCounts = {};
let sourceRecords = 0;
let recordsWithGenomeId = 0;
let recordsWithAntibiotic = 0;
let laboratoryMeasurements = 0;
let transactionOpen = false;

try {
  database.exec('BEGIN');
  transactionOpen = true;
  const records = createReadStream(sourcePath).pipe(parser.asStream()).pipe(streamArray.asStream());
  for await (const { value } of records) {
    const normalized = normalizeRecord(value);
    const line = `${JSON.stringify(normalized)}\n`;
    await writeChunk(output, line);
    checksum.update(line);
    sourceRecords += 1;
    const deduplicationKey = normalized.genome_id && normalized.antibiotic
      ? [
          normalized.genome_id,
          normalized.antibiotic,
          normalized.evidence_class,
          normalized.testing_method,
          normalized.testing_standard,
          normalized.testing_standard_year,
          normalized.label,
          normalized.measurement,
          normalized.measurement_unit,
          normalized.measurement_sign,
          normalized.collection_year
        ]
      : ['unkeyed', sourceRecords];
    insertUnique.run(
      JSON.stringify(deduplicationKey),
      sourceRecords,
      normalized.genome_id || '',
      normalized.antibiotic || '',
      normalized.evidence_class,
      normalized.testing_method || '',
      normalized.testing_standard || '',
      normalized.testing_standard_year || '',
      normalized.label,
      JSON.stringify(normalized)
    );
    if (normalized.genome_id) recordsWithGenomeId += 1;
    if (normalized.antibiotic) recordsWithAntibiotic += 1;
    if (normalized.evidence_class === 'laboratory' && normalized.measurement !== null) laboratoryMeasurements += 1;
    evidenceCounts[normalized.evidence_class] = (evidenceCounts[normalized.evidence_class] || 0) + 1;
    labelCounts[normalized.label] = (labelCounts[normalized.label] || 0) + 1;
    const evidenceLabel = `${normalized.evidence_class}:${normalized.label}`;
    evidenceLabelCounts[evidenceLabel] = (evidenceLabelCounts[evidenceLabel] || 0) + 1;
    if (sourceRecords % batchSize === 0) {
      database.exec('COMMIT');
      transactionOpen = false;
      console.log(`Processed and committed ${sourceRecords.toLocaleString()} source records`);
      database.exec('BEGIN');
      transactionOpen = true;
    }
  }

  if (transactionOpen) {
    database.exec('COMMIT');
    transactionOpen = false;
  }

  output.end();
  await once(output, 'finish');
  await rename(temporaryPath, outputPath);

  const deduplicatedOutput = createWriteStream(deduplicatedTemporaryPath, { encoding: 'utf8' });
  let deduplicatedRecords = 0;
  for (const row of database.prepare('SELECT record_json FROM unique_records ORDER BY source_order').iterate()) {
    await writeChunk(deduplicatedOutput, `${row.record_json}\n`);
    deduplicatedRecords += 1;
  }
  deduplicatedOutput.end();
  await once(deduplicatedOutput, 'finish');
  await rename(deduplicatedTemporaryPath, deduplicatedPath);

  const conflictsOutput = createWriteStream(conflictsTemporaryPath, { encoding: 'utf8' });
  const conflictQuery = database.prepare(`
    SELECT genome_id, antibiotic, evidence_class, testing_method, testing_standard,
      testing_standard_year, GROUP_CONCAT(DISTINCT label) AS labels
    FROM unique_records
    WHERE label IN ('resistant', 'susceptible', 'intermediate', 'nonsusceptible')
    GROUP BY genome_id, antibiotic, evidence_class, testing_method, testing_standard, testing_standard_year
    HAVING COUNT(DISTINCT label) > 1
    ORDER BY genome_id, antibiotic
  `);
  let conflictGroups = 0;
  for (const row of conflictQuery.iterate()) {
    const conflict = {
      genome_id: row.genome_id,
      antibiotic: row.antibiotic,
      evidence_class: row.evidence_class,
      testing_method: row.testing_method || null,
      testing_standard: row.testing_standard || null,
      testing_standard_year: row.testing_standard_year || null,
      labels: row.labels.split(',').sort()
    };
    await writeChunk(conflictsOutput, `${JSON.stringify(conflict)}\n`);
    conflictGroups += 1;
  }
  conflictsOutput.end();
  await once(conflictsOutput, 'finish');
  await rename(conflictsTemporaryPath, conflictsPath);

  const outputStats = await stat(outputPath);
  const deduplicatedStats = await stat(deduplicatedPath);
  const conflictsStats = await stat(conflictsPath);
  const report = {
    generated_at: new Date().toISOString(),
    source: sourceName,
    source_bytes: sourceStats.size,
    source_records: sourceRecords,
    normalized_records: sourceRecords,
    output: outputName,
    output_bytes: outputStats.size,
    output_sha256: checksum.digest('hex'),
    deduplicated_output: deduplicatedPath.split('amr_2m\\processed\\').pop(),
    deduplicated_records: deduplicatedRecords,
    deduplicated_output_bytes: deduplicatedStats.size,
    duplicate_records_removed: sourceRecords - deduplicatedRecords,
    deduplication_key: 'genome_id, antibiotic, evidence_class, testing_method, testing_standard/year, label, measurement/value unit/sign, and collection_year; records without genome ID or antibiotic are retained individually.',
    conflicts_output: conflictsPath.split('amr_2m\\processed\\').pop(),
    conflict_groups: conflictGroups,
    conflicts_output_bytes: conflictsStats.size,
    conflict_grouping: 'Genome, antibiotic, evidence class, testing method, and testing standard/year; only groups with multiple definitive labels are emitted.',
    records_with_genome_id: recordsWithGenomeId,
    records_with_antibiotic: recordsWithAntibiotic,
    evidence_counts: evidenceCounts,
    label_counts: labelCounts,
    evidence_label_counts: evidenceLabelCounts,
    laboratory_records_with_measurements: laboratoryMeasurements,
    deduplication: 'Exact normalized records were deduplicated using the documented evidence- and test-aware key; both the full normalized source and deduplicated output are retained.',
    genome_metadata_join: 'Not performed for the full catalog.',
    resistance_feature_join: 'Not performed for the full catalog; feature_status is not-joined.',
    warnings: [
      'Computational resistance labels are kept distinct from laboratory evidence.',
      'Numeric laboratory measurements are preserved and are not converted to susceptible/resistant labels without applicable breakpoints.',
      'The BV-BRC AMR table does not contain complete genome assemblies or mutation calls.'
    ]
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  database.close();
  await rm(databasePath, { force: true });
  console.log(`Processed ${sourceRecords.toLocaleString()} AMR records to ${outputPath}`);
  console.log(`Retained ${deduplicatedRecords.toLocaleString()} unique records and found ${conflictGroups.toLocaleString()} conflict groups`);
} catch (error) {
  output.destroy();
  if (transactionOpen) database.exec('ROLLBACK');
  database.close();
  await rm(databasePath, { force: true });
  throw error;
}