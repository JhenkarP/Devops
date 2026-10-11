import { createWriteStream } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import { once } from 'node:events';

const paths = process.argv.slice(2);
for (const path of paths) {
  const source = JSON.parse(await readFile(path, 'utf8'));
  const outputPath = `${path}.jsonl`;
  const output = createWriteStream(outputPath, { encoding: 'utf8' });
  for (const [genomeId, value] of Object.entries(source)) {
    output.write(`${JSON.stringify({ genome_id: genomeId, value })}\n`);
  }
  output.end();
  await once(output, 'finish');
  await rename(outputPath, path.replace(/\.json$/, '.jsonl'));
  await rm(path);
  console.log(`Converted ${path} to ${path.replace(/\.json$/, '.jsonl')}`);
}