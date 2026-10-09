import { readFile } from 'node:fs/promises';

const files = ['src/main.jsx', 'backend/server.js', 'ml-service/app.py', 'docker-compose.yml', '.env.example'];
for (const file of files) {
  await readFile(new URL(`../${file}`, import.meta.url));
  console.log(`OK ${file}`);
}

const frontend = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const backend = await readFile(new URL('../backend/server.js', import.meta.url), 'utf8');
for (const route of ['/amr/predict', '/rare-disease/rank']) {
  if (!frontend.includes(route) || !backend.includes(route)) throw new Error(`Missing route contract: ${route}`);
}
console.log('API route contract is consistent.');
