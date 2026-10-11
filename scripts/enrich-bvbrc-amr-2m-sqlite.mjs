import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
const processedDirectory = join(dataDirectory, 'amr_2m', 'processed');
const inputPath = join(processedDirectory, 'bvbrc_amr_2000000_normalized.jsonl');
const metadataPath = join(processedDirectory, 'bvbrc_genome_metadata_cache.jsonl');
const featuresPath = join(processedDirectory, 'bvbrc_resistance_features_cache.jsonl');
const outputPath = join(processedDirectory, 'bvbrc_amr_2000000_enriched.jsonl');
const reportPath = join(processedDirectory, 'bvbrc_amr_enrichment_report.json');
const databasePath = join(processedDirectory, '.bvbrc_amr_enrichment.sqlite');
const maxGenomes = Number.parseInt(process.env.MAX_GENOMES || '0', 10);
const maxRecords = Number.parseInt(process.env.MAX_RECORDS || '0', 10);
const batchSize = 250;
const concurrency = 2;
const text = value => String(value ?? '').trim();
const execFileAsync = promisify(execFile);

function metadataFields(value) {
  return {
    species: value.species || null,
    organism: value.organism || null,
    collection_year: value.collection_year || value.year || null,
    owner: value.owner || null,
    laboratory: value.laboratory || value.laboratory_name || null,
    geographic_location: value.geographic_location || null,
    isolation_country: value.isolation_country || null,
    geographic_group: value.geographic_group || null
  };
}

function yearOf(record, metadata) {
  const value = Number.parseInt(text(record.collection_year || record.year || metadata.collection_year), 10);
  return Number.isInteger(value) && value >= 1900 && value <= 2100 ? value : null;
}

function hash(value) {
  return [...text(value)].reduce((total, character) => ((total * 31) + character.charCodeAt(0)) % 1000003, 7);
}

function splits(record, metadata) {
  const year = yearOf(record, metadata);
  const laboratory = text(record.laboratory || record.owner || metadata.owner || metadata.laboratory) || 'unknown-laboratory';
  const geography = text(record.geographic_location || metadata.geographic_location || metadata.isolation_country || metadata.geographic_group) || 'unknown-geography';
  const labHash = hash(laboratory) % 5;
  const geoHash = hash(geography) % 5;
  return {
    temporal: year === null ? 'unassigned-missing-year' : year >= 2024 ? 'test' : year >= 2022 ? 'validation' : 'train',
    laboratory: labHash < 3 ? 'train' : labHash === 3 ? 'validation' : 'test',
    geography: geoHash < 3 ? 'train' : geoHash === 3 ? 'validation' : 'test'
  };
}

async function writeChunk(stream, value) {
  if (!stream.write(value)) await once(stream, 'drain');
}

const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS genome_ids (genome_id TEXT PRIMARY KEY) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS metadata_cache (genome_id TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS feature_cache (genome_id TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
`);
const insertId = database.prepare('INSERT OR IGNORE INTO genome_ids(genome_id) VALUES (?)');
const insertMetadata = database.prepare('INSERT OR REPLACE INTO metadata_cache(genome_id, value) VALUES (?, ?)');
const insertFeatures = database.prepare('INSERT OR REPLACE INTO feature_cache(genome_id, value) VALUES (?, ?)');
const getMetadata = database.prepare('SELECT value FROM metadata_cache WHERE genome_id = ?');
const getFeatures = database.prepare('SELECT value FROM feature_cache WHERE genome_id = ?');
const countIds = database.prepare('SELECT COUNT(*) AS count FROM genome_ids');

const importJsonlCache = async (path, table) => {
  const insert = table === 'metadata_cache' ? insertMetadata : insertFeatures;
  let count = 0;
  try {
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    database.exec('BEGIN');
    for await (const line of lines) {
      if (!line.trim()) continue;
      const item = JSON.parse(line);
      if (!item.genome_id) continue;
      insert.run(String(item.genome_id), JSON.stringify(table === 'metadata_cache' ? (item.value ? metadataFields(item.value) : null) : item.value || []));
      count += 1;
      if (count % 10000 === 0) {
        database.exec('COMMIT');
        database.exec('BEGIN');
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    if (error.code !== 'ENOENT') throw error;
  }
  console.log(`Indexed ${count.toLocaleString()} ${table} cache rows`);
};

await mkdir(processedDirectory, { recursive: true });
await importJsonlCache(metadataPath, 'metadata_cache');
await importJsonlCache(featuresPath, 'feature_cache');

let idsAdded = 0;
let inputRecords = 0;
const inputLines = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
database.exec('BEGIN');
for await (const line of inputLines) {
  if (!line.trim()) continue;
  const record = JSON.parse(line);
  const id = text(record.genome_id);
  if (id) {
    const result = insertId.run(id);
    idsAdded += Number(result.changes);
  }
  inputRecords += 1;
  if (inputRecords % 20000 === 0) {
    database.exec('COMMIT');
    database.exec('BEGIN');
  }
  if (maxRecords > 0 && inputRecords >= maxRecords) break;
}
database.exec('COMMIT');
console.log(`Indexed ${countIds.get().count.toLocaleString()} unique genome IDs`);

async function fetchBatch(endpoint, ids) {
  const featureEndpoint = endpoint.endsWith('genome_feature/');
  const query = `${endpoint}?in(genome_id,(${ids.join(',')}))${featureEndpoint ? '&keyword(resistance)&limit(5000)' : `&limit(${ids.length})`}`;
  const { stdout } = await execFileAsync('curl.exe', ['-k', '-L', '--fail', '--retry', '2', '--max-time', '90', '-A', 'SignalLab/0.1 research-data-client', query], { maxBuffer: 50 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function fetchMissing(endpoint, cacheTable) {
  const isFeatures = cacheTable === 'feature_cache';
  const insert = isFeatures ? insertFeatures : insertMetadata;
  const selectMissing = database.prepare(`SELECT ids.genome_id FROM genome_ids ids LEFT JOIN ${cacheTable} cache USING(genome_id) WHERE cache.genome_id IS NULL AND ids.genome_id > ? ORDER BY ids.genome_id LIMIT ?`);
  let cursor = '';
  let fetchedSinceStart = 0;
  let failures = 0;
  while (true) {
    const group = [];
    for (let slot = 0; slot < concurrency; slot += 1) {
      const batch = selectMissing.all(cursor, batchSize).map(row => row.genome_id);
      if (!batch.length) break;
      cursor = batch.at(-1);
      group.push(batch);
    }
    if (!group.length) break;
    const results = await Promise.all(group.map(async batch => {
      try { return { batch, records: await fetchBatch(endpoint, batch), failed: false }; }
      catch (error) {
        console.warn(`Could not fetch ${endpoint} batch: ${error.message}`);
        return { batch, records: [], failed: true };
      }
    }));
    database.exec('BEGIN');
    for (const result of results) {
      if (result.failed) {
        failures += result.batch.length;
        continue;
      }
      for (const id of result.batch) insert.run(id, isFeatures ? '[]' : 'null');
      for (const record of result.records) {
        const id = text(record.genome_id);
        if (!id) continue;
        if (isFeatures) {
          const current = getFeatures.get(id);
          const values = current ? JSON.parse(current.value) : [];
          values.push({ feature_id: record.feature_id || null, product: record.product || null, location: record.location || null });
          insert.run(id, JSON.stringify(values));
        } else {
          insert.run(id, JSON.stringify(metadataFields(record)));
        }
      }
    }
    database.exec('COMMIT');
    fetchedSinceStart += group.reduce((total, batch) => total + batch.length, 0);
    console.log(`Processed ${fetchedSinceStart.toLocaleString()} ${isFeatures ? 'feature' : 'metadata'} genome IDs; ${failures.toLocaleString()} request failures`);
  }
  return failures;
}

const metadataFailures = await fetchMissing('https://www.bv-brc.org/api/genome/', 'metadata_cache');
const featureFailures = await fetchMissing('https://www.bv-brc.org/api/genome_feature/', 'feature_cache');

const output = createWriteStream(outputPath, { encoding: 'utf8' });
let records = 0;
let metadataMatches = 0;
let genomesWithFeatures = 0;
let temporalAssigned = 0;
const outputLines = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
for await (const line of outputLines) {
  if (!line.trim()) continue;
  if (maxRecords > 0 && records >= maxRecords) break;
  const record = JSON.parse(line);
  const genomeId = text(record.genome_id);
  const metadataRow = getMetadata.get(genomeId);
  const metadata = metadataRow?.value && metadataRow.value !== 'null' ? JSON.parse(metadataRow.value) : {};
  const featureRow = getFeatures.get(genomeId);
  const features = featureRow ? JSON.parse(featureRow.value) : [];
  const split = splits(record, metadata);
  const enriched = {
    ...record,
    organism: text(metadata.species || metadata.organism || record.organism) || 'Unknown organism',
    collection_year: yearOf(record, metadata),
    laboratory: text(record.laboratory || record.owner || metadata.owner || metadata.laboratory) || null,
    geography: text(record.geographic_location || metadata.geographic_location || metadata.isolation_country || metadata.geographic_group) || null,
    resistance_feature_calls: features,
    feature_status: features.length ? 'provided-by-source' : 'missing-genome-feature-link',
    split
  };
  await writeChunk(output, `${JSON.stringify(enriched)}\n`);
  records += 1;
  if (metadataRow?.value && metadataRow.value !== 'null') metadataMatches += 1;
  if (features.length) genomesWithFeatures += 1;
  if (split.temporal !== 'unassigned-missing-year') temporalAssigned += 1;
}
output.end();
await once(output, 'finish');
const report = {
  generated_at: new Date().toISOString(),
  source: 'bvbrc_amr_2000000_normalized.jsonl',
  records,
  unique_genome_ids: countIds.get().count,
  genome_metadata_matches: metadataMatches,
  records_with_resistance_feature_calls: genomesWithFeatures,
  split_counts: { temporal: temporalAssigned, laboratory: records, geography: records },
  metadata_request_failures: metadataFailures,
  feature_request_failures: featureFailures,
  mutation_analysis: 'Not performed; sequence-backed mutation analysis is outside the current scope.'
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
database.close();
console.log(`Enriched ${records.toLocaleString()} AMR records`);
