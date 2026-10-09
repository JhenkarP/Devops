# SignalLab

SignalLab is a research web product with two evidence-led workflows:

- **Antibiotic resistance:** a transparent genotype-to-phenotype baseline that surfaces resistance markers, uncertainty, and confirmatory-testing caveats.
- **Rare disease:** an ontology-style phenotype differential that reports supporting and missing findings.

The current inference services are baselines, not clinical models. The interface explicitly reports that limitation.

## Run

```bash
npm install
npm run dev
```

In a second terminal:

```bash
cd backend
npm install
npm run dev
```

Optional Python service:

```bash
cd ml-service
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Download reference data:

```bash
npm run data:download
```

The downloaded resources and their provenance are recorded in `data/manifest.json`. They are reference annotations, not patient-level validation data.
