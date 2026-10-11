import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { preflightFasta } from '../sequence-preflight.js';

test('preflights FASTA bytes with checksum and assembly statistics', () => {
  const report = preflightFasta(Buffer.from('>contig-1\nACGTNN\n>contig-2\nGC\n'), 'sample.fasta');
  assert.equal(report.fasta_status, 'valid');
  assert.equal(report.contig_count, 2);
  assert.equal(report.total_bases, 8);
  assert.equal(report.ambiguous_bases, 2);
  assert.match(report.input_sha256, /^[a-f0-9]{64}$/);
});

test('preflights gzip FASTA while hashing the uploaded bytes', () => {
  const bytes = gzipSync('>contig-1\nACGT\n');
  const report = preflightFasta(bytes, 'sample.fasta.gz');
  assert.equal(report.input_compression, 'gzip');
  assert.equal(report.total_bases, 4);
});

test('rejects invalid and duplicate FASTA records', () => {
  assert.throws(() => preflightFasta(Buffer.from('>a\nACX\n'), 'sample.fasta'), /Invalid nucleotide/);
  assert.throws(() => preflightFasta(Buffer.from('>a\nAC\n>a\nGT\n'), 'sample.fasta'), /Duplicate FASTA identifier/);
});
