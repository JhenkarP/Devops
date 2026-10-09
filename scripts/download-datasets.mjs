import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = new URL('../data/', import.meta.url);
const dataDirectory = fileURLToPath(root);
const execFileAsync = promisify(execFile);
const targets = [
  { name: 'hp.json', urls: ['https://github.com/obophenotype/human-phenotype-ontology/releases/latest/download/hp.json'], role: 'HPO ontology reference' },
  { name: 'hpo_annotations.hpoa', urls: ['https://purl.obolibrary.org/obo/hp/hpoa/phenotype.hpoa'], role: 'HPO disease annotations' },
  { name: 'mondo.json', urls: ['https://github.com/monarch-initiative/mondo/releases/latest/download/mondo.json'], role: 'MONDO disease ontology' },
  { name: 'monarch_disease_phenotype_associations.json', urls: ['https://api.monarchinitiative.org/v3/api/association/?limit=100'], role: 'Monarch disease-phenotype associations (bounded public export)' },
  { name: 'phenopacket-store.zip', urls: ['https://github.com/monarch-initiative/phenopacket-store/archive/refs/heads/main.zip'], role: 'Public Phenopacket examples and benchmark cases', binary: true },
  { name: 'orphadata_disease.xml', urls: ['https://www.orphadata.com/data/xml/en_product1.xml'], role: 'Orphadata disease resource (licensing subject to review)' },
  { name: 'amrfinder_reference_genes.tsv', urls: ['https://ftp.ncbi.nlm.nih.gov/pathogen/Antimicrobial_resistance/AMRFinderPlus/database/latest/ReferenceGeneCatalog.txt'], role: 'AMRFinderPlus resistance reference catalog' },
  { name: 'bvbrc_genome_metadata.json', urls: ['https://www.bv-brc.org/api/genome/?limit(1000)'], role: 'BV-BRC genome metadata (bounded export)' },
  { name: 'bvbrc_genome_amr.json', urls: ['https://www.bv-brc.org/api/genome_amr/?limit(10000)'], role: 'BV-BRC antimicrobial resistance and susceptibility records (bounded export)' },
  { name: 'ncbi_pathogen_resistance_metadata.json', urls: ['https://ftp.ncbi.nlm.nih.gov/pathogen/Antimicrobial_resistance/AMRFinderPlus/database/latest/version.txt'], role: 'NCBI pathogen resistance database version metadata' },
  { name: 'resfinder_db.zip', urls: ['https://bitbucket.org/genomicepidemiology/resfinder_db/get/master.zip'], role: 'ResFinder resistance reference annotations', binary: true }
];
await mkdir(dataDirectory, { recursive: true });
const manifest = { downloaded_at: new Date().toISOString(), sources: [] };
for (const target of targets) {
  const destination = join(dataDirectory, target.name);
  try {
    let sourceUrl;
    let transport = 'fetch';
    let content;
    let lastError;
    for (const url of target.urls) {
      sourceUrl = url;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'SignalLab/0.1 research-data-client' } });
          if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
          content = target.binary ? Buffer.from(await response.arrayBuffer()) : await response.text();
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (content) break;
    }
    if (!content && process.platform === 'win32') {
      transport = 'curl-insecure-fallback';
      try {
        await execFileAsync('curl.exe', ['-k', '-L', '--fail', '--retry', '2', '--connect-timeout', '20', '-A', 'SignalLab/0.1 research-data-client', '-o', destination, sourceUrl]);
        content = await readFile(destination, target.binary ? undefined : 'utf8');
      } catch (error) {
        lastError = error;
      }
    }
    if (!content) throw lastError || new Error('No content returned');
    await writeFile(destination, content);
    const file = await stat(destination);
    const checksum = createHash('sha256').update(content).digest('hex');
    manifest.sources.push({ name: target.name, url: sourceUrl, role: target.role, status: 'downloaded', transport, bytes: file.size, sha256: checksum });
    console.log(`Downloaded ${target.name} (${file.size} bytes)`);
  } catch (error) {
    manifest.sources.push({ name: target.name, url: target.urls[0], role: target.role, status: 'failed', error: error.message });
    console.warn(`Could not download ${target.name}: ${error.message}`);
  }
}
await writeFile(join(dataDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('Wrote data/manifest.json');
