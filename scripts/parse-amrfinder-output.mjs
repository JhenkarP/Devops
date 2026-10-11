import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AMR_SEQUENCE_CONTRACT_VERSION, validateAmrNormalizedFeatures } from '../shared/amr-sequence-contract.js';

const COLUMN_ALIASES = {
  determinant: ['Element symbol', 'Target identifier', 'Gene symbol', 'Element name'],
  elementType: ['Element type', 'Type'],
  method: ['Method'],
  drugClass: ['Drug Class'],
  resistanceMechanism: ['Resistance Mechanism'],
};

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function findColumn(columns, aliases) {
  return aliases.map(alias => columns.indexOf(alias)).find(index => index >= 0);
}

function splitTsv(text) {
  return text.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#')).map(line => line.split('\t'));
}

export function parseAmrfinderOutput(text, metadata) {
  const rows = splitTsv(text);
  if (!rows.length) throw new Error('AMRFinderPlus output is empty.');
  const columns = rows[0];
  const determinantColumn = findColumn(columns, COLUMN_ALIASES.determinant);
  const typeColumn = findColumn(columns, COLUMN_ALIASES.elementType);
  if (determinantColumn === undefined || typeColumn === undefined) {
    throw new Error('AMRFinderPlus output must contain Element symbol/Target identifier and Element type columns.');
  }
  const methodColumn = findColumn(columns, COLUMN_ALIASES.method);
  const drugClassColumn = findColumn(columns, COLUMN_ALIASES.drugClass);
  const mechanismColumn = findColumn(columns, COLUMN_ALIASES.resistanceMechanism);
  const features = [];
  const seen = new Set();
  for (const values of rows.slice(1)) {
    const determinant = String(values[determinantColumn] || '').trim();
    if (!determinant) continue;
    const rawType = String(values[typeColumn] || '').toLowerCase();
    const type = rawType.includes('mutation') || rawType.includes('snp') ? 'mutation'
      : rawType.includes('gene') || rawType.includes('amr') ? 'acquired_gene' : 'unknown';
    const key = `${type}\0${determinant}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const feature = {
      determinant,
      type,
      evidence: 'sequence_caller',
      tool_name: metadata.tool_name,
      tool_version: metadata.tool_version,
      database_name: metadata.database_name,
      database_version: metadata.database_version,
    };
    if (methodColumn !== undefined && values[methodColumn]) feature.caller_method = values[methodColumn];
    if (drugClassColumn !== undefined && values[drugClassColumn]) feature.drug_class = values[drugClassColumn];
    if (mechanismColumn !== undefined && values[mechanismColumn]) feature.resistance_mechanism = values[mechanismColumn];
    features.push(feature);
  }
  const output = {
    contract_version: AMR_SEQUENCE_CONTRACT_VERSION,
    genome_id: metadata.genome_id,
    organism: { name: metadata.organism || null, status: metadata.organism ? 'provided_unverified' : 'unconfirmed' },
    features,
    caller: {
      tool_name: metadata.tool_name,
      tool_version: metadata.tool_version,
      database_name: metadata.database_name,
      database_version: metadata.database_version,
      output_sha256: sha256(Buffer.from(text)),
    },
    phenotype_status: 'not_predicted',
    limitations: [
      'AMRFinderPlus determinant calls are sequence evidence and do not by themselves establish phenotypic resistance or susceptibility.',
      'No antibiotic phenotype model was run by this parser.',
      'Organism identity is not verified by this parser.',
    ],
  };
  const errors = validateAmrNormalizedFeatures(output);
  if (errors.length) throw new Error(`Normalized AMR feature output failed validation: ${errors.join(' ')}`);
  return output;
}

function usage() {
  console.log('Usage: node scripts/parse-amrfinder-output.mjs <amrfinder.tsv> --output <features.json> --genome-id <id> --tool-version <version> --database-version <version> [--organism <name>] [--database-name <name>]');
}

async function main(args) {
  if (args.includes('--help') || args.includes('-h')) return usage();
  const value = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
  const inputPath = args.find(argument => !argument.startsWith('-'));
  const outputPath = value('--output');
  const genomeId = value('--genome-id');
  const toolVersion = value('--tool-version');
  const databaseVersion = value('--database-version');
  if (!inputPath || !outputPath || !genomeId || !toolVersion || !databaseVersion) throw new Error('Input, output, genome ID, tool version, and database version are required.');
  const bytes = await readFile(resolve(inputPath));
  const output = parseAmrfinderOutput(bytes.toString('utf8'), {
    genome_id: genomeId,
    organism: value('--organism'),
    tool_name: 'AMRFinderPlus',
    tool_version: toolVersion,
    database_name: value('--database-name') || 'AMRFinderPlus database',
    database_version: databaseVersion,
  });
  output.source_output = { filename: basename(inputPath), sha256: sha256(bytes) };
  await writeFile(resolve(outputPath), `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
  console.log(`Normalized AMRFinderPlus features written to ${outputPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`AMRFinderPlus parsing failed: ${error.message}`);
    process.exitCode = 1;
  });
}
