import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const inputPath = 'data/amr_2m/processed/bvbrc_amr_2000000_enriched.jsonl';
const reportPath = 'data/models/amr_baseline_split_diagnostics.json';
const hash = value => [...String(value ?? '').trim()].reduce(
  (total, character) => ((total * 31) + character.charCodeAt(0)) % 1000003,
  7
);

const years = new Map();
const laboratoryGroups = new Map();
const precomputedSplits = new Map();
const temporalGenomeSplits = new Map();
const seen = new Set();
let scanned = 0;
let eligible = 0;
let duplicatesRemoved = 0;
let missingYear = 0;

const lines = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  scanned += 1;
  if (scanned % 100000 === 0) console.log(`Scanned ${scanned.toLocaleString()} enriched rows`);

  const record = JSON.parse(line);
  if (record.evidence_class !== 'laboratory' || !['resistant', 'susceptible'].includes(record.label)) continue;

  const key = JSON.stringify([
    record.genome_id,
    record.antibiotic,
    record.evidence_class,
    record.testing_method,
    record.testing_standard,
    record.testing_standard_year,
    record.label,
    record.measurement,
    record.measurement_unit,
    record.measurement_sign,
    record.collection_year,
  ]);
  if (seen.has(key)) {
    duplicatesRemoved += 1;
    continue;
  }
  seen.add(key);
  eligible += 1;

  const year = record.collection_year;
  if (year === null || year === undefined) {
    missingYear += 1;
  } else {
    const numericYear = Number(year);
    years.set(numericYear, (years.get(numericYear) || 0) + 1);
    const temporalSplit = numericYear >= 2019 ? 'test' : numericYear >= 2017 ? 'validation' : 'train';
    const genomeId = record.genome_id;
    if (genomeId) {
      const genomeSplits = temporalGenomeSplits.get(genomeId) || new Set();
      genomeSplits.add(temporalSplit);
      temporalGenomeSplits.set(genomeId, genomeSplits);
    }
  }

  const laboratory = String(record.laboratory || record.owner || 'unknown-laboratory').trim();
  const precomputedLabSplit = record.split?.laboratory || 'unassigned';
  const bucket = hash(laboratory) % 5;
  const group = laboratoryGroups.get(laboratory) || { records: 0, bucket, split: precomputedLabSplit };
  group.records += 1;
  laboratoryGroups.set(laboratory, group);
  precomputedSplits.set(precomputedLabSplit, (precomputedSplits.get(precomputedLabSplit) || 0) + 1);
}

const temporalGenomeCounts = { train: 0, validation: 0, test: 0 };
let genomes_in_multiple_temporal_splits = 0;
for (const splits of temporalGenomeSplits.values()) {
  for (const split of splits) temporalGenomeCounts[split] += 1;
  if (splits.size > 1) genomes_in_multiple_temporal_splits += 1;
}

const report = {
  input: inputPath,
  input_records_scanned: scanned,
  eligible_deduplicated_laboratory_records: eligible,
  duplicate_records_removed: duplicatesRemoved,
  missing_collection_year_records: missingYear,
  records_by_collection_year: Object.fromEntries([...years].sort(([left], [right]) => left - right)),
  temporal_genomes_by_split: temporalGenomeCounts,
  genomes_in_multiple_temporal_splits,
  records_by_precomputed_lab_split: Object.fromEntries([...precomputedSplits].sort()),
  laboratory_group_count: laboratoryGroups.size,
  laboratory_groups: Object.fromEntries([...laboratoryGroups].sort(([left], [right]) => left.localeCompare(right))),
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Wrote ${reportPath}`);