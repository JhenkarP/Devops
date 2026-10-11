import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parser } from 'stream-json';
import { streamArray } from 'stream-json/streamers/stream-array.js';

const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
const [sourceName = 'amr_2m/bvbrc_genome_amr.json.partial', outputName = 'amr_2m/bvbrc_genome_amr.json', limitArgument = '2000000'] = process.argv.slice(2);
const limit = Number.parseInt(limitArgument, 10);
const sourcePath = join(dataDirectory, sourceName);
const outputPath = join(dataDirectory, outputName);
const temporaryPath = `${outputPath}.partial`;
const manifestPath = join(dataDirectory, 'manifest.json');

if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('The record limit must be a positive safe integer.');

async function writeChunk(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, 'drain');
}

await mkdir(dirname(outputPath), { recursive: true });
const output = createWriteStream(temporaryPath, { encoding: 'utf8' });
const checksum = createHash('sha256');
let recordCount = 0;
let firstRecord = true;

try {
  await writeChunk(output, '[');
  checksum.update('[');
  const records = createReadStream(sourcePath).pipe(parser.asStream()).pipe(streamArray.asStream());
  for await (const { value } of records) {
    const chunk = `${firstRecord ? '' : ','}${JSON.stringify(value)}`;
    await writeChunk(output, chunk);
    checksum.update(chunk);
    firstRecord = false;
    recordCount += 1;
    if (recordCount === limit) break;
    if (recordCount % 500000 === 0) console.log(`Copied ${recordCount.toLocaleString()}/${limit.toLocaleString()} records`);
  }

  if (recordCount !== limit) throw new Error(`Only ${recordCount} complete records were available; expected ${limit}.`);
  await writeChunk(output, ']\n');
  checksum.update(']\n');
  output.end();
  await once(output, 'finish');
  await rename(temporaryPath, outputPath);

  const file = await stat(outputPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.sources.push({
    name: outputName,
    url: 'https://www.bv-brc.org/api/genome_amr/',
    role: 'Capped prefix of the public BV-BRC AMR table',
    status: 'downloaded',
    accessed_at: new Date().toISOString(),
    version: 'API snapshot accessed 2026-10-09; no pinned data release recorded',
    license_or_reuse_terms: 'BV-BRC states public data is freely available without restriction on use; retain provenance and check source-specific rights for integrated data.',
    transformations_applied: 'First 2,000,000 records preserved in API cursor order from an interrupted paginated export; raw source fields retained.',
    sample_scope: `Capped prefix of ${limit} records; API reported 17,634,751 total records.`,
    transport: 'curl-insecure-fallback',
    record_count: recordCount,
    api_reported_total: 17634751,
    export_complete: false,
    bytes: file.size,
    sha256: checksum.digest('hex')
  });
  manifest.updated_at = new Date().toISOString();
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Saved and verified ${recordCount.toLocaleString()} records to ${outputPath}`);
} catch (error) {
  output.destroy();
  throw error;
}