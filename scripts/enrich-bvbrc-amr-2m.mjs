import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
const cohortDirectory = join(dataDirectory, 'amr_2m');
const processedDirectory = join(cohortDirectory, 'processed');
const inputPath = join(processedDirectory, 'bvbrc_amr_2000000_normalized.jsonl');
const outputPath = join(processedDirectory, 'bvbrc_amr_2000000_enriched.jsonl');
const metadataPath = join(processedDirectory, 'bvbrc_genome_metadata_cache.jsonl');
const featuresPath = join(processedDirectory, 'bvbrc_resistance_features_cache.jsonl');
const reportPath = join(processedDirectory, 'bvbrc_amr_enrichment_report.json');
const maxGenomes = Number.parseInt(process.env.MAX_GENOMES || '0', 10);
const maxRecords = Number.parseInt(process.env.MAX_RECORDS || '0', 10);
const batchSize = 500;
const concurrency = 2;
const text = value => String(value ?? '').trim();
const execFileAsync = promisify(execFile);
const lower = value => text(value).toLowerCase();
const hash = value => [...text(value)].reduce((total, character) => ((total * 31) + character.charCodeAt(0)) % 1000003, 7);

function explicitYear(record) {
  const year = Number.parseInt(text(record.collection_year || record.year), 10);
  return Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null;
}

function splitFor(record, metadata) {
  const year = explicitYear({ ...record, ...metadata });
  const laboratory = text(record.laboratory || record.owner || metadata.owner || metadata.laboratory) || 'unknown-laboratory';
  const geography = text(record.geographic_location || metadata.geographic_location || metadata.isolation_country || metadata.geographic_group) || 'unknown-geography';
  const labHash = hash(laboratory) % 5;
  const geographyHash = hash(geography) % 5;
  return {
    temporal: year === null ? 'unassigned-missing-year' : year >= 2024 ? 'test' : year >= 2022 ? 'validation' : 'train',
    laboratory: labHash < 3 ? 'train' : labHash === 3 ? 'validation' : 'test',
    geography: geographyHash < 3 ? 'train' : geographyHash === 3 ? 'validation' : 'test'
  };
}

function metadataFields(value) {
  if (!value) return null;
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

async function readCache(path, compactMetadata) {
  const cache = {};
  try {
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      cache[record.genome_id] = compactMetadata ? metadataFields(record.value) : record.value;
    }
  } catch {
    return cache;
  }
  return cache;
}

async function collectGenomeIds() {
  const ids = new Set();
  const records = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
  for await (const line of records) {
    if (!line.trim()) continue;
    const genomeId = text(JSON.parse(line).genome_id);
    if (genomeId) ids.add(genomeId);
    if (maxGenomes > 0 && ids.size >= maxGenomes) break;
  }
  return [...ids];
}

async function fetchBatch(endpoint, ids) {
  const featureFilter = endpoint.endsWith('genome_feature/') ? '&keyword(resistance)' : '';
  const query = `${endpoint}?in(genome_id,(${ids.join(',')}))${featureFilter}&limit(${endpoint.endsWith('genome_feature/') ? 5000 : ids.length})`;
  try {
    const { stdout } = await execFileAsync('curl.exe', ['-k', '-L', '--fail', '--retry', '2', '--max-time', '60', '-A', 'SignalLab/0.1 research-data-client', query], { maxBuffer: 50 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (curlError) {
    const response = await fetch(query, { headers: { 'User-Agent': 'SignalLab/0.1 research-data-client' } });
    if (!response.ok) throw new Error(`${curlError.message}; fallback ${response.status} ${response.statusText}`);
    return response.json();
  }
}

async function fetchCached(ids, endpoint, cachePath) {
  const compactMetadata = !endpoint.endsWith('genome_feature/');
  const cache = await readCache(cachePath, compactMetadata);
  const missing = ids.filter(id => !Object.hasOwn(cache, id));
  for (let offset = 0; offset < missing.length; offset += batchSize * concurrency) {
    const batches = [];
    for (let index = offset; index < Math.min(offset + batchSize * concurrency, missing.length); index += batchSize) {
      batches.push(missing.slice(index, index + batchSize));
    }
    const results = await Promise.all(batches.map(async batch => {
      try {
        return { batch, records: await fetchBatch(endpoint, batch), failed: false };
      } catch (error) {
        console.warn(`Could not fetch ${endpoint} batch: ${error.message}`);
        return { batch, records: [], failed: true };
      }
    }));
    const changedGenomeIds = new Set();
    for (const result of results) {
      if (result.failed) continue;
      for (const genomeId of result.batch) {
        if (!Object.hasOwn(cache, genomeId)) {
          cache[genomeId] = endpoint.endsWith('genome_feature/') ? [] : null;
          changedGenomeIds.add(genomeId);
        }
      }
      for (const record of result.records) {
        const genomeId = text(record.genome_id);
        if (!genomeId) continue;
        if (endpoint.endsWith('genome_feature/')) {
          if (!Array.isArray(cache[genomeId])) cache[genomeId] = [];
          cache[genomeId].push(record);
          changedGenomeIds.add(genomeId);
        } else {
          cache[genomeId] = metadataFields(record);
          changedGenomeIds.add(genomeId);
        }
      }
    }
    const cacheOutput = createWriteStream(cachePath, { encoding: 'utf8', flags: 'a' });
    for (const genomeId of changedGenomeIds) cacheOutput.write(`${JSON.stringify({ genome_id: genomeId, value: cache[genomeId] })}\n`);
    cacheOutput.end();
    await once(cacheOutput, 'finish');
    console.log(`Fetched ${Math.min(offset + batchSize * concurrency, missing.length).toLocaleString()} of ${missing.length.toLocaleString()} missing genome IDs`);
  }
  return cache;
}

await mkdir(processedDirectory, { recursive: true });
const genomeIds = await collectGenomeIds();
const metadata = await fetchCached(genomeIds, 'https://www.bv-brc.org/api/genome/', metadataPath);
const features = await fetchCached(genomeIds, 'https://www.bv-brc.org/api/genome_feature/', featuresPath);
const output = createWriteStream(outputPath, { encoding: 'utf8' });
let records = 0;
let metadataMatches = 0;
let featureMatches = 0;
let temporalAssigned = 0;
let laboratoryAssigned = 0;
let geographyAssigned = 0;
const input = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  if (maxRecords > 0 && records >= maxRecords) break;
  const value = JSON.parse(line);
  const genomeId = text(value.genome_id);
  const genomeMetadata = metadata[genomeId] || {};
  const resistanceFeatures = features[genomeId] || [];
  const split = splitFor(value, genomeMetadata);
  const enriched = {
    ...value,
    organism: text(genomeMetadata.species || genomeMetadata.organism || value.organism) || 'Unknown organism',
    collection_year: explicitYear({ ...value, ...genomeMetadata }),
    laboratory: text(value.laboratory || value.owner || genomeMetadata.owner) || null,
    geography: text(value.geographic_location || genomeMetadata.geographic_location || genomeMetadata.isolation_country || genomeMetadata.geographic_group) || null,
    resistance_feature_calls: resistanceFeatures.map(feature => ({ feature_id: feature.feature_id || null, product: feature.product || null, location: feature.location || null })),
    feature_status: resistanceFeatures.length ? 'provided-by-source' : 'missing-genome-feature-link',
    split
  };
  output.write(`${JSON.stringify(enriched)}\n`);
  records += 1;
  if (metadata[genomeId]) metadataMatches += 1;
  if (resistanceFeatures.length) featureMatches += 1;
  if (split.temporal !== 'unassigned-missing-year') temporalAssigned += 1;
  if (split.laboratory) laboratoryAssigned += 1;
  if (split.geography) geographyAssigned += 1;
}
output.end();
await once(output, 'finish');
await writeFile(reportPath, `${JSON.stringify({
  generated_at: new Date().toISOString(),
  source: 'bvbrc_amr_2000000_normalized.jsonl',
  records,
  unique_genome_ids: genomeIds.length,
  genome_metadata_matches: metadataMatches,
  genomes_with_resistance_feature_calls: featureMatches,
  split_counts: { temporal: temporalAssigned, laboratory: laboratoryAssigned, geography: geographyAssigned },
  mutation_analysis: 'Not performed; sequence-backed mutation analysis is outside the current scope.'
}, null, 2)}\n`);
console.log(`Enriched ${records.toLocaleString()} AMR records`);