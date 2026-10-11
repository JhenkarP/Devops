# SignalLab

SignalLab is a local research prototype with two workflows:

- **Antibiotic resistance:** serves the trained SGD feature baseline using organism, antibiotic, and normalized resistance-product names. Its score is uncalibrated and must not guide treatment.
- **Rare disease:** normalizes exact HPO IDs, names, and synonyms before ranking disease profiles with the HPO Resnik-style research ranker. Ambiguous and unmatched terms must be resolved; scores are relative, not probabilities.

The AMR model artifact, evaluation report, feature vocabulary, and genome feature catalog are mounted read-only into the ML container and checked against pinned versions and SHA-256 values. The vocabulary is generated only from the model cohort's training split. The genome catalog is a streaming SQLite index built from the enriched 2M BV-BRC cohort; it retains model-compatible precomputed resistance-product calls and withholds genomes with training or validation labels. It does not run a sequence aligner, accept arbitrary FASTA files, or map raw gene symbols to products.

## Data Storage

PostgreSQL stores operational analysis runs, their JSON input/output snapshots, model-version metadata, and review feedback. The Compose setup persists this database in the `postgres-data` volume. Source datasets, ontologies, model artifacts, and generated reports remain files; the database stores registry metadata and references rather than importing those large resources.

This is a local, unauthenticated research prototype. Ports are loopback-bound. Do not expose it to a network or enter patient-identifying or otherwise sensitive clinical information. Version 1 requests reject undeclared fields and persist only the declared workflow inputs; free-text phenotype and review-note fields cannot be reliably screened for identifiers, so they must contain research-safe, de-identified text only. Request bodies are limited to 1 MiB.

Analysis records and linked feedback are automatically deleted after 90 days by default. Cleanup runs at API startup and daily; `ANALYSIS_RETENTION_DAYS` can be set from 1 to 3650 days. `DELETE /api/analyses/:id` removes an analysis immediately and cascades to its feedback. PostgreSQL stores analysis input/output JSONB and registry metadata, not the scientific source files. This retention rule is a local prototype default, not a production compliance policy.

Every API response includes `X-SignalLab-API-Version: 1.1.0`. The shared request/response contract lives in `backend/api-contract.js` and is imported by both the API and frontend.

## Run with Docker

```bash
docker compose up --build -d
```

Open `http://localhost:5173`. The API, model service, and database ports are bound to loopback. Stop the stack with `docker compose down`; this preserves the PostgreSQL volume.

The pinned cohort, model, report, vocabulary, and generated genome catalog must be present under `data/` before starting the stack. The genome-ID lookup is built from `data/amr_2m/processed/bvbrc_amr_2000000_enriched.jsonl` using `npm run data:build:amr-genome-catalog`. The builder streams the enriched 2M cohort into `data/models/amr_genome_catalog.sqlite`, verifies source/enrichment provenance, and writes a checksum manifest beside it. The prior 10K JSON catalog is superseded and is not used for serving.

Run the Phase 6A.4 contract, API integration, and ML artifact tests with `npm run test:phase6a4` while PostgreSQL is running. The API tests create a uniquely named temporary schema in `TEST_DATABASE_URL`, `DATABASE_URL`, or the local Compose database, then drop it after the run.

The primary AMR path accepts BV-BRC genome IDs present in the 2M SQLite catalog and scores a 137-antibiotic panel from that genome's precomputed, model-compatible product calls. Genomes with laboratory labels in the training or validation partitions are withheld from panel inference; held-out test and unlabeled genomes may be served. Scores are uncalibrated research signals: a flagged score is not a treatment recommendation, and a score below threshold does not establish susceptibility. The full genome catalog and model source provenance are recorded with each result. Arbitrary genome sequence upload and analysis are not implemented. The secondary manual-feature demo remains available; its **Load example** tuple is synthetic and not linked to a patient, specimen, or laboratory record.

Every result shows the genome-held-out aggregate test context (15,660 records; AUROC 0.794; AUPRC 0.666; ECE 0.137), states that the score is uncalibrated and not a probability, and notes that this evaluation does not establish unseen-physical-laboratory performance or per-genome predictive validity. Saved runs can be opened, reviewed, or deleted from history.

## Raw Sequence Boundary

The raw-sequence boundary is versioned in `shared/amr-sequence-contract.js`. It binds a staged FASTA artifact to the `fasta-preflight-1` report by SHA-256 and defines the future normalized resistance-feature shape. Taxonomy confirmation, AMR calling, mutation detection, and tool/database provenance remain unimplemented until a pinned caller adapter is selected.

## Validation Status

- Scope implementation: complete.
- External-cohort scaffold: complete. See `data/external_amr/cohort.jsonl` and `data/external_amr/manifest.json`.
- Independent laboratory data: not acquired.
- External validation: blocked. The scaffold is intentionally empty and does not attest independence.

The AMR Evidence Review Workspace uses existing BV-BRC held-out evidence only. It can filter pair support, export JSON or CSV evidence summaries, record research-review notes and decisions, and display genome provenance and data-quality checks. It does not create external validation evidence or determine clinical susceptibility.

## Run Services Separately

Copy `.env.example` to `.env`, start Postgres, then start the ML service and API in separate terminals. Start the frontend with `npm run dev`.

```bash
docker compose up -d postgres
```

Start the ML service (the checked-in root `.venv` can be used, or install `ml-service/requirements.txt` into your environment):

```bash
cd ml-service
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Then start the API (the first startup applies checked-in SQL migrations and registers model/dataset versions):

```bash
npm run api
```

Download reference data:

```bash
npm run data:download
```

The downloaded resources and their provenance are recorded in `data/manifest.json`. They are reference annotations, not patient-level validation data.
