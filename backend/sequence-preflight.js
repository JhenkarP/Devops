import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const DNA_BASES = new Set('ACGT');
const IUPAC_DNA_BASES = new Set('ACGTRYSWKMBDHVN');
const MAX_CONTIGS = 1_000_000;
const QUALITY_THRESHOLDS = {
  minimum_total_bases: 100_000,
  maximum_contig_count: 500,
  minimum_n50: 1_000,
  maximum_ambiguous_percent: 5,
};

export function preflightFasta(bytes, filename) {
  const inputSha256 = createHash('sha256').update(bytes).digest('hex');
  const compressed = /\.gz$/i.test(filename);
  const contents = compressed ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
  const contigLengths = [];
  const identifiers = new Set();
  let currentIdentifier = null;
  let currentLength = 0;
  let totalBases = 0;
  let canonicalBases = 0;
  let gcBases = 0;
  let ambiguousBases = 0;
  let lineNumber = 0;

  function finishContig() {
    if (currentIdentifier === null) return;
    if (currentLength === 0) throw new Error(`FASTA record "${currentIdentifier}" has no sequence.`);
    contigLengths.push(currentLength);
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('>')) {
      finishContig();
      const identifier = line.slice(1).trim().split(/\s+/, 1)[0];
      if (!identifier) throw new Error(`FASTA header on line ${lineNumber} has no identifier.`);
      if (identifiers.has(identifier)) throw new Error(`Duplicate FASTA identifier "${identifier}" on line ${lineNumber}.`);
      if (identifiers.size >= MAX_CONTIGS) throw new Error(`FASTA exceeds the safety limit of ${MAX_CONTIGS.toLocaleString()} contigs.`);
      identifiers.add(identifier);
      currentIdentifier = identifier;
      currentLength = 0;
      continue;
    }
    if (currentIdentifier === null) throw new Error(`Sequence data appears before the first FASTA header on line ${lineNumber}.`);
    for (const base of line.toUpperCase()) {
      if (!IUPAC_DNA_BASES.has(base)) throw new Error(`Invalid nucleotide "${base}" on line ${lineNumber}.`);
      currentLength += 1;
      totalBases += 1;
      if (DNA_BASES.has(base)) {
        canonicalBases += 1;
        if (base === 'G' || base === 'C') gcBases += 1;
      } else ambiguousBases += 1;
    }
  }
  finishContig();
  if (!contigLengths.length) throw new Error('Input contains no FASTA records.');
  contigLengths.sort((left, right) => right - left);
  let cumulative = 0;
  let n50 = 0;
  let l50 = 0;
  for (const length of contigLengths) {
    cumulative += length;
    l50 += 1;
    if (cumulative >= totalBases / 2) { n50 = length; break; }
  }
  const qualityFailures = [];
  if (totalBases < QUALITY_THRESHOLDS.minimum_total_bases) qualityFailures.push('total_bases_below_minimum');
  if (contigLengths.length > QUALITY_THRESHOLDS.maximum_contig_count) qualityFailures.push('contig_count_above_maximum');
  if (n50 < QUALITY_THRESHOLDS.minimum_n50) qualityFailures.push('n50_below_minimum');
  const ambiguousPercent = Number(((ambiguousBases / totalBases) * 100).toFixed(4));
  if (ambiguousPercent > QUALITY_THRESHOLDS.maximum_ambiguous_percent) qualityFailures.push('ambiguous_bases_above_maximum');
  return {
    report_version: 'fasta-preflight-1',
    input_file: filename,
    input_compression: compressed ? 'gzip' : 'none',
    input_sha256: inputSha256,
    fasta_status: 'valid',
    assembly_quality_status: qualityFailures.length ? 'failed' : 'passed',
    assembly_quality_thresholds: QUALITY_THRESHOLDS,
    assembly_quality_failures: qualityFailures,
    contig_count: contigLengths.length,
    total_bases: totalBases,
    minimum_contig_length: contigLengths.at(-1),
    maximum_contig_length: contigLengths[0],
    n50,
    l50,
    gc_percent_of_canonical_bases: canonicalBases ? Number(((gcBases / canonicalBases) * 100).toFixed(4)) : null,
    ambiguous_bases: ambiguousBases,
    ambiguous_percent: ambiguousPercent,
    limitations: [
      'This report checks FASTA structure and nucleotide characters only.',
      'Assembly quality thresholds, taxonomy, resistance determinants, and phenotype are not assessed.',
    ],
  };
}
