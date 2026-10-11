import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AMR_SEQUENCE_CONTRACT_VERSION, validateAmrSequenceInput } from '../shared/amr-sequence-contract.js';

const execFileAsync = promisify(execFile);
const DEFAULT_IMAGE = 'ncbi/amr@sha256:52dc48754305adfed9100a51be41ad0438e42aac02f0f4c58c46c23d9ea3e74e';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function value(args, flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; }

export async function runAmrfinderDocker(options) {
  const input = resolve(options.input);
  const output = resolve(options.output);
  const preflight = JSON.parse(await readFile(resolve(options.preflight), 'utf8'));
  const inputBytes = await readFile(input);
  const inputManifest = {
    contract_version: AMR_SEQUENCE_CONTRACT_VERSION,
    input_type: 'fasta',
    filename: basename(input),
    content_sha256: sha256(inputBytes),
    preflight_report: preflight.preflight_report || preflight,
  };
  const errors = validateAmrSequenceInput(inputManifest);
  if (errors.length) throw new Error(`Preflight binding failed: ${errors.join(' ')}`);

  const inputDir = dirname(input);
  const outputDir = dirname(output);
  const image = options.image || DEFAULT_IMAGE;
  const databaseVersion = options.databaseVersion || '2026-08-07.1';
  const organism = options.organism || null;
  const commandArgs = [
    'run', '--rm',
    ...(options.inputVolume
      ? ['--mount', `type=volume,source=${options.inputVolume},target=/signallab-input,readonly`]
      : ['-v', `${inputDir}:/signallab-input:ro`]),
    ...(options.outputVolume
      ? ['--mount', `type=volume,source=${options.outputVolume},target=/signallab-output`]
      : ['-v', `${outputDir}:/signallab-output`]),
    image,
    'amrfinder',
    '-n', `/signallab-input/${basename(input)}`,
    '-o', `/signallab-output/${basename(output)}`,
    '-d', `/usr/local/bin/data/${databaseVersion}`,
  ];
  if (organism) commandArgs.push('-O', organism);
  const startedAt = new Date().toISOString();
  let stdout = '';
  let stderr = '';
  let status = 'failed';
  try {
    const result = await execFileAsync('docker', commandArgs, { maxBuffer: 10 * 1024 * 1024 });
    stdout = result.stdout || '';
    stderr = result.stderr || '';
    status = 'completed';
  } catch (error) {
    stdout = error.stdout || '';
    stderr = error.stderr || error.message;
    throw error;
  } finally {
    const outputBytes = await readFile(output).catch(() => Buffer.alloc(0));
    const runManifest = {
      contract_version: AMR_SEQUENCE_CONTRACT_VERSION,
      status,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      input: { filename: basename(input), sha256: inputManifest.content_sha256, preflight_report_version: inputManifest.preflight_report.report_version },
      caller: { tool_name: 'AMRFinderPlus', tool_version: '4.2.7', database: `/usr/local/bin/data/${databaseVersion}`, database_version: databaseVersion, image, image_digest: image.split('@sha256:')[1] || null },
      command: { executable: 'docker', args: commandArgs },
      output: { filename: basename(output), sha256: sha256(outputBytes), bytes: outputBytes.length },
      stdout,
      stderr,
      phenotype_status: 'not_predicted',
      limitations: ['AMRFinderPlus identifies sequence determinants; it does not establish phenotypic resistance or susceptibility.'],
    };
    await writeFile(resolve(options.runManifest), `${JSON.stringify(runManifest, null, 2)}\n`, { flag: 'wx' });
  }
}

async function main(args) {
  const input = value(args, '--input');
  const preflight = value(args, '--preflight');
  const output = value(args, '--output');
  const runManifest = value(args, '--run-manifest');
  if (!input || !preflight || !output || !runManifest) throw new Error('Input, preflight, output, and run manifest are required.');
  await runAmrfinderDocker({ input, preflight, output, runManifest, image: value(args, '--image'), databaseVersion: value(args, '--database-version'), organism: value(args, '--organism'), inputVolume: value(args, '--input-volume'), outputVolume: value(args, '--output-volume') });
  console.log(`AMRFinderPlus Docker output written to ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`AMRFinderPlus Docker execution failed: ${error.message}`); process.exitCode = 1; });
}
