import { useState } from 'react';
import './styles.css';

const API = 'http://localhost:8787/api';

const initialAmr = { organism: 'Klebsiella pneumoniae', antibiotic: 'Meropenem', genes: 'blaKPC, ompK36 mutation', metadata: 'Hospital A / 2025' };
const initialRare = { age: '8', phenotypes: 'developmental delay, congenital heart defect, hearing loss, persistent fetal fingertip pads' };

function App() {
  const [module, setModule] = useState('amr');
  const [amr, setAmr] = useState(initialAmr);
  const [rare, setRare] = useState(initialRare);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');

  async function analyze(event) {
    event.preventDefault();
    setLoading(true); setNotice(''); setResult(null);
    const endpoint = module === 'amr' ? '/amr/predict' : '/rare-disease/rank';
    const body = module === 'amr' ? amr : rare;
    try {
      const response = await fetch(API + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error('API unavailable');
      setResult(await response.json());
    } catch {
      setNotice('API is offline. Start `npm run api` to enable live analysis.');
    } finally { setLoading(false); }
  }

  return <div className="app-shell">
    <header className="topbar"><div className="brand-mark">SL</div><div><p className="eyebrow">RESEARCH INTELLIGENCE / 01</p><h1>SignalLab</h1></div><div className="top-status"><span className="pulse" /> Local research workspace</div></header>
    <main className="content">
      <section className="intro"><div><p className="eyebrow">DECISION SUPPORT PROTOTYPE</p><h2>Make uncertainty<br /><em>visible.</em></h2></div><p className="intro-copy">Two evidence-led workflows for exploring genotype-to-phenotype resistance and rare-disease differentials. Built for research review, never as a replacement for laboratory or clinical judgment.</p></section>
      <nav className="module-tabs" aria-label="Research modules"><button className={module === 'amr' ? 'active' : ''} onClick={() => { setModule('amr'); setResult(null); }}><span>01</span> Antibiotic resistance</button><button className={module === 'rare' ? 'active' : ''} onClick={() => { setModule('rare'); setResult(null); }}><span>02</span> Rare disease</button></nav>
      <section className="workspace">
        <form className="input-panel" onSubmit={analyze}><div className="panel-heading"><div><p className="eyebrow">{module === 'amr' ? 'GENOTYPE → PHENOTYPE' : 'PHENOTYPES → DIFFERENTIAL'}</p><h3>{module === 'amr' ? 'Resistance signal' : 'Phenotype profile'}</h3></div><span className="step">INPUT</span></div>
          {module === 'amr' ? <><label>Organism<input value={amr.organism} onChange={e => setAmr({ ...amr, organism: e.target.value })} /></label><label>Antibiotic<select value={amr.antibiotic} onChange={e => setAmr({ ...amr, antibiotic: e.target.value })}><option>Meropenem</option><option>Ciprofloxacin</option><option>Colistin</option><option>Gentamicin</option><option>Ceftriaxone</option></select></label><label>Resistance genes / mutations<textarea value={amr.genes} onChange={e => setAmr({ ...amr, genes: e.target.value })} /></label><label>Collection context<input value={amr.metadata} onChange={e => setAmr({ ...amr, metadata: e.target.value })} /></label></> : <><label>Patient age<input value={rare.age} onChange={e => setRare({ ...rare, age: e.target.value })} /></label><label>Observed phenotypes<textarea className="tall" value={rare.phenotypes} onChange={e => setRare({ ...rare, phenotypes: e.target.value })} /></label><p className="helper">Use plain language or HPO-style terms. The research service normalizes terms and reports missing expected findings.</p></>}
          <button className="primary" disabled={loading}>{loading ? 'Analyzing…' : 'Run analysis'} <span>↗</span></button>{notice && <p className="notice">{notice}</p>}
        </form>
        <ResultPanel result={result} type={module} />
      </section>
      <footer><span>SignalLab / v0.1 research build</span><span>Evidence is provisional · confirm with qualified experts</span></footer>
    </main>
  </div>;
}

function ResultPanel({ result, type }) {
  if (!result) return <div className="result-panel empty"><div className="empty-glyph">＋</div><p>Analysis output will appear here</p><span>Evidence, confidence, and review notes stay together.</span></div>;
  return <div className="result-panel"><div className="panel-heading"><div><p className="eyebrow">{type === 'amr' ? 'MODEL OUTPUT / AMR-BASELINE-01' : 'RANKED DIFFERENTIAL / PHENO-BASELINE-01'}</p><h3>{type === 'amr' ? result.prediction : 'Candidate diseases'}</h3></div><span className="confidence">{type === 'amr' ? `${Math.round(result.confidence * 100)}%` : `${result.candidates.length} ranked`}</span></div>{type === 'amr' ? <><div className={`signal ${result.prediction.toLowerCase()}`}><strong>{result.prediction}</strong><span>{result.interpretation}</span></div><div className="meter"><span style={{ width: `${result.confidence * 100}%` }} /></div><Evidence title="Evidence signals" items={result.evidence} /><Evidence title="Caveat" items={[result.caveat]} /></> : <>{result.candidates.map((candidate, index) => <article className="candidate" key={candidate.name}><div className="rank">0{index + 1}</div><div className="candidate-main"><div className="candidate-title"><strong>{candidate.name}</strong><span>{Math.round(candidate.score * 100)}%</span></div><div className="mini-meter"><span style={{ width: `${candidate.score * 100}%` }} /></div><p><b>Supports:</b> {candidate.supporting.join(' · ')}</p><p className="muted"><b>Missing:</b> {candidate.missing.join(' · ') || 'No flagged findings'}</p></div></article>)}<Evidence title="Method note" items={[result.method]} /></>}</div>;
}

function Evidence({ title, items }) { return <div className="evidence"><p className="eyebrow">{title}</p>{items.map((item, index) => <div className="evidence-row" key={index}><span>↳</span><p>{item}</p></div>)}</div>; }

export default App;
