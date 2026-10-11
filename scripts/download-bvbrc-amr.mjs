import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const dataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
const destination = join(dataDirectory, 'amr_2m', 'bvbrc_genome_amr_full.json');
const manifestPath = join(dataDirectory, 'manifest.json');
const pageSize = Number(process.env.BVBRC_AMR_PAGE_SIZE || 10000);
const maxPagesArgument = process.argv.find(argument => argument.startsWith('--max-pages='));
const maxPages = maxPagesArgument ? Number(maxPagesArgument.split('=')[1]) : null;
const isProbe = maxPages !== null;
const outputPath = isProbe ? join(dataDirectory, 'amr_2m', 'bvbrc_genome_amr.probe.json') : destination;
const temporaryPath = `${outputPath}.partial`;
const baseUrl = 'https://www.bv-brc.org/api/genome_amr/';
const execFileAsync = promisify(execFile);

if (!Number.isInteger(pageSize) || pageSize < 1 || !Number.isInteger(maxPages ?? 1) || (maxPages !== null && maxPages < 1)) {
  throw new Error('BVBRC_AMR_PAGE_SIZE and --max-pages must be positive integers.');
}

function resultTotal(contentRange) {
  const match = contentRange?.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function parseHeaderFile(content) {
  const blocks = content.split(/\r?\n\r?\n/).filter(block => /^HTTP\//i.test(block));
  const headers = new Headers();
  for (const line of blocks.at(-1)?.split(/\r?\n/).slice(1) || []) {
    const separator = line.indexOf(':');
    if (separator > 0) headers.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return headers;
}

async function fetchWithCurl(url, pageNumber) {
  const bodyPath = join(dataDirectory, `bvbrc_genome_amr.page-${pageNumber}.tmp`);
  const headersPath = `${bodyPath}.headers`;
  try {
    await execFileAsync('curl.exe', [
      '-k', '-L', '--fail', '--retry', '2', '--connect-timeout', '20', '--max-time', '600',
      '-A', 'SignalLab/0.1 research-data-client', '-D', headersPath, '-o', bodyPath, url
    ], { maxBuffer: 5 * 1024 * 1024 });
    return {
      records: JSON.parse(await readFile(bodyPath, 'utf8')),
      headers: parseHeaderFile(await readFile(headersPath, 'utf8')),
      transport: 'curl-insecure-fallback'
    };
  } finally {
    await rm(bodyPath, { force: true });
    await rm(headersPath, { force: true });
  }
}

async function fetchPage(cursor) {
  const encodedCursor = encodeURIComponent(cursor);
  const url = `${baseUrl}?eq(public,true)&limit(${pageSize})&cursor(${encodedCursor})`;
  let lastError;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'SignalLab/0.1 research-data-client' } });
      if (!response.ok) throw new Error(`BV-BRC returned ${response.status} ${response.statusText}`);
      const records = await response.json();
      if (!Array.isArray(records)) throw new Error('BV-BRC response was not a JSON array.');
      return {
        records,
        nextCursor: response.headers.get('x-cursor-mark'),
        total: resultTotal(response.headers.get('content-range')),
        url,
        transport: 'fetch'
      };
    } catch (error) {
      lastError = error;
      if (process.platform === 'win32' && error.cause?.code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY') {
        const response = await fetchWithCurl(url, pages + 1);
        if (!Array.isArray(response.records)) throw new Error('BV-BRC response was not a JSON array.');
        return {
          records: response.records,
          nextCursor: response.headers.get('x-cursor-mark'),
          total: resultTotal(response.headers.get('content-range')),
          url,
          transport: response.transport
        };
      }
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }

  throw lastError;
}

await mkdir(dirname(outputPath), { recursive: true });
await rm(temporaryPath, { force: true });
const output = await open(temporaryPath, 'w');
const checksum = createHash('sha256');
let cursor = '*';
let totalRecords = 0;
let reportedTotal = null;
let pages = 0;
let firstPageUrl = null;
let firstRecord = true;
let transport = 'fetch';

try {
  await output.write('[');
  checksum.update('[');

  while (maxPages === null || pages < maxPages) {
    const page = await fetchPage(cursor);
    pages += 1;
    firstPageUrl ??= page.url;
    reportedTotal ??= page.total;
    if (page.transport === 'curl-insecure-fallback') transport = page.transport;

    if (page.total !== null && reportedTotal !== page.total) {
      throw new Error(`BV-BRC total changed during export (${reportedTotal} to ${page.total}).`);
    }
    if (reportedTotal === null) {
      throw new Error('BV-BRC did not report a total record count; refusing to call this export complete.');
    }

    for (const record of page.records) {
      const serialized = `${firstRecord ? '' : ','}${JSON.stringify(record)}`;
      await output.write(serialized);
      checksum.update(serialized);
      firstRecord = false;
      totalRecords += 1;
    }

    console.log(`Page ${pages}: ${totalRecords}/${reportedTotal} records`);

    if (!page.records.length || !page.nextCursor || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }

  const complete = totalRecords === reportedTotal;
  if (!isProbe && !complete) {
    throw new Error(`Export incomplete: received ${totalRecords} of ${reportedTotal} records.`);
  }

  await output.write(']\n');
  checksum.update(']\n');
  await output.close();
  await rename(temporaryPath, outputPath);

  if (isProbe) {
    console.log(`Probe saved to ${outputPath}; full source total is ${reportedTotal} records.`);
  } else {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    let source = manifest.sources.find(item => item.name === 'amr_2m/bvbrc_genome_amr_full.json');
    if (!source) {
      source = { name: 'amr_2m/bvbrc_genome_amr_full.json', status: 'downloaded' };
      manifest.sources.push(source);
    }
    source.url = firstPageUrl;
    source.role = 'Complete public BV-BRC antimicrobial resistance and susceptibility export';
    source.accessed_at = new Date().toISOString();
    source.version = 'Complete public API snapshot; no pinned data release recorded';
    source.transformations_applied = 'None to source artifact; retrieved with cursor pagination and verified against the API-reported total. Downstream transformations are described in data/processed/processing_report.json.';
    source.sample_scope = `Complete public genome_amr export; ${totalRecords} records across ${pages} cursor pages.`;
    source.transport = transport;
    source.record_count = totalRecords;
    source.page_count = pages;
    source.export_complete = true;
    source.bytes = (await stat(outputPath)).size;
    source.sha256 = checksum.digest('hex');
    manifest.updated_at = new Date().toISOString();
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Complete export saved to ${outputPath}; checksum and provenance updated.`);
  }
} catch (error) {
  await output.close().catch(() => {});
  await rm(temporaryPath, { force: true });
  throw error;
}