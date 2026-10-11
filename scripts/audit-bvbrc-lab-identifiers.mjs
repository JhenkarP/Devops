import { createReadStream, writeFileSync } from 'node:fs';
import { parser } from 'stream-json';
import { streamArray } from 'stream-json/streamers/stream-array.js';

const inputPath = 'data/amr_2m/bvbrc_genome_amr.json';
const reportPath = 'data/models/amr_source_lab_identifier_audit.json';
const fieldCounts = new Map();
const identifierValues = new Map();
const candidatePattern = /(lab|facility|testing.?site|testing.?org)/i;
let scanned = 0;

const records = createReadStream(inputPath).pipe(parser.asStream()).pipe(streamArray.asStream());
for await (const { value: record } of records) {
  scanned += 1;
  if (scanned % 100000 === 0) console.log(`Scanned ${scanned.toLocaleString()} source AMR records`);
  for (const [field, value] of Object.entries(record)) {
    fieldCounts.set(field, (fieldCounts.get(field) || 0) + 1);
    if (!candidatePattern.test(field) || value === null || value === undefined) continue;
    const formatted = typeof value === 'string' ? value.trim() : JSON.stringify(value);
    if (!formatted) continue;
    const values = identifierValues.get(field) || new Map();
    values.set(formatted, (values.get(formatted) || 0) + 1);
    identifierValues.set(field, values);
  }
}

const report = {
  input: inputPath,
  records_scanned: scanned,
  source_fields: Object.fromEntries([...fieldCounts].sort(([left], [right]) => left.localeCompare(right))),
  candidate_lab_or_facility_fields: Object.fromEntries(
    [...identifierValues].sort(([left], [right]) => left.localeCompare(right)).map(([field, values]) => [
      field,
      {
        nonempty_records: [...values.values()].reduce((sum, count) => sum + count, 0),
        distinct_values: values.size,
        top_values: [...values].sort((left, right) => right[1] - left[1]).slice(0, 20).map(([value, count]) => ({ value, count })),
      },
    ]),
  ),
  conclusion: 'Candidate field names are an audit aid, not proof that values identify physical testing laboratories.',
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Wrote ${reportPath}`);