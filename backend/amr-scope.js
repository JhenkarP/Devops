import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scopePath = fileURLToPath(new URL('../data/models/amr_scope.json', import.meta.url));
const scope = JSON.parse(readFileSync(scopePath, 'utf8'));

export function getAmrScope() {
	return scope;
}

export function isInAmrScope(organism, antibiotic) {
	return scope.organism === organism && scope.pairs.some((pair) => pair.antibiotic === antibiotic);
}