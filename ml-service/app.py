from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title='SignalLab ML service', version='0.1.0')

class AMRRequest(BaseModel):
    organism: str
    antibiotic: str
    genes: str = ''
    metadata: str = ''

@app.get('/health')
def health():
    return {'service': 'signallab-ml', 'status': 'ready', 'model_version': 'baseline'}

@app.post('/amr/predict')
def predict_amr(request: AMRRequest):
    markers = [marker for marker in ('blaKPC', 'gyrA', 'mcr-1', 'ompK36') if marker.lower() in request.genes.lower()]
    return {'prediction': 'Resistant' if markers else 'Uncertain', 'markers': markers, 'confidence': 0.86 if markers else 0.58, 'model_version': 'AMR-BASELINE-01'}
