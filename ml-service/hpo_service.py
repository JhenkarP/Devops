import hashlib
import json
import os
import re
from collections import defaultdict
from functools import lru_cache
from pathlib import Path

from baselines import build_information_content, make_ancestor_lookup, rank_diseases


PROJECT_ROOT = Path(__file__).resolve().parent.parent
HPO_MODEL_VERSION = 'hpo-resnik-baseline-1'
HPO_ARTIFACT_PATHS = {
    'profiles': Path(os.environ.get(
        'RARE_DISEASE_PROFILES_PATH',
        PROJECT_ROOT / 'data/rare_disease/processed/rare_disease_profiles.json',
    )),
    'graph': Path(os.environ.get(
        'HPO_GRAPH_PATH',
        PROJECT_ROOT / 'data/rare_disease/processed/hpo_graph.json',
    )),
    'term_index': Path(os.environ.get(
        'HPO_TERM_INDEX_PATH',
        PROJECT_ROOT / 'data/rare_disease/processed/hpo_term_index.json',
    )),
}


class HpoNormalizationError(ValueError):
    def __init__(self, normalization):
        self.normalization = normalization
        super().__init__('Resolve every ambiguous or unmatched phenotype before ranking.')


def _sha256_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def build_hpo_metadata(artifact_paths):
    artifacts = {}
    for name, path in artifact_paths.items():
        if not path.is_file():
            raise FileNotFoundError(f'Required HPO artifact is missing: {path}')
        artifacts[name] = {
            'path': path.as_posix(),
            'sha256': _sha256_file(path),
            'bytes': path.stat().st_size,
        }
    dataset_sha256 = hashlib.sha256(
        json.dumps(
            {name: artifact['sha256'] for name, artifact in sorted(artifacts.items())},
            sort_keys=True,
            separators=(',', ':'),
        ).encode('utf-8'),
    ).hexdigest()
    return {
        'model_version': HPO_MODEL_VERSION,
        'dataset_version': f'hpo-knowledge-{dataset_sha256[:16]}',
        'dataset_sha256': dataset_sha256,
        'artifacts': artifacts,
    }


@lru_cache(maxsize=1)
def rare_disease_metadata():
    return build_hpo_metadata(HPO_ARTIFACT_PATHS)


def _normalize_text(value):
    return re.sub(r'\s+', ' ', str(value).strip().casefold())


def build_term_aliases(term_index):
    aliases = defaultdict(set)
    names = {}
    for term in term_index:
        term_id = term['id']
        names[term_id] = term.get('name') or term_id
        for alias in [term_id, term.get('name'), *(term.get('synonyms') or [])]:
            normalized = _normalize_text(alias or '')
            if normalized:
                aliases[normalized].add(term_id)
    return aliases, names


def normalize_phenotypes(phenotypes, aliases, names):
    normalized = []
    for value in phenotypes:
        original = str(value).strip()
        matches = sorted(aliases.get(_normalize_text(original), ()))
        if len(matches) == 1:
            term_id = matches[0]
            normalized.append({
                'input': original,
                'hpo_id': term_id,
                'matched_term': names.get(term_id, term_id),
                'match_type': 'exact_hpo_id' if _normalize_text(original) == term_id.casefold() else 'exact_name_or_synonym',
                'candidates': [],
            })
        elif matches:
            normalized.append({
                'input': original,
                'hpo_id': None,
                'matched_term': None,
                'match_type': 'ambiguous',
                'candidates': [{'hpo_id': term_id, 'term': names.get(term_id, term_id)} for term_id in matches],
            })
        else:
            normalized.append({
                'input': original,
                'hpo_id': None,
                'matched_term': None,
                'match_type': 'unmatched',
                'candidates': [],
            })
    return normalized


@lru_cache(maxsize=1)
def load_rare_disease_resources():
    metadata = rare_disease_metadata()
    profiles = json.loads(HPO_ARTIFACT_PATHS['profiles'].read_text(encoding='utf-8'))
    graph = json.loads(HPO_ARTIFACT_PATHS['graph'].read_text(encoding='utf-8'))
    term_index = json.loads(HPO_ARTIFACT_PATHS['term_index'].read_text(encoding='utf-8'))
    parents = defaultdict(set)
    for edge in graph.get('edges', []):
        parents[edge['child']].add(edge['parent'])
    ancestors = make_ancestor_lookup(parents)
    aliases, names = build_term_aliases(term_index)
    information_content = build_information_content(profiles, ancestors)
    return {
        'metadata': metadata,
        'profiles': profiles,
        'aliases': aliases,
        'names': names,
        'ancestors': ancestors,
        'information_content': information_content,
    }


def normalize_hpo_inputs(phenotypes):
    resources = load_rare_disease_resources()
    normalized = normalize_phenotypes(phenotypes, resources['aliases'], resources['names'])
    hpo_ids = list(dict.fromkeys(item['hpo_id'] for item in normalized if item['hpo_id']))
    return {
        **resources['metadata'],
        'normalization': normalized,
        'hpo_ids': hpo_ids,
    }


def attach_unreported_profile_terms(candidates, profiles, names):
    profiles_by_id = {profile.get('disease_id'): profile for profile in profiles}
    for candidate in candidates:
        profile = profiles_by_id.get(candidate.get('disease_id'), {})
        matched_ids = {item['matched_disease_hpo_id'] for item in candidate['supporting_terms']}
        unreported = [
            {'hpo_id': item['hpo_id'], 'term': names.get(item['hpo_id'], item['hpo_id'])}
            for item in profile.get('present', [])
            if item['hpo_id'] not in matched_ids
        ]
        candidate['unreported_profile_terms'] = unreported[:5]
        candidate['unreported_profile_term_count'] = len(unreported)
    return candidates


def rank_hpo_ids(hpo_ids, top_k=10):
    resources = load_rare_disease_resources()
    unknown_ids = [term_id for term_id in hpo_ids if term_id not in resources['names']]
    if unknown_ids:
        raise ValueError(f'Unknown HPO identifier(s): {", ".join(unknown_ids)}')
    candidates = rank_diseases(
        list(dict.fromkeys(hpo_ids)),
        resources['profiles'],
        resources['ancestors'],
        resources['information_content'],
        resources['names'],
        top_k,
    )
    attach_unreported_profile_terms(candidates, resources['profiles'], resources['names'])
    return {
        **resources['metadata'],
        'input_hpo_ids': list(dict.fromkeys(hpo_ids)),
        'candidates': candidates,
        'method': 'Resnik-style similarity normalized by maximum profile information content, with an absent-phenotype contradiction penalty.',
        'score_semantics': 'Relative ranking score; not a probability or clinical likelihood.',
        'caveat': (
            'Research ranking only; not a clinical diagnosis. Disease profiles are knowledge annotations, '
            'not a prospective patient cohort. Published-case evaluation is exploratory and does not establish '
            'source-independent or clinical validity. Profile terms not reported in the input are not known to be absent.'
        ),
        'evaluation_mode': 'hpo_resnik_relative_ranking',
    }