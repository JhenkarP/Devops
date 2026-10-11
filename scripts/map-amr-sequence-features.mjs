import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function mapSequenceFeatures(featureOutput, mapping) {
  if (!featureOutput || featureOutput.phenotype_status !== 'not_predicted') {
    throw new Error('Sequence feature input must be caller output with phenotype_status=not_predicted.');
  }
  if (!mapping || typeof mapping !== 'object' || !mapping.mapping_version || mapping.status !== 'approved' || typeof mapping.mappings !== 'object') {
    throw new Error('An approved, versioned determinant mapping is required.');
  }
  const mappedProducts = new Set();
  const unmapped = [];
  for (const feature of featureOutput.features || []) {
    const products = mapping.mappings[feature.determinant];
    if (!Array.isArray(products) || products.length === 0) {
      unmapped.push({ determinant: feature.determinant, type: feature.type });
      continue;
    }
    products.forEach(product => mappedProducts.add(product));
  }
  return {
    contract_version: featureOutput.contract_version,
    genome_id: featureOutput.genome_id,
    organism: typeof featureOutput.organism === 'string' ? featureOutput.organism : featureOutput.organism?.name || null,
    model_feature_vocabulary_version: mapping.model_feature_vocabulary_version || null,
    mapping_version: mapping.mapping_version,
    mapping_sha256: sha256(JSON.stringify(mapping)),
    model_products: [...mappedProducts].sort(),
    unmapped_features: unmapped,
    mapping_status: unmapped.length ? 'blocked_unmapped_features' : 'complete',
    phenotype_status: 'not_predicted',
    limitations: [
      'Mappings are explicit configuration and require scientific review before use.',
      'A mapped resistance product is an input feature, not a measured phenotype or treatment recommendation.',
    ],
  };
}

function value(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

async function main(args) {
  const inputPath = value(args, '--features');
  const mappingPath = value(args, '--mapping');
  const outputPath = value(args, '--output');
  if (!inputPath || !mappingPath || !outputPath) throw new Error('Features, mapping, and output paths are required.');
  const result = mapSequenceFeatures(
    JSON.parse(await readFile(resolve(inputPath), 'utf8')),
    JSON.parse(await readFile(resolve(mappingPath), 'utf8')),
  );
  await writeFile(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(`Sequence feature mapping written to ${outputPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`AMR feature mapping failed: ${error.message}`);
    process.exitCode = 1;
  });
}
