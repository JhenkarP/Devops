# SignalLab Project Features

SignalLab is a local research prototype for exploring antibiotic-resistance signals and rare-disease differentials. It is not a clinical diagnostic system and must not be used to select treatment.

## Implemented Workflows

### Antibiotic Resistance

- Look up eligible BV-BRC genome IDs in a bounded catalog built from the enriched 2-million-record cohort.
- Score a 137-antibiotic panel using precomputed, model-compatible resistance-product calls and the trained SGD baseline.
- Exclude genomes with training or validation labels from genome-panel inference; held-out-test and unlabeled genomes may be served.
- Provide a secondary manual-feature workflow using normalized resistance-product names, with a synthetic example tuple for demonstration.
- Display predicted R/S classes, raw model scores, research thresholds, evidence, and evaluation context. These scores are uncalibrated signals, not probabilities; a predicted susceptible class does not establish susceptibility or treatment effectiveness.
- Persist analysis inputs, results, model and dataset provenance, and review feedback. Saved analyses can be reopened or deleted.

### Rare-Disease HPO Ranking

- Normalize phenotype input against the versioned HPO term index using exact IDs, canonical names, or synonyms.
- Require correction of ambiguous or unmatched terms instead of guessing.
- Rank disease profiles with the HPO Resnik-style baseline.
- Show relative scores, matching phenotype evidence, contradiction information, and profile terms that were not reported. Unreported findings are not treated as absent.
- Persist the ranker version and checksum-derived dataset version with each analysis.

## Shared Platform Features

- React/Vite frontend, Express API, FastAPI model service, and PostgreSQL persistence, runnable locally with Docker Compose.
- Versioned request and response contracts (API v1.1.0), input validation, health checks, and explicit model/dataset provenance.
- Read-only scientific artifacts mounted into the model service; large source datasets and model files remain outside PostgreSQL.
- Analysis history, review feedback, deletion, and a 90-day default local retention policy.
- Research-use warnings and bounded inputs. The local prototype is unauthenticated and must not receive identifiable or sensitive clinical information.

## Evaluation and Current Limitations

- AMR has genome-, geography-, temporal-, and submitter-group evaluation reports. Submitter groups are not verified physical laboratories, and current results do not establish unseen-laboratory or organism/drug-level reliability.
- The AMR genome catalog uses precomputed calls. Arbitrary FASTA upload, sequence analysis, and raw gene-symbol-to-product mapping are not implemented.
- The HPO published-case evaluation is exploratory. Only 36 of 250 cases were exact-PMID-disjoint from all candidate profile evidence; performance on that subset was weak. Exact PMID screening does not establish full independence.
- Neither workflow is clinically validated. AMR outputs do not recommend antibiotics; HPO rankings are not diagnoses.

## Open Gates and Future Scope

- Obtain and evaluate an independent HPO case cohort with leakage controls before making claims beyond research use.
- Obtain a qualifying AMR external measured-AST cohort with verified physical testing-laboratory identities and evaluate the locked model without retuning.
- Keep user-supplied bacterial FASTA support blocked until validation, assembly quality checks, taxonomy verification, and a pinned resistance-calling pipeline are feasible and tested.
- Expand the frontend with planned model-version, dataset-provenance, and experiment-comparison views, and complete broader desktop/mobile workflow testing.
- Add production access control, privacy safeguards, deployment, monitoring, rate limits, and database backup procedures before wider deployment.

## Product Boundary

The current deliverable is a local research workflow for reviewing model outputs and their limitations. Successful software tests or a functioning browser demo do not establish clinical validity, calibrated probabilities, external generalization, or treatment utility.