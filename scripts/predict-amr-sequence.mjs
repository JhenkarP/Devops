import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildSequenceRequests(mappedFeatures, antibiotics) {
  if (!mappedFeatures || mappedFeatures.mapping_status !== 'complete') {
    throw new Error('Sequence prediction is blocked until every detected determinant has a reviewed mapping.');
  }
  if (!mappedFeatures.organism || !mappedFeatures.genome_id) {
    throw new Error('Mapped sequence features must include organism and genome_id.');
  }
  return antibiotics.map(antibiotic => ({
    organism: mappedFeatures.organism,
    antibiotic,
    products: mappedFeatures.model_products,
  }));
}

function value(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

async function main(args) {
  const mappedPath = value(args, '--mapped-features');
  const outputPath = value(args, '--output');
  const apiUrl = value(args, '--api') || 'http://localhost:3001';
  const antibiotics = args.filter((arg, index) => args[index - 1] === '--antibiotic');
  if (!mappedPath || !outputPath || antibiotics.length === 0) {
    throw new Error('Mapped features, output, and at least one --antibiotic are required.');
  }
  const mappedFeatures = JSON.parse(await readFile(resolve(mappedPath), 'utf8'));
  const requests = buildSequenceRequests(mappedFeatures, antibiotics);
  const results = [];
  for (const request of requests) {
    const response = await fetch(`${apiUrl.replace(/\/$/, '')}/api/amr/predict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`${request.antibiotic}: model request failed (${response.status})`);
    results.push({ antibiotic: request.antibiotic, ...body });
  }
  const panel = {
    contract_version: mappedFeatures.contract_version,
    genome_id: mappedFeatures.genome_id,
    organism: mappedFeatures.organism,
    mapping_version: mappedFeatures.mapping_version,
    model_feature_vocabulary_version: mappedFeatures.model_feature_vocabulary_version,
    phenotype_status: 'research_model_prediction_only',
    results,
    limitations: [
      'Predictions use the existing uncalibrated model and mapped sequence determinants.',
      'Results are research-only and do not establish susceptibility, effectiveness, or treatment suitability.',
    ],
  };
  await writeFile(resolve(outputPath), `${JSON.stringify(panel, null, 2)}\n`, { flag: 'wx' });
  console.log(`Sequence prediction panel written to ${outputPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Sequence prediction failed: ${error.message}`);
    process.exitCode = 1;
  });
}
