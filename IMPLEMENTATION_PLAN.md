# SignalLab Implementation Plan

## Product Goal

Build SignalLab, a research decision-support platform with:

1. Antibiotic-resistance phenotype prediction.
2. Rare-disease differential ranking.
3. Evidence explanations.
4. Dataset provenance.
5. Model and experiment version tracking.
6. Human review and feedback.
7. Full web deployment.

The product is research software. It is not a clinical diagnostic system and must not prescribe treatment.

## Current Status

Validation progress:

- Initial scope: complete
- Independent laboratory data: blocked / not started
- External validation: pending
- Raw FASTA ingestion contract: complete.
- AMRFinderPlus execution/parser adapter: implemented; pinned binary/database runtime is pending.
- Determinant-to-model mapping boundary: implemented; reviewed mapping and phenotype service integration are pending.

- React/Vite product shell created.
- AMR workflow UI created.
- Rare-disease workflow UI created.
- Express API created.
- FastAPI ML-service contract created.
- HPO ontology downloaded into `data/rare_disease/hp.json`.
- Dataset provenance manifest with checksums created at `data/manifest.json`.
- Frontend production build passes.
- Backend dependencies installed from the `backend` directory.

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite |
| Styling | Custom CSS |
| API | Node.js + Express |
| ML service | Python + FastAPI + PyTorch |
| Database | PostgreSQL |
| Database client and migrations | `pg` with numbered SQL migrations |
| Validation | Zod and Pydantic |
| Background jobs | Python scripts initially, Celery later |
| Dataset storage | Local `data/`, then S3-compatible object storage |
| Authentication | Auth.js or JWT |
| Local deployment | Docker Compose |
| Production deployment | Docker and managed hosting |
| Frontend tests | Vitest and Playwright |
| Python tests | Pytest |
| Monitoring | Structured logs and model-run metadata |

## Phase 1: Project Foundation

- [x] Remove the old BrandProof application folders.
- [x] Create frontend, backend, ML-service, data, and scripts directories.
- [x] Configure frontend and API run commands.
- [x] Add environment variable templates.
- [x] Add Docker Compose.
- [x] Add shared API contract definitions.
- [x] Add contract and build validation commands.
- [x] Add health checks for every service.

**Deliverable:** Frontend, backend, and contract checks pass with documented commands. Docker Compose has been built and all four local services have been validated as healthy.

## Phase 2: Dataset Acquisition

### AMR datasets

Download and document:

- BV-BRC genome metadata.
- BV-BRC antimicrobial susceptibility phenotype records where available.
- NCBI pathogen resistance metadata.
- CARD or ResFinder reference annotations.

Required AMR fields:

- Organism.
- Antibiotic.
- Resistant, susceptible, or intermediate label.
- Genome identifier.
- Resistance genes.
- Mutations.
- Collection year.
- Geographic or laboratory metadata.
- Susceptibility-testing method.

### Rare-disease resources

Download and document:

- Human Phenotype Ontology.
- HPO disease annotations.
- MONDO disease identifiers.
- Monarch disease-gene-phenotype associations.
- Orphadata resources where licensing permits.
- Public Phenopacket examples and benchmark cases.

Important limitation: HPO and Monarch are knowledge resources, not large patient cohorts. Real patient-level diagnostic data may require controlled access.

**Deliverable:** `data/manifest.json` records each source URL, access time, version or an explicit unpinned status, checksum, reuse terms or an explicit unverified status, and transformations applied.

Phase 2 progress:

- [x] HPO ontology downloaded.
- [x] Checksums and transport details recorded in `data/manifest.json`.
- [x] Docker Desktop installed and Compose runtime validated.
- [x] Bounded phenotype-labelled AMR susceptibility starter export selected and downloaded.

The BV-BRC AMR inputs are separated by cohort: `data/amr_10k/bvbrc_genome_amr.json` is the older 10,000-record cohort used by the existing metadata/feature enrichment workflow, while `data/amr_2m/bvbrc_genome_amr.json` is a capped 2,000,000-record prefix of the 17,634,751-record public table. The 2M cohort has normalized, deduplicated, conflict, and enriched outputs under `data/amr_2m/processed/`, including completed genome metadata and resistance-feature joins. It is not a complete BV-BRC export. The AMR table itself does not include complete genome sequences or explicit mutation calls; sequence-based mutation analysis is outside the current scope.

Licensing and provenance review:

- BV-BRC documentation states that public data is freely available without restriction on use. Retain provenance and check source-specific rights where BV-BRC integrates third-party data.
- The downloaded ResFinder database archive is version `2.6.0`; its README states Apache License 2.0 and requests citation. The archive came from the moving `master` branch, so its checksum is retained; check separate software terms if that software is used.
- HPO is version `2026-09-01`; its annotation file is dated `2026-09-02`. The artifacts point to the HPO license page; preserve annotation provenance and check source-specific rights before redistribution.
- MONDO is version `2026-10-06` under CC BY 4.0. The Monarch association export is an unpinned API snapshot; its integrated source rights are not represented by a single verified license.
- The Phenopacket Store repository is BSD-3-Clause. A per-case source audit of the 250-case evaluation found no packet-level rights fields. Europe PMC reported 75 cited papers with CC BY, 31 with CC BY-NC variants, and 143 outside its open-access subset; these article terms do not automatically clear the derived case records. No case is cleared for redistribution. See `data/models/phenopacket_source_reuse_audit.json`.
- The Orphadata XML declares CC BY 4.0 and identifies its dataset date/version in the file header. Orphadata states a Data Transfer Agreement is the minimum for academic/public entities; confirm applicable terms before redistribution.
- Any remaining unverified terms or unpinned releases are marked as such in the manifest and must be reviewed before redistribution.
- BV-BRC AMR data may include both susceptibility-test observations and computational predictions; preserve evidence type when defining model labels.

## Phase 3: Data Processing

### AMR processing

**Cohort scope:** The checklist below records the verified 10K workflow only. The primary 2M cohort has its own status checklist immediately after it; do not interpret 10K results as 2M results.

**10K cohort (`data/amr_10k/`):**
- [x] Normalize organism names.
- [x] Normalize antibiotic names.
- [x] Map resistance labels to a consistent schema.
- [x] Remove duplicate isolate/antibiotic/testing records.
- [x] Separate labels by testing method.
- [x] Detect conflicting labels.
- [x] Encode source-provided resistance genes and mutations, with missing links flagged.
- [x] Create genome-derived resistance feature calls from linked BV-BRC genome records.
- [x] Split by collection time where BV-BRC metadata provides a year; records without a year remain unassigned.
- [x] Create laboratory and geography group split assignments where metadata exists.

**2M cohort (`data/amr_2m/`):**
- [x] Stream-normalize 2,000,000 rows; preserve evidence class, testing method, labels, and numeric measurements.
- [x] Remove 5,828 exact normalized duplicates using an evidence- and testing-aware key; retain 1,994,172 records.
- [x] Detect and write 1,115 conflicting-label groups, grouped by genome, antibiotic, evidence class, and test conditions.
- [x] Join BV-BRC genome metadata and resistance-feature annotations; flag records without linked calls.
- [x] Assign temporal, laboratory, and geography group splits where cohort metadata is available; missing collection years remain unassigned.
- Sequence-based mutation extraction and mutation-to-phenotype linking are not part of the Phase 3 acceptance gate. The separate sequence-to-phenotype bridge is tracked below and remains incomplete until its caller, mapping, and validation gates pass.

The 2M outputs and verified counts are recorded in `data/amr_2m/processed/bvbrc_amr_processing_report.json`. Computational evidence remains distinct from laboratory observations; this pass does not turn numeric measurements into labels using breakpoints.

The completed enrichment output is `data/amr_2m/processed/bvbrc_amr_2000000_enriched.jsonl`; its report records 2,000,000 rows across 411,197 unique genome IDs, 1,999,968 rows with metadata matches, 1,901,972 rows with resistance-feature calls, and zero metadata or feature request failures. Temporal splits are assigned where a collection year is available; sequence-backed mutation analysis is not included.

Phase 3A gene and resistance-feature processing is complete for the 10,000-record cohort. The verified report contains 10,000 source and normalized records, 9,999 deduplicated records, 9,652 metadata matches, and 723,827 resistance feature calls. The report warning was corrected on 2026-10-09.

### Rare-disease processing

- [x] Normalize patient free-text symptoms into HPO terms with the reusable `data:normalize-phenotypes` command.
- [x] Map HPO synonyms and ancestor terms; unmatched patient inputs remain reviewable.
- [x] Remove overly generic phenotype terms from disease profiles.
- [x] Track positive and absent findings; unknown remains available for future patient-input handling.
- [x] Build disease-phenotype graph nodes and `is_a` edges.
- [x] Preserve evidence source and publication provenance.
- [x] Create deterministic missing and noisy phenotype sample variants for robustness testing.

**Deliverable:** Reproducible preprocessing script at `scripts/process-datasets.mjs`, 10K AMR artifacts under `data/amr_10k/processed/`, shared rare-disease artifacts under `data/processed/`, and `data/processed/processing_report.json` with counts and warnings.

## Phase 4: Baseline Models

Status: Baseline implementations are complete; evaluation is partial. This phase adds research scripts and generated reports only; no product UI workflow was added or removed. The sequence-to-phenotype bridge below is not a Phase 4 dependency until its runtime and mapping are validated.

### AMR baseline

- [x] Train a sparse resistance-product/antibiotic/organism baseline from laboratory-evidence resistant/susceptible labels only; identifiers, laboratory, and collection year are excluded as features.
- [x] Evaluate a deterministic genome-disjoint split over 77,380 eligible records (54,041 train, 7,679 validation, 15,660 test). Test AUROC 0.793810, AUPRC 0.665960, F1 0.613065, sensitivity 0.615918, specificity 0.812706, balanced accuracy 0.714312, Brier score 0.186121, and ECE 0.136838; threshold 0.2 was selected on validation balanced accuracy.
- [x] Implement selectable genome, laboratory, geography, and temporal cohort splits and report empty-test warnings.
- [x] Evaluate the geography split on the same 77,380-record cohort (41,288 train, 16,245 validation, 19,847 test). Test AUROC 0.717321, AUPRC 0.449747, F1 0.450930, sensitivity 0.662583, specificity 0.669669, balanced accuracy 0.666126, Brier score 0.172776, and ECE 0.139369; threshold 0.1 was selected on validation balanced accuracy.
- [x] Evaluate a chronological holdout using train through 2016, validation 2017–2018, and test 2019 onward. The test includes 668 dated records; AUROC 0.782438, AUPRC 0.731297, F1 0.646688, sensitivity 0.785441, specificity 0.587224, balanced accuracy 0.686332, Brier score 0.200961, and ECE 0.144647; threshold 0.15 was selected on validation balanced accuracy. The partitions contain 23,608 train, 4,229 validation, and 355 test genomes, with zero genomes shared across periods. Records with missing years are excluded.
- [x] Evaluate a disjoint metadata submitter-group holdout (31,596 train, 2,616 validation, 43,168 test), holding out `PATRIC@patricbrc.org` and using `PATRIC` for validation. Test AUROC 0.640226, AUPRC 0.471253, F1 0.489124, sensitivity 0.554820, specificity 0.644669, balanced accuracy 0.599744, Brier score 0.305428, and ECE 0.278057; threshold 0.15 was selected on validation balanced accuracy.
- [ ] Obtain a source with verified physical testing-laboratory identifiers and repeat a true unseen-laboratory evaluation. An audit of all 2,000,000 raw source rows found no facility identity field; `owner` is submitter metadata and laboratory-typing fields describe method/platform. The current grouped evaluation is only a submitter proxy.
- Mutation-feature modeling is out of scope for the current trained baseline; sequence-derived determinants must pass the separate bridge and mapping gates below before they can be used as model features.

### Rare-disease baseline

- [x] Implement HPO ancestor-information-content similarity ranking with absent-phenotype contradiction penalty and supporting-term explanations.
- [x] Add a leave-one-present-phenotype-out knowledge-profile self-consistency check. This is not patient validation; a regression test ensures the hidden term is masked from its target profile.
- [x] Regenerate HPO leave-one-present-phenotype-out self-consistency metrics with the target phenotype masked from its target profile. On 100 profiles: Top-1 0.85, Top-5 0.93, MRR 0.885584. Report records evaluator version `leave-one-out-mask-target-v2` and generation timestamp; this remains knowledge-profile self-consistency, not patient validation.
- [x] Retain the earlier 100-case result (Top-1 0.59, Top-5 0.68, MRR 0.642923) as a superseded exploratory result from the unpinned `main` snapshot; it is not the current release benchmark.
- [x] Pin the Phenopacket Store case evaluation to release `0.1.27`, commit `3f3619800b2c949f8bfb457a122346c2fae7e482`, and publisher-verified SHA-256 `d0c70005bb09b87035087516252b6b539fbc0415be7c664b73c9cde7eedf205a`. The repository license is BSD-3-Clause; the completed per-case source audit found no case records cleared for redistribution.
- [x] Expand the deterministic, one-case-per-mapped-OMIM-disease exploratory evaluation to 250 cases against the full disease-profile candidate set (778 mapped diseases available). Release 0.1.27 results: Top-1 0.648, Top-5 0.764, MRR 0.708770.
- [x] Review source overlap against evidence for every disease candidate profile, not just the target profile. Of the 250 selected cases, 214 share a PMID with some candidate profile evidence (211 target-profile overlaps and 3 non-target-only overlaps); only 36 are exact-PMID-disjoint. On those 36 cases Top-1 is 0.167, Top-5 0.333, and MRR 0.248846. Exact-PMID disjointness does not rule out shared cohorts, derivative publications, or untracked references; this is not source-independent or clinical validation. Detailed case/article records are in `data/models/phenopacket_source_reuse_audit.json`.
- [x] Assess deterministic perturbation robustness on 100 selected cases. The same-case baseline is Top-1/Top-5/MRR 0.64/0.73/0.689400; 25% missing terms 0.52/0.64/0.578350; 50% missing 0.38/0.59/0.473552; 25% noisy replacements 0.42/0.50/0.472498. These are exploratory sensitivity checks, not calibration or clinical validation.
- [x] Complete a case-level reuse metadata review for the selected cohort. The Phenopacket packets have no rights fields; Europe PMC indexed 75 CC BY papers, 31 CC BY-NC variants, and 143 papers outside its open-access subset among 249 unique citations. None of the 250 derived case records is cleared for redistribution by this review; do not redistribute them without documented case/source permission.
- [x] Complete the probability-calibration feasibility assessment. Calibration is not assessable on this benchmark: the ranker emits similarity scores, only 36/250 cases are exact-PMID-disjoint from all profile evidence, and exact PMID screening does not establish full independence. Do not present the scores as probabilities or add a calibrator based on this cohort. A future calibration effort needs a sufficiently sized, independently sourced cohort and held-out calibration/test data. This public-case evaluation remains exploratory, not clinical validation.

Implementation and test commands: `python ml-service/baselines.py amr --split-by genome`, `python -m unittest discover -s ml-service -p test_baselines.py -v`, and `python ml-service/audit_phenopacket_sources.py --max-cases 250` (queries Europe PMC for article metadata). Generated model artifacts and reports are under `data/models/`; AMR split cohorts are under `data/amr_2m/processed/`.

AMR caveats: the baseline is research-only, uses product names plus antibiotic and organism, and does not establish clinical utility. Temporal results use the dated subset and a 2019+ holdout; 29,482 eligible records without usable years are excluded. The metadata-group result holds out a submitter-like owner group, not a verified physical laboratory; the available cohort has six such groups and no verified physical-lab identifiers. The HPO self-check uses curated knowledge profiles; the Phenopacket Store result is an exploratory published-case evaluation with exact PMID overlap against target-profile evidence in 211/250 cases and against any candidate-profile evidence in 214/250 cases. It is not source-independent or prospective clinical validation, and exact-PMID screening does not capture every possible source overlap.

Artifact audit (2026-10-10): the pre-fix HPO metrics were replaced by the corrected, provenance-stamped report. Nine JSON files in `data/models/` parse successfully, including the case-level reuse/source-overlap audit; the genome, geography, temporal, submitter-group, HPO profile self-check, Phenopacket case evaluation, source reuse audit, split diagnostic, and raw source lab-identity audit are distinct outputs. The temporal overlap diagnostic is `data/models/amr_baseline_split_diagnostics.json`; the source lab-identity audit is `data/models/amr_source_lab_identifier_audit.json`.

### AMR sequence-to-phenotype bridge

- [x] Define a checksum-bound FASTA preflight and input manifest so an uploaded assembly can be tracked without treating quality as assessed.
- [x] Add an explicit AMRFinderPlus execution boundary that records the binary, database, command, input/output checksums, and exit status.
- [x] Normalize AMRFinderPlus gene and mutation output into a versioned sequence-feature manifest with caller/database provenance.
- [x] Add an exact-match determinant-to-model-product mapping boundary that reports unmapped features and refuses to run phenotype prediction when the mapping is incomplete.
- [x] Add a guarded CLI bridge that sends only completely mapped sequence features to the existing antibiotic-specific model endpoint and records research-only panel semantics.
- [x] Pin and verify the official `ncbi/amr` Docker runtime at AMRFinderPlus 4.2.7, database 2026-08-07.1, image digest `sha256:52dc48754305adfed9100a51be41ad0438e42aac02f0f4c58c46c23d9ea3e74e`; the checked-in Docker runner supports optional organism-aware mutation searches.
- [ ] Review and check in a scientifically justified mapping from sequence determinants to the trained model vocabulary; do not infer mappings from names alone.
- [ ] Add a sequence prediction API/UI path after the caller runtime and reviewed mapping are available.
- [x] Add a separate sequence-native trainer that consumes linked genome determinants plus explicit laboratory AST/provenance fields and performs deterministic genome-disjoint evaluation.
- [x] Use the validation split for threshold selection and block each antibiotic unless train, validation, and test each contain both R/S classes.
- [ ] Add probability calibration and calibration-set governance after a qualifying cohort is available.

This bridge is scaffolding and provenance infrastructure, not a completed raw-genome antibiogram. AMRFinderPlus reports resistance determinants; it does not itself predict antibiotic phenotype. The sequence-native trainer now enforces explicit laboratory AST metadata and FASTA/caller provenance, uses validation for thresholds, and remains uncalibrated. No qualifying cohort is currently checked in, so no sequence-native model artifact is claimed.

### AMR research model

Future research, not completed Phase 4 work:

- Gene embeddings and richer resistance-feature explanations.
- Missing/noisy phenotype robustness, temporal updates, evidence provenance weighting, and external calibration.

Research question:

> Can a model predict antibiotic susceptibility from genomic and metadata features while remaining calibrated on unseen laboratories or time periods?

Research question:

> How robustly can phenotype-based disease ranking operate when clinical phenotypes are incomplete, noisy, or entered using inconsistent terminology?

## Phase 5: MVP Scope and Data Contracts

Status: Complete for the local research MVP. The versioned API contract, strict request validation, JSON/PostgreSQL boundary, non-probability score semantics, data minimization, and 90-day local retention policy are implemented and verified. This does not make the prototype suitable for identifiable patient data or production use; do not claim diagnosis, treatment guidance, calibrated probabilities, or unseen-laboratory performance.

- [x] Define and version request/response contracts for AMR prediction, rare-disease ranking, saved analyses, and reviewer feedback. Validate inputs at the API boundary and return explicit model/data version identifiers.
- [x] Remove misleading confidence language from uncalibrated HPO similarity scores. Preserve probability/confidence wording only where emitted by a trained model and its calibration status is documented.
- [x] Separate static scientific artifacts from operational application data: keep versioned datasets, ontology/profile files, and generated benchmark reports as JSON/JSONL artifacts with checksums; use PostgreSQL for analysis runs, structured results, review feedback, and model/dataset registry records.
- [x] Set data-minimization and retention rules before storing user-submitted phenotype or isolate information. Do not store direct identifiers in the research MVP.

Phase 5 implementation decisions: API contract version `1.1.0` is sent in `X-SignalLab-API-Version`; request schemas reject undeclared fields and bound text/array/body sizes. The local default retention is 90 days, configurable from 1 to 3650 days, with startup/daily cleanup and immediate `DELETE /api/analyses/:id` support (feedback cascades). Only fields required by the workflows are persisted. Because phenotype and review-note free text cannot be reliably scrubbed, this unauthenticated local prototype must not receive identifiable or sensitive patient data; these controls are not a production privacy/compliance program.

**Deliverable:** agreed API examples and validation schemas, explicit score semantics, and a documented storage boundary. JSON files remain appropriate for immutable or batch-produced scientific artifacts; PostgreSQL is appropriate for concurrent, queryable, transactional user workflows and review history.

## Phase 6: Backend and Database

Status: In progress. All Phase 6A checkpoints for the local AMR research demo are complete. Phase 6B now has an end-to-end HPO normalization and ranking workflow with versioned resource provenance persisted in PostgreSQL. The independent-case evaluation gate remains open; the product stays research-only and is not clinically validated.

### Product-critical AMR bugs (block claims that the app finds an appropriate antibiotic)

AMR-BUG-02 progress: the local `data:fasta:preflight` CLI is implemented as an offline structure/statistics check. It reports the input checksum and assembly summary, while explicitly leaving biological quality unassessed. It is not an upload workflow, quality gate, taxonomy classifier, resistance caller, or completion of AMR-BUG-02.

- [x] **AMR-BUG-01 — Resolved: serving catalog now matches the 2M cohort and excludes train/validation genomes.** The streaming SQLite catalog records deterministic genome-fold label counts, source/model/vocabulary provenance, source-call counts, and overlap with the superseded 10K catalog. Serving queries exclude all genomes with training or validation labels; only held-out-test and unlabeled genomes are eligible.
- [ ] **AMR-BUG-02 — User assembly FASTA ingestion is not implemented.** Scope decision (2026-10-11): support user-provided bacterial assembly FASTA as a separate workflow from the bounded BV-BRC ID lookup. Do not accept uploads until FASTA validation, assembly quality gates, taxonomy verification, and a pinned resistance caller are integrated and tested. On the current 31.7 GiB RAM host, [GTDB-Tk 2.7.2](https://github.com/Ecogenomics/GTDBTk/releases/tag/2.7.2) is not runnable: its GTDB R232 reference package is 98 GB and [the R232 release notes](https://github.com/Ecogenomics/GTDBTk/releases/tag/2.7.0) warn it requires at least 140 GB RAM. [AMRFinderPlus 4.2.7](https://github.com/ncbi/amr/releases/tag/amrfinder_v4.2.7) with [database 2026-08-07.1](https://ftp.ncbi.nlm.nih.gov/pathogen/Antimicrobial_resistance/AMRFinderPlus/database/latest/version.txt) is a candidate determinant caller (binary SHA-256 `68045a8bccdbe3c5dcdf941bebe2352ed419758a9914c41f48f0bbbd6fbade56`), but NCBI [explicitly states it does not predict phenotypic resistance](https://github.com/ncbi/amr/wiki/Interpreting-results#note-regarding-genotype-vs-phenotype); it cannot alone satisfy the genome-to-antibiotic workflow or replace the trained panel model. The removed pilot has not been reinstated.
- [x] **AMR-BUG-03 — Resolved for the current research-only scope.** The genome panel calls outputs model classes, states that S does not establish susceptibility, says the panel is not a ranking of effective drugs, and requires laboratory confirmation. The model still does not identify appropriate therapy; treatment claims remain unsupported and prohibited.
- [ ] **AMR-BUG-04 — Still blocks organism/drug-level use; evaluation reporting is partial progress.** The held-out genome-split report records 738 organism/antibiotic pairs from 15,660 test records with support counts, Wilson intervals for sensitivity/specificity, and deterministic bootstrap intervals for AUROC/AUPRC/Brier/ECE when the exploratory support floor is met. Aggregate test 95% bootstrap intervals are AUROC 0.7863–0.8013, AUPRC 0.6518–0.6804, Brier 0.1813–0.1912, and ECE 0.1310–0.1436. The genome-panel API/UI expose matching pair support, metrics, uncertainty, and insufficient-support/not-assessed states. Only 84 pairs meet the exploratory minimum of 30 records and 10 per class; 654 are below it, and AUROC is defined for 288 pairs. This floor is not a validated use criterion. The count-only overlap audit covers 77,380 source record IDs (zero crossing splits), no available source-group identifiers, and six submitter groups all crossing splits; submitter metadata is not a verified facility. See `data/models/amr_feature_baseline_metrics.json`. Test ECE/Brier intervals describe sampling uncertainty only; scores remain uncalibrated. Independent external evaluation and verified physical-laboratory identifiers are still missing; do not claim organism/drug-level reliability or clinical utility.

External evaluation gate: `ml-service/evaluate_external_amr.py` evaluates a locked model against canonical measured-AST JSONL and a provenance manifest. Each row must include unique `measurement_id`, biological `isolate_id`, `genome_id`, physical testing-facility `laboratory_id`, normalized `organism`/`antibiotic`, `resistant`/`susceptible` label, `products`, `evidence_class: laboratory`, and `testing_method`. The manifest must cite independent-source, facility/isolate identity, AST, and reuse-rights evidence and match the cohort SHA-256. The evaluator rejects exact overlap with training/validation genomes, counts and excludes out-of-vocabulary rows, and reports aggregate, per-pair, per-facility, Wilson, and lab-cluster-bootstrap metrics without retuning the threshold. Run with `python ml-service/evaluate_external_amr.py --cohort <external.jsonl> --manifest <manifest.json> --output <report.json>`. The evaluator cannot authenticate manifest claims; a reviewer must check the cited source documentation. No qualifying external cohort is currently present, so this gate does not close BUG-04; the existing BV-BRC cohort lacks physical-facility identifiers and is not an independent external test.

Work order: AMR-BUG-01 and the AMR-BUG-03 presentation guardrail are resolved. AMR-BUG-02 remains deferred; keep FASTA upload blocked until a resource-feasible, pinned taxonomy/quality/caller pipeline is validated. AMR-BUG-04 remains open after adding exploratory pair-level intervals and a count-only overlap audit; independent source evaluation and verified physical-laboratory identifiers are still required. Do not mark the overall AMR product goal complete based on successful API or browser plumbing.

Use the PostgreSQL service already defined in `docker-compose.yml`; use the `pg` client and checked-in, numbered SQL migrations. Do not import the large source JSON/JSONL datasets into PostgreSQL. Store dataset/model metadata and artifact paths/checksums in the registry tables.

Create these initial tables:

- `analysis_runs` with workflow, validated input JSON, result JSON, status, timestamps, and model/dataset version foreign keys.
- `review_feedback` with analysis ID, reviewer decision, notes, and timestamp.
- `model_versions` and `dataset_versions` with immutable version IDs, checksums, and provenance.
- Add `users` and authorization when multi-user access is enabled; do not block a local single-user research MVP on account management.

### Phase 6A: AMR hands-on research workflow

- [x] **Checkpoint 6A.1 — Artifact and provenance gate**

	- Model and report versions must match; the model SHA-256 is verified on load.
	- Model/report stay files and are mounted read-only; model and dataset versions/checksums are registered in PostgreSQL.
	- A completed analysis stores the exact model/dataset versions and survives an API restart.

- [x] **Checkpoint 6A.2 — Inference and persistence vertical slice**

	- Browser → Express → FastAPI → trained artifact returns a score, threshold, evidence, and evaluation caveats.
	- Success and failure status are persisted; database/model-service readiness are reported independently.
	- Scores are explicitly uncalibrated, not probabilities. The existing validation-selected threshold is shown as a research baseline threshold, not a treatment cutoff.

- [x] **Checkpoint 6A.3 — Usable and bounded feature entry**

	- Generate a versioned vocabulary of normalized resistance-product names from the model’s training cohort; include provenance and a checksum, but do not expose labels or identifiers.
	- Add an API lookup route and browser autocomplete/multi-select for product names. Keep organism and antibiotic values constrained to known model categories or clearly warn when a category is unseen.
	- Detect out-of-vocabulary product/category values. Do not silently treat them as learned evidence; either reject them with an actionable message or return an explicit OOV warning and do not imply the model interpreted them.
	- Keep raw gene symbols separate: do not claim gene-to-product mapping until a curated mapping source, mapping version, and tests are added.

- [x] **Checkpoint 6A.4 — Automated service/API failure coverage**

	- Test valid and invalid request contracts, request-size limits, unknown fields, and response semantics.
	- Test missing/corrupt/mismatched model artifacts and an unavailable ML service.
	- Assert an inference failure leaves a failed analysis row with model/dataset versions and no fabricated result; assert successful rows can be reopened after restart.
	- Test retention expiry and early deletion, including cascade deletion of reviewer feedback.

- [x] **Checkpoint 6A.5 — Hands-on local research demo acceptance**

	- Provide a clearly labeled non-clinical sample workflow using documented, non-identifiable example features; do not seed a result that implies a real patient recommendation.
	- Verify a user can select valid inputs, run inference, inspect score semantics/evidence/caveats, review the result, and retrieve/delete the saved run.
	- Record the current evaluation context with each displayed result: genome-held-out test, 15,660 records, AUROC 0.794, AUPRC 0.666, ECE 0.137. Explain that this is not physical-laboratory generalization and not evidence of calibration.
	- Keep the workflow local and research-only. Do not enable clinical/patient use or wider deployment based on this checkpoint.

Checkpoint 6A.5 acceptance (2026-10-10): loaded the documented synthetic feature tuple in the browser without pre-seeding a result; ran inference; verified score semantics, all three aggregate metrics and limitations; recorded reviewer feedback; reopened the saved run; and deleted it from history. The sample flow had no horizontal overflow at a 390px viewport. No clinical or physical-laboratory performance claim is made.

- [x] **Checkpoint 6A.6 — Held-out genome-ID antibiotic panel from the 2M cohort**

	- Build a streaming, checksummed, disk-backed index from the enriched 2M cohort; retain only products represented by the trained model vocabulary and record source/model/vocabulary provenance.
	- Audit genome IDs against the exact deterministic genome split used to train the model; never serve training or validation genomes as new predictions. Report held-out-test and unlabeled-genome counts separately.
	- Search/select an eligible catalog genome ID in the browser; reject missing, ambiguous-organism, training/validation, and out-of-catalog IDs explicitly.
	- Score every trained antibiotic for the selected genome using the existing sparse classifier; show the raw score, validation-selected research threshold, and model-predicted binary R/S class. Explicitly state that predicted S is not measured susceptibility or proof of effectiveness; this model has no I class and must not recommend treatment.
	- Persist the genome ID, returned panel, and exact genome catalog/source checksums in the existing analysis history.
	- Verify reproducible catalog generation, raw/enriched source checksums, train/validation exclusion, integrity failure behavior, API persistence/reopen, desktop/mobile browser flow, and no overflow at 390px.
	- Keep arbitrary FASTA/sequence analysis out of scope. This is a lookup of previously computed BV-BRC calls for a bounded cohort, not an arbitrary-genome analyzer or clinically validated antibiogram.

Checkpoint 6A.6 prior demo (2026-10-11; superseded): a 10K-derived catalog was wired to the browser and returned a 137-drug panel. This does not satisfy the checkpoint because it used a cohort different from the model's 2M source and did not audit training-genome overlap. Do not use that catalog for product claims.

### Phase 6B: Rare-disease HPO workflow

- [x] Normalize input against the versioned HPO term index using exact IDs, canonical names, or synonyms; require users to resolve ambiguous and unmatched terms rather than silently guessing.
- [x] Call the existing HPO Resnik-style ranker and return supporting phenotype matches, unreported profile terms (not known to be absent), contradiction scores, and relative-score semantics.
- [x] Persist the ranker version and checksum-derived dataset version covering the disease profiles, HPO graph, and term index with each analysis.
- [ ] Complete independent-case evaluation with leakage controls before making claims beyond research use. A per-case exact-PMID leave-publication-out evaluation now removes each case's cited paper from every candidate profile and recomputes information content: 178/250 cases retained target-disease evidence, with Top-1 0.0393, Top-5 0.0899, and MRR 0.067924; 72 cases had no remaining target evidence. This source-held-out result is weak and remains exploratory. Exact PMID removal does not rule out shared cohorts, derivative publications, unlinked references, or establish independent/clinical validation; obtain a genuinely independent case cohort before closing this gate.

The AMR vertical slice, bounded feature entry, automated failure coverage, and local browser acceptance are complete. History/detail, deletion, feedback, and registry routes are present. Health checks report database and AMR model-service readiness separately.

API routes:

```text
GET  /api/health
GET  /api/amr/genomes
POST /api/amr/predict
POST /api/amr/genome-panel
POST /api/rare-disease/rank
GET  /api/analyses
GET  /api/analyses/:id
DELETE /api/analyses/:id
POST /api/analyses/:id/feedback
GET  /api/models
GET  /api/datasets
```

**Phase 6A done when:** all 6A checkpoints pass; users can select known model features or a supported genome ID; OOV input is explicit; success/failure and retention behavior are automated-tested; and saved runs show exact provenance after restart. Genome-ID panel output remains a bounded research workflow, not a clinically validated antibiogram.

**Phase 6B done when:** phenotype normalization and HPO ranking are connected end to end, exact ontology/profile versions persist with results, and independent evaluation supports the stated ranking claims.

## Phase 7: Frontend Product

Build these screens:

1. Workspace dashboard.
2. AMR prediction form.
3. Rare-disease differential form.
4. Evidence and explanation panel.
5. Analysis history.
6. Model-version view.
7. Dataset-provenance view.
8. Human-review form.
9. Experiment-comparison view.

Required UI states:

- Empty state.
- Loading state.
- API failure.
- Invalid input.
- Low-confidence result.
- Conflicting evidence.
- No matching candidates.
- Research-only warning.
- Download or export result.

## Phase 8: Evaluation

### AMR metrics

- AUROC.
- AUPRC.
- F1 score.
- Sensitivity.
- Specificity.
- Expected calibration error.
- Performance by organism.
- Performance by antibiotic.
- Performance by laboratory.
- Performance by collection year.

### Rare-disease metrics

- Top-1 accuracy.
- Top-5 accuracy.
- Mean reciprocal rank.
- Recall at K.
- Calibration error.
- Robustness under missing phenotypes.
- Robustness under noisy phenotype names.
- Explanation agreement with source evidence.

## Phase 9: Testing

- Unit tests for data normalization.
- Unit tests for scoring logic.
- API contract tests.
- Model input/output tests.
- Database integration tests.
- Frontend component tests.
- Playwright workflow tests.
- Mobile and desktop browser validation.
- Dataset reproducibility test.
- Security tests for uploaded files and request payloads.

## Phase 10: Deployment

### Local Docker Compose services

```text
frontend
backend
ml-service
postgres
data-worker
```

### Production requirements

- Build the frontend into static assets.
- Deploy the backend behind HTTPS.
- Deploy the ML service separately.
- Store datasets in object storage.
- Store credentials only in environment secrets.
- Add request logging and rate limits.
- Add database backups.
- Add model and dataset versioning.

## Completion Criteria

The project is complete when:

- Both workflows work in the browser.
- API and ML services run independently.
- Dataset versions are recorded.
- Results expose scores and supporting evidence with accurate semantics; probabilities are shown only for models with documented calibration.
- AMR results require laboratory confirmation.
- Rare-disease results state that they are not clinical diagnoses.
- Models are evaluated against documented baselines.
- Results and feedback persist in the database.
- Desktop and mobile workflows pass browser tests.
- The production build succeeds.
- Deployment instructions are reproducible.

### AMR Data-Scope Audit Checkpoints

- [x] **A1 — Pinned cohort and provenance:** streamed the deduplicated source with bounded memory; the report includes source SHA-256 and checks its record count against the processing report.
- [x] **A2 — Evidence separation:** laboratory, computational, and other evidence are reported independently; only laboratory R/S contributes to pair support.
- [x] **A3 — Genome linkage:** counted genome IDs and reproduced the deterministic split; contradictory R/S genome IDs are excluded from class support. Accession IDs do not prove isolate uniqueness or sequence availability/quality.
- [x] **A4 — AST metadata:** report records measurement/unit/sign, method, standard/year, collection year, source IDs, numeric measurements, and platform/publication availability. Platform/publication fields were not retained in the normalized cohort; no explicit breakpoint values or references were found.
- [x] **A5 — Pair support/conflicts:** report R/S/I/NS/unknown counts, unique genome IDs by split and protocol, label conflicts, and metadata completeness in `data/models/amr_scope_audit.json` and its pair CSV.
- [x] **A6 — Measured-AST scope rule:** re-evaluated the 100 train / 30 test per-class floor using unique genomes with a numeric AST value and unit linked to the same label, split, and method/standard/year stratum. Zero of 2,006 laboratory-supported species/drug pairs passed. The earlier *Streptococcus pneumoniae*–trimethoprim/sulfamethoxazole counts (train R/S 107/131; test R/S 37/43) were genome-linked label support, not counts of genomes with matched numeric AST, and are withdrawn as a scope candidate.
- [ ] **A7 — Breakpoint and facility verification:** blocked until versioned species/drug breakpoint evidence and physical testing-facility identifiers can be verified; submitter metadata is not facility identity.
- [x] **A8 — Scope/validation decision:** no species/drug scope is selected. Both adequate matched measured-AST support and breakpoint verification are required; the current cohort has no pair passing the former and no explicit breakpoint evidence for the latter. Verified physical-lab provenance and independent external validation also remain required.

Run `npm run test:amr-scope-audit` for the focused decision and aggregation tests. Run `npm run data:audit:amr-scope` to write `data/models/amr_scope_audit.json` and `data/models/amr_scope_audit_pairs.csv`.

## Immediate Next Steps

1. Complete the Phase 6B independent-case evaluation gate; keep rare-disease outputs research-only until adequate independent evidence supports the stated ranking claims.
2. Keep AMR-BUG-04 tracked as a blocker for organism/drug reliability and unseen-laboratory claims, not as a blocker to local research-workflow development.
3. Defer wider deployment until access control and production privacy safeguards exist.

Do not claim arbitrary FASTA phenotype prediction as complete. The sequence bridge is intentionally gated on a pinned caller runtime, reviewed determinant mapping, and independent validation.
