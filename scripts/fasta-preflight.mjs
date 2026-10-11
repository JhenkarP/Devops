import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DNA_BASES = new Set('ACGT');
const IUPAC_DNA_BASES = new Set('ACGTRYSWKMBDHVN');
const MAX_CONTIGS = 1_000_000;
const QUALITY_THRESHOLDS = { minimum_total_bases: 100000, maximum_contig_count: 500, minimum_n50: 1000, maximum_ambiguous_percent: 5 };

export async function analyzeFasta(inputPath) {
	const absolutePath = resolve(inputPath);
	const isCompressed = absolutePath.toLowerCase().endsWith('.gz');
	const digest = createHash('sha256');
	const input = createReadStream(absolutePath);
	const hashStream = new Transform({
		transform(chunk, encoding, callback) {
			digest.update(chunk);
			callback(null, chunk);
		},
	});
	const output = new PassThrough();
	const stages = [input, hashStream];
	if (isCompressed) stages.push(createGunzip());
	stages.push(output);
	const pipelinePromise = pipeline(...stages);
	const lines = createInterface({ input: output, crlfDelay: Infinity });
	const contigLengths = [];
	const identifiers = new Set();
	let currentContigLength = 0;
	let currentIdentifier = null;
	let lineNumber = 0;
	let totalBases = 0;
	let canonicalBases = 0;
	let gcBases = 0;
	let ambiguousBases = 0;

	function finishContig() {
		if (currentIdentifier === null) return;
		if (currentContigLength === 0) {
			throw new Error(`FASTA record "${currentIdentifier}" has no sequence.`);
		}
		contigLengths.push(currentContigLength);
	}

	try {
		for await (const rawLine of lines) {
			lineNumber += 1;
			const line = rawLine.trim();
			if (!line) continue;

			if (line.startsWith('>')) {
				finishContig();
				const header = line.slice(1).trim();
				const identifier = header.split(/\s+/, 1)[0];
				if (!identifier) throw new Error(`FASTA header on line ${lineNumber} has no identifier.`);
				if (identifiers.has(identifier)) throw new Error(`Duplicate FASTA identifier "${identifier}" on line ${lineNumber}.`);
				if (identifiers.size >= MAX_CONTIGS) {
					throw new Error(`FASTA exceeds the safety limit of ${MAX_CONTIGS.toLocaleString()} contigs.`);
				}
				identifiers.add(identifier);
				currentIdentifier = identifier;
				currentContigLength = 0;
				continue;
			}

			if (currentIdentifier === null) {
				throw new Error(`Sequence data appears before the first FASTA header on line ${lineNumber}.`);
			}

			for (const base of line.toUpperCase()) {
				if (!IUPAC_DNA_BASES.has(base)) {
					throw new Error(`Invalid nucleotide "${base}" on line ${lineNumber}.`);
				}
				currentContigLength += 1;
				totalBases += 1;
				if (DNA_BASES.has(base)) {
					canonicalBases += 1;
					if (base === 'G' || base === 'C') gcBases += 1;
				} else {
					ambiguousBases += 1;
				}
			}
		}
		finishContig();
		await pipelinePromise;
	} catch (error) {
		lines.close();
		input.destroy();
		output.destroy();
		await pipelinePromise.catch(() => {});
		throw error;
	}

	if (contigLengths.length === 0) throw new Error('Input contains no FASTA records.');
	contigLengths.sort((left, right) => right - left);
	const halfGenomeSize = totalBases / 2;
	let cumulativeLength = 0;
	let n50 = 0;
	let l50 = 0;
	for (const length of contigLengths) {
		cumulativeLength += length;
		l50 += 1;
		if (cumulativeLength >= halfGenomeSize) {
			n50 = length;
			break;
		}
	}

	const ambiguousPercent = Number(((ambiguousBases / totalBases) * 100).toFixed(4));
	const qualityFailures = [];
	if (totalBases < QUALITY_THRESHOLDS.minimum_total_bases) qualityFailures.push('total_bases_below_minimum');
	if (contigLengths.length > QUALITY_THRESHOLDS.maximum_contig_count) qualityFailures.push('contig_count_above_maximum');
	if (n50 < QUALITY_THRESHOLDS.minimum_n50) qualityFailures.push('n50_below_minimum');
	if (ambiguousPercent > QUALITY_THRESHOLDS.maximum_ambiguous_percent) qualityFailures.push('ambiguous_bases_above_maximum');
	return {
		report_version: 'fasta-preflight-1',
		input_file: basename(inputPath),
		input_compression: isCompressed ? 'gzip' : 'none',
		input_sha256: digest.digest('hex'),
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
		gc_percent_of_canonical_bases: canonicalBases === 0 ? null : Number(((gcBases / canonicalBases) * 100).toFixed(4)),
		ambiguous_bases: ambiguousBases,
		ambiguous_percent: ambiguousPercent,
		limitations: [
			'This report checks FASTA structure and nucleotide characters only.',
			'Taxonomy, resistance determinants, and phenotype are not assessed by this preflight.',
		],
	};
}

function printUsage() {
	console.log('Usage: node scripts/fasta-preflight.mjs <assembly.fasta[.gz]> [--output report.json]');
}

async function main(args) {
	if (args.includes('--help') || args.includes('-h')) {
		printUsage();
		return;
	}

	let inputPath;
	let outputPath;
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === '--output') {
			outputPath = args[index + 1];
			if (!outputPath) throw new Error('--output requires a report path.');
			index += 1;
		} else if (args[index].startsWith('-')) {
			throw new Error(`Unknown option: ${args[index]}`);
		} else if (inputPath === undefined) {
			inputPath = args[index];
		} else {
			throw new Error('Only one input FASTA file may be supplied.');
		}
	}

	if (!inputPath) throw new Error('Input FASTA path is required.');
	const report = await analyzeFasta(inputPath);
	const serialized = `${JSON.stringify(report, null, 2)}\n`;
	if (outputPath) {
		await writeFile(outputPath, serialized, { flag: 'wx' });
		console.log(`Preflight report written to ${outputPath}`);
	} else {
		process.stdout.write(serialized);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(`FASTA preflight failed: ${error.message}`);
		process.exitCode = 1;
	});
}