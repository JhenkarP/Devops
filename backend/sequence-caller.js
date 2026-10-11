import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
const WORK_DIR = process.env.SEQUENCE_WORK_DIR || '/sequence-work';
const INPUT_VOLUME = process.env.SEQUENCE_WORK_VOLUME || 'devops_sequence-work';
const RUNNER = process.env.SEQUENCE_RUNNER || '/app/scripts/run-amrfinder-docker.mjs';
const PARSER = process.env.SEQUENCE_PARSER || '/app/scripts/parse-amrfinder-output.mjs';

export async function callAmrfinder({ bytes, filename, preflight, organism }) {
  const runId = randomUUID();
  const safeName = `${runId}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const inputPath = join(WORK_DIR, safeName);
  const preflightPath = join(WORK_DIR, `${runId}-preflight.json`);
  const outputPath = join(WORK_DIR, `${runId}-amrfinder.tsv`);
  const manifestPath = join(WORK_DIR, `${runId}-run.json`);
  const featuresPath = join(WORK_DIR, `${runId}-features.json`);
  await mkdir(WORK_DIR, { recursive: true });
  await writeFile(inputPath, bytes, { flag: 'wx' });
  await writeFile(preflightPath, JSON.stringify(preflight), { flag: 'wx' });
  try {
    await execFileAsync(process.execPath, [RUNNER, '--input', inputPath, '--preflight', preflightPath, '--output', outputPath, '--run-manifest', manifestPath, '--input-volume', INPUT_VOLUME, '--output-volume', INPUT_VOLUME, '--database-version', '2026-08-07.1', ...(organism ? ['--organism', organism] : [])], { maxBuffer: 10 * 1024 * 1024 });
    await execFileAsync(process.execPath, [PARSER, outputPath, '--output', featuresPath, '--genome-id', runId, '--tool-version', '4.2.7', '--database-version', '2026-08-07.1', ...(organism ? ['--organism', organism] : [])], { maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(await readFile(featuresPath, 'utf8'));
  } finally {
    await Promise.all([inputPath, preflightPath, outputPath, manifestPath, featuresPath].map(path => rm(path, { force: true }).catch(() => {})));
  }
}
