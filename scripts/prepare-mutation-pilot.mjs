import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../data/', import.meta.url));
const output = join(root, 'processed', 'mutation_pilot_candidates.json');
const execFileAsync = promisify(execFile);
const text = value => String(value ?? '').trim();
const supportedSpecies = new Set([
  'Escherichia coli',
  'Klebsiella pneumoniae',
  'Mycobacterium tuberculosis',
  'Salmonella enterica',
  'Staphylococcus aureus'
]);

const amr = JSON.parse(await readFile(join(root, 'bvbrc_genome_amr.json'), 'utf8'));
const candidates = new Map();
const genomeIds = [...new Set(amr.map(record => text(record.genome_id)).filter(Boolean))];

for (let offset = 0; offset < genomeIds.length && candidates.size < 110; offset += 50) {
  const batch = genomeIds.slice(offset, offset + 50);
  const query = `https://www.bv-brc.org/api/genome/?in(genome_id,(${batch.join(',')}))&limit(${batch.length})`;
  try {
    const { stdout } = await execFileAsync('curl.exe', ['-k', '-L', '--fail', '--max-time', '60', query], { maxBuffer: 20 * 1024 * 1024 });
    for (const genome of JSON.parse(stdout)) {
      const species = text(genome.species);
      const assembly = text(genome.assembly_accession);
      if (!supportedSpecies.has(species) || !/^GC[AF]_\d+\.\d+$/i.test(assembly)) continue;
      const observations = amr
        .filter(record => text(record.genome_id) === text(genome.genome_id))
        .map(record => ({ antibiotic: text(record.antibiotic), phenotype: text(record.resistant_phenotype) }));
      candidates.set(text(genome.genome_id), {
        genome_id: text(genome.genome_id),
        genome_name: text(genome.genome_name),
        species,
        assembly_accession: text(genome.assembly_accession),
        genbank_accessions: text(genome.genbank_accessions),
        refseq_accessions: text(genome.refseq_accessions),
        bioproject_accession: text(genome.bioproject_accession),
        observations
      });
      if (candidates.size >= 110) break;
    }
  } catch (error) {
    console.warn(`Could not fetch mutation pilot metadata ${offset}-${offset + batch.length}: ${error.message}`);
  }
}

const result = {
  generated_at: new Date().toISOString(),
  target_count: 110,
  candidate_count: candidates.size,
  supported_species: [...supportedSpecies],
  source: 'BV-BRC genome metadata joined to local AMR records',
  candidates: [...candidates.values()]
};
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Prepared ${result.candidate_count} mutation pilot candidates at ${output}`);