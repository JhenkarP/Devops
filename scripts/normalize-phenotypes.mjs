import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../data/', import.meta.url));
const inputPath = process.argv[2] || 'rare_disease/phenotype_inputs.example.json';
const input = JSON.parse(await readFile(join(root, inputPath), 'utf8'));
const terms = JSON.parse(await readFile(join(root, 'rare_disease/processed/hpo_term_index.json'), 'utf8'));
const graph = JSON.parse(await readFile(join(root, 'rare_disease/processed/hpo_graph.json'), 'utf8'));
const values = Array.isArray(input) ? input : input.phenotypes || [];
const lower = value => String(value || '').trim().toLowerCase();
const parents = new Map();
for (const edge of graph.edges) {
  if (!parents.has(edge.child)) parents.set(edge.child, []);
  parents.get(edge.child).push(edge.parent);
}
const ancestors = id => {
  const result = new Set();
  const queue = [...(parents.get(id) || [])];
  while (queue.length && result.size < 25) {
    const current = queue.shift();
    if (result.has(current)) continue;
    result.add(current);
    queue.push(...(parents.get(current) || []));
  }
  return [...result];
};
const normalized = values.map(value => {
  const query = lower(value);
  const exact = terms.find(term => lower(term.name) === query || term.synonyms.some(synonym => lower(synonym) === query));
  const partial = exact || terms.find(term => lower(term.name).includes(query) || query.includes(lower(term.name)));
  return { input: String(value), hpo_id: partial?.id || null, matched_term: partial?.name || null, ancestors: partial?.id ? ancestors(partial.id) : [], match_type: exact ? 'exact-or-synonym' : partial ? 'partial' : 'unmatched' };
});
await mkdir(join(root, 'rare_disease', 'processed'), { recursive: true });
await writeFile(join(root, 'rare_disease/processed/patient_phenotypes_normalized.json'), `${JSON.stringify({ source: inputPath, normalized }, null, 2)}\n`);
console.log(`Normalized ${normalized.length} phenotype inputs (${normalized.filter(item => item.hpo_id).length} matched)`);