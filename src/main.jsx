import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { API_ENDPOINTS, API_VERSION, API_VERSION_HEADER } from '../shared/api-contract.js';
import './styles.css';
import './persistence.css';
import './amr-vocabulary.css';
import './evidence-review.css';
import './sequence-upload.css';

const API_ORIGIN = (import.meta.env.VITE_API_URL || 'http://localhost:8787/api').replace(/\/api\/?$/, '');

async function apiRequest(path, options) {
  const response = await fetch(`${API_ORIGIN}${path}`, options);
  if (response.headers.get(API_VERSION_HEADER) !== API_VERSION) {
    throw new Error('The API version is incompatible with this frontend.');
  }
  return response;
}

const initialAmr = { organism: 'klebsiella pneumoniae', antibiotic: 'meropenem', products: [] };
const researchSample = { organism: 'klebsiella pneumoniae', antibiotic: 'meropenem', products: ['resistance protein'] };
const initialRare = { phenotypes: 'developmental delay, congenital heart defect, hearing loss, persistent fetal fingertip pads' };

function App() {
  const [module, setModule] = useState('amr');
  const [amrInputMode, setAmrInputMode] = useState('genome');
  const [genomeQuery, setGenomeQuery] = useState('');
  const [genomeSuggestions, setGenomeSuggestions] = useState([]);
  const [genomeCatalogCount, setGenomeCatalogCount] = useState(null);
  const [genomeCatalogNotice, setGenomeCatalogNotice] = useState('');
  const [sequenceStatus, setSequenceStatus] = useState(null);
  const [sequencePreflight, setSequencePreflight] = useState(null);
  const [amr, setAmr] = useState(initialAmr);
  const [vocabulary, setVocabulary] = useState(null);
  const [productEntry, setProductEntry] = useState('');
  const [vocabularyNotice, setVocabularyNotice] = useState('');
  const [rare, setRare] = useState(initialRare);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [normalizationIssues, setNormalizationIssues] = useState([]);
  const [history, setHistory] = useState([]);
  const [historyNotice, setHistoryNotice] = useState('');
  const [feedbackNotice, setFeedbackNotice] = useState('');
  const [reviewNotes, setReviewNotes] = useState('');

  async function loadHistory() {
    try {
      const response = await apiRequest(`${API_ENDPOINTS.analyses.path}?limit=20`);
      if (!response.ok) throw new Error('History unavailable');
      setHistory((await response.json()).analyses);
      setHistoryNotice('');
    } catch {
      setHistoryNotice('Analysis history is unavailable until the API and database are running.');
    }
  }

  async function loadVocabulary() {
    try {
      const response = await apiRequest(API_ENDPOINTS.amrVocabulary.path);
      if (!response.ok) throw new Error('The trained AMR feature vocabulary is unavailable.');
      const data = await response.json();
      setVocabulary(data);
      const scopePairs = Array.isArray(data.scope_pairs) && data.scope_pairs.length
        ? data.scope_pairs
        : (data.antibiotics || []).map(antibiotic => ({ antibiotic }));
      setAmr(current => ({
        ...current,
        organism: data.scope_organism || data.organisms?.[0] || current.organism,
        antibiotic: scopePairs.some(pair => pair.antibiotic === current.antibiotic) ? current.antibiotic : scopePairs[0]?.antibiotic || current.antibiotic,
      }));
      setVocabularyNotice('');
    } catch (error) {
      setVocabularyNotice(error.message);
    }
  }

  useEffect(() => {
    loadHistory();
    loadVocabulary();
    apiRequest(API_ENDPOINTS.amrSequenceStatus.path).then(async response => {
      if (response.ok) setSequenceStatus(await response.json());
    }).catch(() => setSequenceStatus(null));
  }, []);

  useEffect(() => {
    if (module !== 'amr' || amrInputMode !== 'genome') return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setGenomeCatalogCount(null);
      try {
        const query = genomeQuery.trim();
        const params = new URLSearchParams({ limit: '12' });
        if (query) params.set('q', query);
        const response = await apiRequest(`${API_ENDPOINTS.amrGenomes.path}?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Genome catalog is unavailable.');
        const data = await response.json();
        setGenomeSuggestions(data.genomes);
        setGenomeCatalogCount(data.total);
        setGenomeCatalogNotice('');
      } catch (error) {
        if (error.name !== 'AbortError') setGenomeCatalogNotice(error.message);
      }
    }, genomeQuery.trim() ? 180 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [module, amrInputMode, genomeQuery]);

  const normalizedProductEntry = productEntry.trim().toLowerCase().replace(/\s+/g, ' ');
  const productEntryIsKnown = Boolean(vocabulary?.products.includes(normalizedProductEntry));

  function addProduct() {
    if (!productEntryIsKnown) return;
    setAmr(current => current.products.includes(normalizedProductEntry)
      ? current
      : { ...current, products: [...current.products, normalizedProductEntry] });
    setProductEntry('');
    setNotice('');
  }

  function loadResearchSample() {
    setAmrInputMode('manual');
    setAmr(researchSample);
    setProductEntry('');
    setResult(null);
    setNotice('');
    setFeedbackNotice('');
  }

  async function deleteAnalysis(id) {
    try {
      const response = await apiRequest(API_ENDPOINTS.analysisDelete.path.replace(':id', encodeURIComponent(id)), { method: 'DELETE' });
      if (!response.ok) throw new Error('Saved analysis could not be deleted.');
      setHistory(current => current.filter(item => item.id !== id));
      if (result?.analysis_id === id) {
        setResult(null);
        setFeedbackNotice('');
      }
      setHistoryNotice('Saved analysis deleted.');
    } catch (error) {
      setHistoryNotice(error.message);
    }
  }

  async function openAnalysis(id) {
    setFeedbackNotice('');
    try {
      const response = await apiRequest(API_ENDPOINTS.analysisDetail.path.replace(':id', encodeURIComponent(id)));
      if (!response.ok) throw new Error('Could not load this analysis.');
      const data = await response.json();
      setModule(data.analysis.workflow === 'amr' ? 'amr' : 'rare');
      setResult(data.analysis.result_data);
    } catch (error) {
      setHistoryNotice(error.message);
    }
  }

  async function submitFeedback(decision) {
    if (!result?.analysis_id) return;
    try {
      const response = await apiRequest(API_ENDPOINTS.analysisFeedback.path.replace(':id', encodeURIComponent(result.analysis_id)), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, notes: reviewNotes }),
      });
      if (!response.ok) throw new Error('Feedback could not be saved.');
      setFeedbackNotice('Review recorded.');
    } catch (error) {
      setFeedbackNotice(error.message);
    }
  }

  async function uploadSequence(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setLoading(true);
    setNotice('');
    setSequencePreflight(null);
    try {
      const response = await apiRequest(API_ENDPOINTS.amrSequencePreflight.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-SignalLab-Filename': file.name },
        body: file,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'FASTA preflight failed.');
      setSequencePreflight(data);
      loadHistory();
    } catch (error) {
      setNotice(error.message || 'FASTA preflight failed.');
    } finally {
      setLoading(false);
    }
  }

  async function analyze(event) {
    event.preventDefault();
    if (module === 'amr' && amrInputMode === 'manual' && productEntry.trim()) {
      setNotice(productEntryIsKnown
        ? 'Add the selected product before running the analysis.'
        : 'That product is outside the trained vocabulary. Select a listed product or clear the entry.');
      return;
    }
    setLoading(true); setNotice(''); setNormalizationIssues([]); setResult(null);
    const endpoint = module === 'amr'
      ? amrInputMode === 'genome' ? API_ENDPOINTS.amrGenomePanel.path : API_ENDPOINTS.amrPredict.path
      : API_ENDPOINTS.rareDiseaseRank.path;
    const body = module === 'amr'
      ? amrInputMode === 'genome' ? { genome_id: genomeQuery.trim() } : amr
      : rare;
    try {
      const response = await apiRequest(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (Array.isArray(data.normalization)) {
          setNormalizationIssues(data.normalization.filter(item => item.match_type !== 'exact_hpo_id' && item.match_type !== 'exact_name_or_synonym'));
        }
        throw new Error(data.error || 'API unavailable');
      }
      setResult(await response.json());
      loadHistory();
    } catch (error) {
      setNotice(error.message || 'API is offline. Start `npm run api` to enable live analysis.');
    } finally { setLoading(false); }
  }

  return <div className="app-shell">
    <header className="topbar"><div className="brand-mark">SL</div><div><p className="eyebrow">RESEARCH INTELLIGENCE / 01</p><h1>SignalLab</h1></div><div className="top-status"><span className="pulse" /> Local research workspace</div></header>
    <main className="content">
      <section className="intro"><div><p className="eyebrow">DECISION SUPPORT PROTOTYPE</p><h2>Make uncertainty<br /><em>visible.</em></h2></div><p className="intro-copy">Two evidence-led workflows for exploring genotype-to-phenotype resistance and rare-disease differentials. Built for research review, never as a replacement for laboratory or clinical judgment.</p></section>
      <nav className="module-tabs" aria-label="Research modules"><button className={module === 'amr' ? 'active' : ''} onClick={() => { setModule('amr'); setResult(null); }}><span>01</span> Antibiotic resistance</button><button className={module === 'rare' ? 'active' : ''} onClick={() => { setModule('rare'); setResult(null); }}><span>02</span> Rare disease</button></nav>
      <section className="workspace">
        <form className="input-panel" onSubmit={analyze}>
          <div className="panel-heading"><div><p className="eyebrow">{module === 'amr' ? 'GENOTYPE → PHENOTYPE' : 'PHENOTYPES → DIFFERENTIAL'}</p><h3>{module === 'amr' ? 'Resistance signal' : 'Phenotype profile'}</h3></div><span className="step">INPUT</span></div>
          {module === 'amr' ? <>
            <div className="amr-input-modes" role="group" aria-label="AMR input method"><button type="button" className={amrInputMode === 'genome' ? 'active' : ''} aria-pressed={amrInputMode === 'genome'} onClick={() => { setAmrInputMode('genome'); setResult(null); }}>Genome ID</button><button type="button" className={amrInputMode === 'manual' ? 'active' : ''} aria-pressed={amrInputMode === 'manual'} onClick={() => { setAmrInputMode('manual'); setResult(null); }}>Manual features</button></div>
            {amrInputMode === 'genome' ? <>
              {sequenceStatus && <div className="genome-scope sequence-status"><strong>Raw FASTA workflow</strong><span>{sequenceStatus.status === 'ready_for_prediction' ? 'Sequence-native model is ready.' : 'Caller runtime is ready; sequence-native model training data is still required.'}</span><small>AMRFinderPlus {sequenceStatus.caller.version} · database {sequenceStatus.caller.database_version} · model {sequenceStatus.model.status}</small></div>}
              <div className="sequence-upload"><label htmlFor="amr-fasta-upload">Upload FASTA<input id="amr-fasta-upload" type="file" accept=".fa,.fna,.fasta,.fa.gz,.fna.gz,.fasta.gz" onChange={uploadSequence} disabled={loading} /></label><span>Preflight checks structure and nucleotide characters only.</span></div>
              {sequencePreflight && <div className="sequence-preflight-result" role="status"><strong>{sequencePreflight.status === 'caller_complete' ? 'FASTA preflight and caller complete' : 'FASTA preflight complete'}</strong><span>{sequencePreflight.preflight.input_file} · {sequencePreflight.preflight.contig_count.toLocaleString()} contigs · {sequencePreflight.preflight.total_bases.toLocaleString()} bases · N50 {sequencePreflight.preflight.n50.toLocaleString()}</span><small>SHA-256 {sequencePreflight.preflight.input_sha256} · assembly quality {sequencePreflight.preflight.assembly_quality_status} · taxonomy {sequencePreflight.preflight.taxonomy_status} · caller {sequencePreflight.caller.status} · normalized determinants {sequencePreflight.caller.features?.features?.length ?? 0} · model {sequencePreflight.model.status}</small></div>}
              <div className="genome-scope"><strong>BV-BRC genome catalog</strong><span>Uses precomputed feature calls from this bounded cohort. It does not analyze uploaded sequence files.</span></div>
              <label htmlFor="amr-genome-id">Genome ID or organism</label>
              <input id="amr-genome-id" list="amr-genome-options" autoComplete="off" value={genomeQuery} onChange={event => setGenomeQuery(event.target.value)} placeholder="Search by BV-BRC ID or organism" pattern="\d+\.\d+" title="Choose a BV-BRC genome ID from the suggestions" required />
              <datalist id="amr-genome-options">{genomeSuggestions.map(genome => <option key={genome.genome_id} value={genome.genome_id} label={`${genome.organism} · ${genome.detected_product_count} products`} />)}</datalist>
              <p className="helper">{genomeCatalogCount === null ? 'Loading the indexed genome catalog…' : `${genomeCatalogCount.toLocaleString()} model-compatible genome profiles · search by ID or organism`}</p>
              {genomeCatalogCount === 0 && <p className="validation-warning" role="status">No model-compatible genome profiles match this search. Choose a listed BV-BRC genome ID.</p>}
              {genomeCatalogNotice && <p className="notice" role="alert">{genomeCatalogNotice}</p>}
            </> : <>
              <div className="sample-workflow"><div><strong>Non-clinical example</strong><span>Synthetic features only; no patient or isolate record.</span></div><button type="button" disabled={!vocabulary} onClick={loadResearchSample}>Load example</button></div>
              <label>Organism<select required disabled={!vocabulary} value={amr.organism}><option>{vocabulary?.scope_organism || 'Loading scope…'}</option></select></label>
              <label>Antibiotic<select required disabled={!vocabulary} value={amr.antibiotic} onChange={event => setAmr({ ...amr, antibiotic: event.target.value })}>{(vocabulary?.scope_pairs || []).map(pair => <option key={pair.antibiotic} value={pair.antibiotic}>{pair.antibiotic}</option>)}</select></label>
              <label htmlFor="amr-product-entry">Resistance-associated product</label>
              <div className="feature-entry"><input id="amr-product-entry" list="amr-product-options" autoComplete="off" value={productEntry} disabled={!vocabulary} onChange={event => setProductEntry(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addProduct(); } }} placeholder="Search trained products" /><datalist id="amr-product-options">{(vocabulary?.products || []).map(product => <option key={product} value={product} />)}</datalist><button type="button" onClick={addProduct} disabled={!productEntryIsKnown}>Add</button></div>
              {productEntry.trim() && !productEntryIsKnown && <p className="validation-warning" role="status">Not in the trained vocabulary. This feature will not be added.</p>}
              <div className="selected-products" aria-label="Selected resistance products">{amr.products.map(product => <button className="selected-product" type="button" key={product} onClick={() => setAmr(current => ({ ...current, products: current.products.filter(item => item !== product) }))} aria-label={`Remove ${product}`} title={`Remove ${product}`}><span>{product}</span><b aria-hidden="true">×</b></button>)}{!amr.products.length && <span className="empty-products">No product features selected</span>}</div>
              <p className="helper">{vocabulary ? `Initial scope: ${vocabulary.scope_organism} · ${vocabulary.scope_pairs.length} antibiotic pairs · ${vocabulary.scope_status}` : 'Loading trained feature vocabulary…'} Raw gene symbols are not mapped automatically.</p>
              {vocabularyNotice && <p className="notice" role="alert">{vocabularyNotice}</p>}
            </>}
          </> : <>
            <label>Observed phenotypes<textarea className="tall" value={rare.phenotypes} onChange={event => setRare({ ...rare, phenotypes: event.target.value })} /></label>
            <p className="helper">Enter exact HPO names, synonyms, or IDs, separated by commas or new lines. Ambiguous and unmatched terms must be resolved before ranking.</p>
          </>}
          <button className="primary" disabled={loading}>{loading ? 'Analyzing…' : 'Run analysis'} <span>↗</span></button>{notice && <div className="notice" role="alert"><p>{notice}</p>{normalizationIssues.map((item, index) => <p className="validation-warning" key={`${item.input}-${index}`}>{item.input}: {item.match_type === 'ambiguous' ? `Ambiguous match: ${item.candidates.map(candidate => `${candidate.term} (${candidate.hpo_id})`).join('; ')}` : 'No exact HPO ID, name, or synonym match.'}</p>)}</div>}
        </form>
        <div><ResultPanel result={result} type={module} />{result?.analysis_id && <div className="review-controls"><span>Research review decision</span><textarea value={reviewNotes} onChange={event => setReviewNotes(event.target.value)} maxLength={2000} placeholder="Add a de-identified review note" aria-label="Research review note" /><div><button onClick={() => submitFeedback('accept')}>Accept</button><button onClick={() => submitFeedback('needs_review')}>Needs review</button><button onClick={() => submitFeedback('reject')}>Reject</button></div>{feedbackNotice && <small role="status">{feedbackNotice}</small>}</div>}</div>
      </section>
      <section className="analysis-history" aria-label="Saved analysis history">
        <div className="history-heading"><div><p className="eyebrow">POSTGRESQL</p><h3>Recent analyses</h3></div><button onClick={loadHistory} aria-label="Refresh analysis history" title="Refresh history">↻</button></div>
        {historyNotice && <p className="notice">{historyNotice}</p>}
        {history.length ? <div className="history-list">{history.map(item => <div className="history-entry" key={item.id}><button className="history-row" onClick={() => openAnalysis(item.id)}><span className="history-workflow">{item.workflow === 'amr' ? 'AMR' : 'Rare disease'}</span><span className="history-model">{item.model_version}</span><span className={`history-status ${item.status}`}>{item.status}</span><time>{new Date(item.created_at).toLocaleString()}</time></button><button className="history-delete" type="button" aria-label={`Delete saved ${item.workflow === 'amr' ? 'AMR' : 'rare disease'} analysis`} onClick={() => deleteAnalysis(item.id)}>Delete</button></div>)}</div> : !historyNotice && <p className="history-empty">No saved analyses yet.</p>}
      </section>
      <footer><span>SignalLab / v0.1 research build</span><span>Evidence is provisional · confirm with qualified experts</span></footer>
    </main>
  </div>;
}

function ResultPanel({ result, type }) {
  if (!result) return <div className="result-panel empty"><div className="empty-glyph">＋</div><p>Analysis output will appear here</p><span>Evidence and limitations stay together.</span></div>;

  if (type === 'amr') {
    if (result.antibiotic_panel) return <GenomePanel result={result} />;
    const evaluation = result.evaluation;
    return <div className="result-panel">
      <div className="panel-heading"><div><p className="eyebrow">{result.evaluation_mode === 'trained_baseline_uncalibrated' ? 'AMR EVIDENCE REPORT' : 'SAVED ANALYSIS'}</p><h3>{result.prediction}</h3></div><span className="confidence">Raw score {result.resistance_score.toFixed(3)}</span></div>
      <div className="signal"><strong>{result.score_semantics}</strong><span>Research threshold: {result.decision_threshold.toFixed(2)}. This is a resistance signal threshold, not a treatment cutoff.</span></div>
      <Evidence title="Model evaluation" items={[
        `Genome-held-out test: ${evaluation.test_records?.toLocaleString() ?? 'n/a'} records; AUROC ${evaluation.test_auroc?.toFixed(3) ?? 'n/a'}; AUPRC ${evaluation.test_auprc?.toFixed(3) ?? 'n/a'}; ECE ${evaluation.test_expected_calibration_error?.toFixed(3) ?? 'n/a'}.`,
        'Aggregate benchmark metrics do not calibrate this individual score; the model output is not a probability.',
        'This genome-held-out evaluation does not establish generalization to unseen physical laboratories.',
      ]} />
      <Evidence title="Submitted features" items={result.evidence} />
      <Evidence title="Caveat" items={[result.caveat]} />
      <Evidence title="Provenance" items={[`Model ${result.model_version}; dataset ${result.dataset_version}; feature vocabulary ${result.feature_vocabulary_version}.`]} />
    </div>;
  }

  const candidates = result.candidates || [];
  const isHpoRanking = result.evaluation_mode === 'hpo_resnik_relative_ranking';
  return <div className="result-panel"><div className="panel-heading"><div><p className="eyebrow">{isHpoRanking ? 'HPO PROFILE RANKER' : 'SAVED ANALYSIS'}</p><h3>Candidate diseases</h3></div><span className="confidence">{candidates.length} ranked</span></div>{candidates.map((candidate, index) => {
    const supporting = candidate.supporting_terms
      ? candidate.supporting_terms.map(item => `${item.input_term || item.input_hpo_id} → ${item.matched_disease_term || item.matched_disease_hpo_id}`)
      : candidate.supporting || [];
    return <article className="candidate" key={candidate.disease_id || candidate.name}><div className="rank">{String(index + 1).padStart(2, '0')}</div><div className="candidate-main"><div className="candidate-title"><strong>{candidate.disease_name || candidate.name}</strong><span>{isHpoRanking ? `Relative score ${candidate.score.toFixed(3)}` : `Legacy score ${candidate.score.toFixed(2)}`}</span></div>{candidate.disease_id && <p className="muted">{candidate.disease_id}</p>}<p><b>Supporting HPO matches:</b> {supporting.join(' · ') || 'No direct phenotype match'}</p>{candidate.unreported_profile_term_count > 0 && <p className="muted"><b>Other profile terms not reported:</b> {candidate.unreported_profile_terms.map(item => item.term).join(' · ')}{candidate.unreported_profile_term_count > candidate.unreported_profile_terms.length ? ` · ${candidate.unreported_profile_term_count - candidate.unreported_profile_terms.length} more` : ''}. These are not known to be absent.</p>}{candidate.contradiction_score > 0 && <p className="muted"><b>Absent-phenotype contradiction:</b> {candidate.contradiction_score.toFixed(3)}</p>}{candidate.missing && <p className="muted"><b>Missing:</b> {candidate.missing.join(' · ') || 'No flagged findings'}</p>}</div></article>;
  })}{result.normalization && <Evidence title="Normalized phenotypes" items={result.normalization.map(item => `${item.input} → ${item.hpo_id} · ${item.matched_term}`)} />}<Evidence title="Method and limitations" items={[result.score_semantics, result.method, result.caveat]} />{result.dataset_sha256 && <Evidence title="Provenance" items={[`Ranker ${result.model_version}; HPO dataset ${result.dataset_version} (${result.dataset_sha256}).`, ...Object.entries(result.artifacts || {}).map(([name, artifact]) => `${name}: ${artifact.sha256}`)]} />}</div>;
}

function GenomePanel({ result }) {
  const evaluation = result.evaluation;
  const hasPredictedPhenotypes = result.antibiotic_panel.every(item => item.predicted_phenotype === 'R' || item.predicted_phenotype === 'S');
  const resistantCount = hasPredictedPhenotypes ? result.predicted_resistant_count : result.flagged_count;
  const susceptibleCount = hasPredictedPhenotypes ? result.predicted_susceptible_count : null;
  const supportCounts = result.antibiotic_panel.reduce((counts, item) => {
    const status = item.pair_evaluation?.support_status || 'not_assessed';
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
  return <div className="result-panel genome-result">
    <div className="panel-heading"><div><p className="eyebrow">AMR EVIDENCE REPORT · {result.organism}</p><h3>{result.genome_id}</h3></div><span className="confidence">{hasPredictedPhenotypes ? `Signals R ${resistantCount} · Below threshold ${susceptibleCount}` : `${result.flagged_count} / ${result.panel_count} flagged`}</span></div>
    <div className="signal"><strong>{result.score_semantics}</strong><span>{hasPredictedPhenotypes ? 'R means a model resistance signal. Below threshold means no resistance signal was detected; it does not establish susceptibility or show that an antibiotic will work. This model does not predict I. Confirm every result with laboratory testing.' : 'Above-threshold flags identify model resistance signals only. A result not flagged is not evidence of susceptibility.'}</span></div>
    <Evidence title={`Matched precomputed resistance products (${result.detected_products.length})`} items={result.detected_products} />
    <div className="genome-panel-heading"><p className="eyebrow">MODEL RESISTANCE SIGNALS BY ANTIBIOTIC</p><span>Sorted by raw score · threshold {result.decision_threshold.toFixed(2)}</span></div>
    <div className="genome-panel-note">Evidence support: {supportCounts.descriptive_only || 0} descriptive · {supportCounts.insufficient_support || 0} insufficient · {supportCounts.not_assessed || 0} not assessed. Support describes the held-out benchmark, not this genome.</div>
    <div className="genome-panel-note">Pair metrics use held-out BV-BRC labels; they are not external validation or measurements for this genome.</div>
    <div className="genome-panel-list">{result.antibiotic_panel.map(item => <div className={`genome-panel-row${item.predicted_phenotype === 'R' || (!hasPredictedPhenotypes && item.resistance_signal_flagged) ? ' flagged' : ''}`} key={item.antibiotic}><div className="genome-drug"><strong>{item.antibiotic}</strong><span>{hasPredictedPhenotypes ? item.predicted_phenotype === 'R' ? 'Resistance signal detected' : 'No resistance signal detected; susceptibility not established' : item.interpretation}</span><span className={`genome-pair-evaluation ${item.pair_evaluation ? item.pair_evaluation.support_status : 'legacy_unavailable'}`}>{formatPairEvaluation(item.pair_evaluation)}</span></div><div className="genome-score"><b>{item.resistance_score.toFixed(3)}</b><small>raw score</small></div></div>)}</div>
    <Evidence title="Model evaluation" items={[`Genome-held-out test: ${evaluation.test_records?.toLocaleString() ?? 'n/a'} records; AUROC ${evaluation.test_auroc?.toFixed(3) ?? 'n/a'}; AUPRC ${evaluation.test_auprc?.toFixed(3) ?? 'n/a'}.`, `Aggregate Brier ${evaluation.test_brier_score?.toFixed(3) ?? 'n/a'} [95% CI ${formatPairInterval(evaluation.test_confidence_intervals_95?.brier_score)}]; ECE ${evaluation.test_expected_calibration_error?.toFixed(3) ?? 'n/a'} [95% CI ${formatPairInterval(evaluation.test_confidence_intervals_95?.expected_calibration_error)}]. These test-set intervals do not establish calibration.`, 'Pair metrics use a global threshold and an exploratory support floor; the model score remains uncalibrated.', evaluation.subgroup_evaluation?.source_overlap_limitation ?? 'Source/isolate independence and unseen physical-laboratory performance are not established.', formatSourceOverlapAudit(evaluation.source_overlap_audit)]} />
    <Evidence title="Provenance" items={[`Model ${result.model_version}; training dataset ${result.dataset_version}; feature vocabulary ${result.feature_vocabulary_version}.`, `Genome catalog ${result.genome_catalog_version} (${result.genome_catalog_sha256}); source calls ${result.genome_source_snapshot.name} (${result.genome_source_snapshot.sha256}).`]} />
    <Evidence title="Research limitation" items={[result.caveat]} />
    <EvidenceReviewWorkspace result={result} />
  </div>;
}

function EvidenceReviewWorkspace({ result }) {
  const [supportFilter, setSupportFilter] = useState('all');
  const pairs = result.antibiotic_panel.filter(item => supportFilter === 'all' || (item.pair_evaluation?.support_status || 'not_assessed') === supportFilter);
  const qualityChecks = [
    ['Genome is held out from training/validation', result.genome_data_partition === 'held_out_test'],
    ['Organism is unambiguous', Boolean(result.organism)],
    ['Resistance calls are present', result.detected_products.length > 0],
    ['Genome catalog provenance is recorded', Boolean(result.genome_catalog_sha256 && result.genome_source_sha256)],
    ['External validation is available', false],
  ];
  const report = {
    report_type: 'amr_bvbrc_evidence_review',
    genome_id: result.genome_id,
    organism: result.organism,
    generated_at: new Date().toISOString(),
    scope: 'BV-BRC held-out research evidence; not external validation',
    pairs: pairs.map(item => ({
      antibiotic: item.antibiotic,
      predicted_phenotype: item.predicted_phenotype,
      resistance_score: item.resistance_score,
      support_status: item.pair_evaluation?.support_status || 'not_assessed',
      sample_counts: {
        total: item.pair_evaluation?.records ?? 0,
        resistant: item.pair_evaluation?.resistant_records ?? 0,
        susceptible: item.pair_evaluation?.susceptible_records ?? 0,
      },
      metrics: item.pair_evaluation ? {
        auroc: item.pair_evaluation.auroc,
        auprc: item.pair_evaluation.auprc,
        sensitivity: item.pair_evaluation.sensitivity,
        specificity: item.pair_evaluation.specificity,
      } : null,
    })),
    provenance: {
      model_version: result.model_version,
      dataset_version: result.dataset_version,
      genome_catalog_version: result.genome_catalog_version,
      genome_catalog_sha256: result.genome_catalog_sha256,
      genome_source_sha256: result.genome_source_sha256,
    },
    quality_checks: Object.fromEntries(qualityChecks.map(([label, passed]) => [label, passed])),
  };

  function download(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportJson() {
    download(`${result.genome_id}-evidence.json`, JSON.stringify(report, null, 2), 'application/json');
  }

  function exportCsv() {
    const header = ['genome_id', 'organism', 'antibiotic', 'predicted_phenotype', 'resistance_score', 'support_status', 'records', 'resistant_records', 'susceptible_records', 'auroc', 'auprc', 'sensitivity', 'specificity'];
    const rows = pairs.map(item => [result.genome_id, result.organism, item.antibiotic, item.predicted_phenotype, item.resistance_score, item.pair_evaluation?.support_status || 'not_assessed', item.pair_evaluation?.records ?? 0, item.pair_evaluation?.resistant_records ?? 0, item.pair_evaluation?.susceptible_records ?? 0, item.pair_evaluation?.auroc ?? '', item.pair_evaluation?.auprc ?? '', item.pair_evaluation?.sensitivity ?? '', item.pair_evaluation?.specificity ?? '']);
    const csv = [header, ...rows].map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
    download(`${result.genome_id}-evidence.csv`, csv, 'text/csv');
  }

  return <section className="evidence-workspace" aria-label="AMR evidence review workspace">
    <div className="evidence-workspace-heading"><div><p className="eyebrow">AMR EVIDENCE REVIEW WORKSPACE</p><h3>Inspect the support</h3></div><span>BV-BRC evidence only</span></div>
    <div className="evidence-workspace-tools"><label>Support status<select value={supportFilter} onChange={event => setSupportFilter(event.target.value)}><option value="all">All pairs</option><option value="descriptive_only">Descriptive support</option><option value="insufficient_support">Insufficient support</option><option value="not_assessed">Not assessed</option></select></label><div className="export-actions"><button type="button" onClick={exportJson} title="Export JSON evidence report">JSON ↗</button><button type="button" onClick={exportCsv} title="Export CSV evidence report">CSV ↗</button></div></div>
    <div className="evidence-table" role="table" aria-label="Per-antibiotic evidence metrics"><div className="evidence-table-row evidence-table-header" role="row"><span>Antibiotic</span><span>Support</span><span>Held-out samples</span><span>AUROC / AUPRC</span><span>Sens / Spec</span></div>{pairs.map(item => <div className="evidence-table-row" role="row" key={item.antibiotic}><strong>{item.antibiotic}</strong><span>{item.pair_evaluation?.support_status || 'not assessed'}</span><span>{item.pair_evaluation?.records ?? 0} total · R {item.pair_evaluation?.resistant_records ?? 0} · S {item.pair_evaluation?.susceptible_records ?? 0}</span><span>{item.pair_evaluation?.auroc?.toFixed(2) ?? 'n/a'} / {item.pair_evaluation?.auprc?.toFixed(2) ?? 'n/a'}</span><span>{item.pair_evaluation?.sensitivity?.toFixed(2) ?? 'n/a'} / {item.pair_evaluation?.specificity?.toFixed(2) ?? 'n/a'}</span></div>)}</div>
    <div className="evidence-review-columns"><div><p className="eyebrow">DATA-QUALITY CHECKS</p>{qualityChecks.map(([label, passed]) => <p className={`quality-check ${passed ? 'passed' : 'blocked'}`} key={label}><b>{passed ? 'PASS' : 'BLOCKED'}</b>{label}</p>)}</div><div><p className="eyebrow">GENOME PROVENANCE</p><p className="provenance-line">Catalog {result.genome_catalog_version}</p><p className="provenance-line">Catalog SHA-256 {result.genome_catalog_sha256}</p><p className="provenance-line">Source SHA-256 {result.genome_source_sha256}</p><p className="provenance-line">Snapshot {result.genome_source_snapshot.name}</p></div></div>
  </section>;
}

function formatPairEvaluation(evaluation) {
  if (!evaluation) return 'Pair metrics are unavailable in this saved result.';
  if (evaluation.support_status === 'not_assessed') return 'NOT ASSESSED · no held-out labels for this organism/drug pair.';
  const metric = value => value == null ? 'n/a' : value.toFixed(2);
  const support = evaluation.support_status === 'descriptive_only' ? 'DESCRIPTIVE SUPPORT' : 'INSUFFICIENT SUPPORT';
  const intervals = evaluation.confidence_intervals_95 ?? {};
  return `${support} · held-out n=${evaluation.records} (R ${evaluation.resistant_records}, S ${evaluation.susceptible_records}) · AUROC ${metric(evaluation.auroc)} [${formatPairInterval(intervals.auroc)}] · AUPRC ${metric(evaluation.auprc)} [${formatPairInterval(intervals.auprc)}] · sensitivity ${metric(evaluation.sensitivity)} [${formatPairInterval(intervals.sensitivity)}] · specificity ${metric(evaluation.specificity)} [${formatPairInterval(intervals.specificity)}]`;
}

function formatPairInterval(value) {
  return value ? `${value[0].toFixed(2)}-${value[1].toFixed(2)}` : 'n/a';
}

function formatSourceOverlapAudit(audit) {
  if (!audit || !Object.keys(audit).length) return 'Source-overlap audit is unavailable in this saved result.';
  return `Source audit: ${audit.source_record_ids_in_multiple_splits} record IDs and ${audit.source_groups_in_multiple_splits} source groups span splits; ${audit.submitter_groups_in_multiple_splits} submitter groups span splits. These are not verified physical laboratories.`;
}

function Evidence({ title, items }) { return <div className="evidence"><p className="eyebrow">{title}</p>{items.map((item, index) => <div className="evidence-row" key={index}><span>↳</span><p>{item}</p></div>)}</div>; }

export default App;

createRoot(document.getElementById('root')).render(<App />);
