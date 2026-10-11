import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { analyzeFasta } from './fasta-preflight.mjs';

async function withTempDirectory(run) {
	const directory = await mkdtemp(join(tmpdir(), 'signallab-fasta-preflight-'));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test('reports assembly statistics and explicitly leaves quality unassessed', async () => {
	await withTempDirectory(async (directory) => {
		const inputPath = join(directory, 'assembly.fna');
		const contents = '>contig-1 description\nACgt\n>contig-2\nNNNAAA\n>contig-3\nGC\n';
		await writeFile(inputPath, contents);

		const report = await analyzeFasta(inputPath);

		assert.equal(report.fasta_status, 'valid');
		assert.equal(report.assembly_quality_status, 'failed');
		assert.ok(report.assembly_quality_failures.includes('total_bases_below_minimum'));
		assert.equal(report.contig_count, 3);
		assert.equal(report.total_bases, 12);
		assert.equal(report.minimum_contig_length, 2);
		assert.equal(report.maximum_contig_length, 6);
		assert.equal(report.n50, 6);
		assert.equal(report.l50, 1);
		assert.equal(report.gc_percent_of_canonical_bases, 44.4444);
		assert.equal(report.ambiguous_bases, 3);
		assert.equal(report.ambiguous_percent, 25);
		assert.equal(report.input_sha256, createHash('sha256').update(contents).digest('hex'));
	});
});

test('reads gzip FASTA and hashes the original compressed input', async () => {
	await withTempDirectory(async (directory) => {
		const inputPath = join(directory, 'assembly.fasta.gz');
		const compressed = gzipSync('>contig-1\nACGTN\n');
		await writeFile(inputPath, compressed);

		const report = await analyzeFasta(inputPath);

		assert.equal(report.input_compression, 'gzip');
		assert.equal(report.total_bases, 5);
		assert.equal(report.ambiguous_bases, 1);
		assert.equal(report.input_sha256, createHash('sha256').update(compressed).digest('hex'));
	});
});

test('rejects sequence before a header, invalid bases, duplicate IDs, and empty records', async () => {
	await withTempDirectory(async (directory) => {
		const invalidCases = [
			['before-header.fna', 'ACGT\n', /before the first FASTA header/],
			['invalid-base.fna', '>contig-1\nACGTX\n', /Invalid nucleotide "X"/],
			['duplicate-id.fna', '>same\nAC\n>same\nGT\n', /Duplicate FASTA identifier/],
			['empty-record.fna', '>empty\n>next\nAC\n', /has no sequence/],
			['empty-file.fna', '', /no FASTA records/],
		];

		for (const [filename, contents, expectedError] of invalidCases) {
			const inputPath = join(directory, filename);
			await writeFile(inputPath, contents);
			await assert.rejects(analyzeFasta(inputPath), expectedError, filename);
		}
	});
});