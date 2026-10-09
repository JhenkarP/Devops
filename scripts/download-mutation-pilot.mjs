import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../data/', import.meta.url));
const pilotDirectory = join(root, 'mutation_pilot');
const manifestPath = join(root, 'processed', 'mutation_pilot_candidates.json');
const provenancePath = join(pilotDirectory, 'manifest.json');
const execFileAsync = promisify(execFile);
const text = value => String(value ?? '').trim();

const pilot = JSON.parse(await readFile(manifestPath, 'utf8'));
await mkdir(pilotDirectory, { recursive: true });
const downloaded = [];

for (const candidate of pilot.candidates) {
  if (downloaded.filter(item => item.status === 'downloaded').length >= 100) break;
  const accession = text(candidate.assembly_accession);
  const archive = join(pilotDirectory, `${accession}.zip`);
  const url = `https://api.ncbi.nlm.nih.gov/datasets/v2/genome/accession/${accession}/download?include_annotation_type=GENOME_FASTA`;
  try {
    await execFileAsync('curl.exe', ['-k', '-L', '--fail', '--retry', '3', '--max-time', '300', url, '-o', archive], { maxBuffer: 5 * 1024 * 1024 });
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    downloaded.push({ ...candidate, url, archive: `${accession}.zip`, sha256: digest, status: 'downloaded' });
    console.log(`Downloaded ${accession}`);
  } catch (error) {
    downloaded.push({ ...candidate, url, status: 'failed', error: error.message });
    console.warn(`Failed ${accession}: ${error.message}`);
  }
}

await writeFile(provenancePath, `${JSON.stringify({ generated_at: new Date().toISOString(), target_count: 100, downloaded_count: downloaded.filter(item => item.status === 'downloaded').length, candidates: downloaded }, null, 2)}\n`);
console.log(`Mutation pilot downloads recorded at ${provenancePath}`);