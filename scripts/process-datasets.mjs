import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../data/', import.meta.url));
const outputDirectory = join(root, 'processed');
const execFileAsync = promisify(execFile);
const readJson = async name => JSON.parse(await readFile(join(root, name), 'utf8'));
const writeJson = async (name, value) => writeFile(join(outputDirectory, name), `${JSON.stringify(value, null, 2)}\n`);
const text = value => String(value ?? '').trim();
const lower = value => text(value).toLowerCase();
const hash = value => [...text(value)].reduce((total, character) => ((total * 31) + character.charCodeAt(0)) % 1000003, 7);

const antibioticAliases = new Map([
  ['amikacin', 'amikacin'], ['azithromycin', 'azithromycin'], ['cipro', 'ciprofloxacin'],
  ['ciprofloxacin', 'ciprofloxacin'], ['colistin', 'colistin'], ['gentamicin', 'gentamicin'],
  ['imipenem', 'imipenem'], ['meropenem', 'meropenem'], ['tetracycline', 'tetracycline'],
  ['trimethoprim-sulfamethoxazole', 'trimethoprim-sulfamethoxazole'], ['trimethoprim/sulfamethoxazole', 'trimethoprim-sulfamethoxazole']
]);
const genericHpoTerms = new Set(['HP:0000001', 'HP:0000118', 'HP:0012823']);

function normalizeOrganism(record) {
  const value = text(record.organism || record.species || record.genome_name || record.genome_name_txt);
  return value.replace(/\s+(strain|isolate|sample)\b.*$/i, '').replace(/\s+/g, ' ').trim() || 'Unknown organism';
}

function normalizeAntibiotic(value) {
  const normalized = lower(value).replace(/\s+/g, ' ');
  return antibioticAliases.get(normalized) || normalized.replace(/\s*\/\s*/g, '/');
}

function normalizeLabel(value) {
  const normalized = lower(value);
  if (normalized.startsWith('resist')) return 'resistant';
  if (normalized.startsWith('suscept')) return 'susceptible';
  if (normalized.startsWith('intermed')) return 'intermediate';
  return 'unknown';
}

function explicitYear(record) {
  const value = record.collection_year ?? record.collectionYear ?? record.year;
  const year = Number.parseInt(text(value), 10);
  return Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null;
}

function featureValues(record) {
  const values = [];
  for (const [key, value] of Object.entries(record)) {
    if (!/(gene|mutation|variant|allele|amr)/i.test(key) || typeof value !== 'string') continue;
    values.push(...value.split(/[;,|\n]+/).map(item => item.trim()).filter(item => item.length > 1));
  }
  values.push(...(record.resistance_features || []).map(feature => text(feature.product)).filter(Boolean));
  return [...new Set(values)].slice(0, 100);
}

function splitFor(record) {
  const year = explicitYear(record);
  const laboratory = text(record.laboratory || record.laboratory_name || record.owner || record.testing_standard) || 'unknown-laboratory';
  const geography = text(record.geographic_location || record.isolation_country || record.geographic_group) || 'unknown-geography';
  return {
    temporal: year === null ? 'unassigned-missing-year' : year >= 2024 ? 'test' : year >= 2022 ? 'validation' : 'train',
    laboratory: `group-${hash(laboratory) % 5 < 3 ? 'train' : hash(laboratory) % 5 === 3 ? 'validation' : 'test'}`,
    geography: `group-${hash(geography) % 5 < 3 ? 'train' : hash(geography) % 5 === 3 ? 'validation' : 'test'}`
  };
}

function normalizeAmrRecord(record) {
  const features = featureValues(record);
  const genomeId = text(record.genome_id || record.genome_identifier || record.genome);
  const antibiotic = normalizeAntibiotic(record.antibiotic || record.drug);
  const label = normalizeLabel(record.resistant_phenotype || record.phenotype || record.resistance);
  return {
    source_id: text(record.id) || `${genomeId}:${antibiotic}`,
    genome_id: genomeId || null,
    organism: normalizeOrganism(record),
    antibiotic,
    label,
    genes: features.filter(value => !/(mutation|variant|allele)/i.test(value)),
    mutations: features.filter(value => /(mutation|variant|allele)/i.test(value)),
    collection_year: explicitYear(record),
    laboratory: text(record.laboratory || record.laboratory_name || record.owner) || null,
    geography: text(record.geographic_location || record.isolation_country || record.geographic_group) || null,
    testing_method: text(record.laboratory_typing_method || record.testing_method || record.computational_method) || null,
    testing_standard: text(record.testing_standard),
    measurement: text(record.measurement || record.measurement_value) || null,
    resistance_feature_calls: (record.resistance_features || []).map(feature => ({ feature_id: feature.feature_id, product: feature.product || null, location: feature.location || null, aa_sequence_md5: feature.aa_sequence_md5 || null, na_sequence_md5: feature.na_sequence_md5 || null })),
    feature_status: features.length ? 'provided-by-source' : 'missing-genome-feature-link',
    split: splitFor(record)
  };
}

function normalizeHpoTerm(node) {
  const synonyms = node.meta?.synonyms || [];
  const identifier = text(node.id).replace(/^.*\/obo\/HP_/, 'HP:').replace(/_/g, ':');
  return {
    id: identifier,
    name: text(node.lbl),
    synonyms: synonyms.map(item => text(item.val)).filter(Boolean).slice(0, 25)
  };
}

function hpoId(value) {
  return text(value).replace(/^.*\/obo\/HP_/, 'HP:').replace(/_/g, ':');
}

function normalizeHpoAnnotation(fields, header) {
  const record = Object.fromEntries(header.map((name, index) => [name, fields[index] || '']));
  const qualifier = lower(record.qualifier);
  return {
    disease_id: text(record.database_id),
    disease_name: text(record.disease_name),
    hpo_id: text(record.hpo_id),
    status: qualifier.includes('not') ? 'absent' : 'present',
    evidence: text(record.evidence) || null,
    onset: text(record.onset) || null,
    frequency: text(record.frequency) || null,
    reference: text(record.reference) || null,
    biocuration: text(record.biocuration) || null
  };
}

const amrSource = await readJson('bvbrc_genome_amr.json');
const ontology = await readJson('hp.json');
const annotationText = await readFile(join(root, 'hpo_annotations.hpoa'), 'utf8');
await mkdir(outputDirectory, { recursive: true });

async function fetchGenomeMetadata(ids) {
  const metadata = new Map();
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);
    const query = `https://www.bv-brc.org/api/genome/?in(genome_id,(${batch.join(',')}))&limit(${batch.length})`;
    try {
      let body;
      if (process.platform === 'win32') {
        const result = await execFileAsync('curl.exe', ['-k', '-L', '--fail', '--max-time', '60', query], { maxBuffer: 20 * 1024 * 1024 });
        body = result.stdout;
      } else {
        const response = await fetch(query);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        body = await response.text();
      }
      for (const record of JSON.parse(body)) metadata.set(text(record.genome_id), record);
    } catch (error) {
      console.warn(`Could not enrich BV-BRC genome batch ${offset}-${offset + batch.length}: ${error.message}`);
    }
  }
  return metadata;
}

async function fetchResistanceFeatures(ids) {
  const features = new Map();
  const batches = [];
  for (let offset = 0; offset < ids.length; offset += 25) batches.push({ offset, ids: ids.slice(offset, offset + 25) });
  await Promise.all(batches.map(async ({ offset, ids: batch }) => {
    const query = `https://www.bv-brc.org/api/genome_feature/?in(genome_id,(${batch.join(',')}))&keyword(resistance)&limit(5000)`;
    try {
      let body;
      if (process.platform === 'win32') {
        const result = await execFileAsync('curl.exe', ['-k', '-L', '--fail', '--max-time', '60', query], { maxBuffer: 20 * 1024 * 1024 });
        body = result.stdout;
      } else {
        const response = await fetch(query);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        body = await response.text();
      }
      for (const feature of JSON.parse(body)) {
        if (!features.has(text(feature.genome_id))) features.set(text(feature.genome_id), []);
        features.get(text(feature.genome_id)).push(feature);
      }
    } catch (error) {
      console.warn(`Could not fetch resistance features ${offset}-${offset + batch.length}: ${error.message}`);
    }
  }));
  return features;
}

const genomeIds = [...new Set(amrSource.map(record => text(record.genome_id)).filter(Boolean))];
const genomeMetadata = await fetchGenomeMetadata(genomeIds);
const resistanceFeatures = await fetchResistanceFeatures(genomeIds);
const enrichedAmrSource = amrSource.map(record => ({ ...genomeMetadata.get(text(record.genome_id)), ...record, resistance_features: resistanceFeatures.get(text(record.genome_id)) || [] }));
const normalizedAmr = enrichedAmrSource.map(normalizeAmrRecord).filter(record => record.genome_id && record.antibiotic);
const uniqueAmr = [...new Map(normalizedAmr.map(record => [`${record.genome_id}|${record.antibiotic}|${record.testing_method}|${record.label}`, record])).values()];
const groupedLabels = new Map();
for (const record of uniqueAmr) {
  const key = `${record.genome_id}|${record.antibiotic}`;
  if (!groupedLabels.has(key)) groupedLabels.set(key, new Set());
  groupedLabels.get(key).add(record.label);
}
const conflicts = [...groupedLabels.entries()]
  .filter(([, labels]) => labels.size > 1)
  .map(([key, labels]) => ({ key, labels: [...labels].sort() }));

const lines = annotationText.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
const annotationHeader = lines.shift().split('\t');
const annotations = lines.map(line => normalizeHpoAnnotation(line.split('\t'), annotationHeader)).filter(record => record.disease_id && record.hpo_id);
const termNodes = (ontology.graphs || []).flatMap(graph => graph.nodes || []).map(normalizeHpoTerm).filter(term => term.id.startsWith('HP:'));
const graphEdges = (ontology.graphs || []).flatMap(graph => graph.edges || [])
  .filter(edge => edge.pred === 'is_a')
  .map(edge => ({ child: hpoId(edge.sub), parent: hpoId(edge.obj) }))
  .filter(edge => edge.child.startsWith('HP:') && edge.parent.startsWith('HP:'));
const parentMap = new Map();
for (const edge of graphEdges) {
  if (!parentMap.has(edge.child)) parentMap.set(edge.child, []);
  parentMap.get(edge.child).push(edge.parent);
}
function ancestors(term) {
  const output = new Set();
  const queue = [...(parentMap.get(term) || [])];
  while (queue.length) {
    const current = queue.shift();
    if (output.has(current) || output.size >= 25) continue;
    output.add(current);
    queue.push(...(parentMap.get(current) || []));
  }
  return [...output];
}
const termIndex = new Map(termNodes.map(term => [term.id, term]));
const profiles = new Map();
for (const annotation of annotations) {
  if (genericHpoTerms.has(annotation.hpo_id)) continue;
  if (!profiles.has(annotation.disease_id)) profiles.set(annotation.disease_id, { disease_id: annotation.disease_id, disease_name: annotation.disease_name, present: [], absent: [], evidence: [] });
  const profile = profiles.get(annotation.disease_id);
  const target = annotation.status === 'absent' ? profile.absent : profile.present;
  if (!target.some(item => item.hpo_id === annotation.hpo_id)) target.push({ hpo_id: annotation.hpo_id, term: termIndex.get(annotation.hpo_id)?.name || null, ancestors: ancestors(annotation.hpo_id), frequency: annotation.frequency, onset: annotation.onset });
  profile.evidence.push({ hpo_id: annotation.hpo_id, evidence: annotation.evidence, reference: annotation.reference, biocuration: annotation.biocuration });
}
const diseaseProfiles = [...profiles.values()].map(profile => ({ ...profile, present: profile.present.slice(0, 500), absent: profile.absent.slice(0, 500), evidence: profile.evidence.slice(0, 1000) }));
const robustness = diseaseProfiles.slice(0, 100).map(profile => ({
  disease_id: profile.disease_id,
  original_terms: profile.present.length,
  missing_variant_terms: profile.present.filter((_, index) => index % 5 !== 0).length,
  noisy_variant_terms: profile.present.length + (profile.present.length ? 1 : 0)
}));
const phenotypeTerms = termNodes.map(term => ({ ...term, normalized_name: lower(term.name), synonym_names: term.synonyms.map(lower) }));
const samplePhenotypes = ['developmental delay', 'congenital heart defect', 'hearing loss'];
const normalizedSamplePhenotypes = samplePhenotypes.map(input => {
  const normalized = lower(input);
  const exact = phenotypeTerms.find(term => term.normalized_name === normalized || term.synonym_names.includes(normalized));
  const partial = exact || phenotypeTerms.find(term => term.normalized_name.includes(normalized) || normalized.includes(term.normalized_name));
  return { input, hpo_id: partial?.id || null, matched_term: partial?.name || null, match_type: exact ? 'exact-or-synonym' : partial ? 'partial' : 'unmatched' };
});

await writeJson('amr_normalized.json', uniqueAmr);
await writeJson('amr_conflicts.json', conflicts);
await writeJson('hpo_term_index.json', termNodes);
await writeJson('hpo_graph.json', { nodes: termNodes.map(term => term.id), edges: graphEdges });
await writeJson('rare_disease_profiles.json', diseaseProfiles);
await writeJson('rare_disease_robustness_samples.json', robustness);
await writeJson('rare_disease_input_normalization_sample.json', { inputs: samplePhenotypes, normalized: normalizedSamplePhenotypes });
await writeJson('processing_report.json', {
  generated_at: new Date().toISOString(),
  amr: { source_records: amrSource.length, normalized_records: normalizedAmr.length, genome_metadata_matches: genomeMetadata.size, genomes_with_resistance_feature_calls: resistanceFeatures.size, resistance_feature_calls: [...resistanceFeatures.values()].reduce((total, items) => total + items.length, 0), deduplicated_records: uniqueAmr.length, conflicts: conflicts.length, missing_genome_feature_links: uniqueAmr.filter(record => record.feature_status !== 'provided-by-source').length, split_counts: { temporal: uniqueAmr.filter(record => record.split.temporal !== 'unassigned-missing-year').length, laboratory: uniqueAmr.filter(record => record.split.laboratory).length, geography: uniqueAmr.filter(record => record.split.geography).length } },
  rare_disease: { source_annotations: annotations.length, disease_profiles: diseaseProfiles.length, hpo_terms_indexed: termNodes.length, hpo_graph_edges: graphEdges.length, generic_terms_removed: genericHpoTerms.size, robustness_samples: robustness.length, sample_input_matches: normalizedSamplePhenotypes.filter(item => item.hpo_id).length },
  warnings: ['BV-BRC genome_feature queries provide resistance-associated feature calls, but explicit mutation calls are not available in the downloaded source.', 'Rare-disease resources are knowledge annotations and public examples, not a patient validation cohort.']
});
console.log(`Processed ${uniqueAmr.length} AMR records and ${diseaseProfiles.length} rare-disease profiles`);