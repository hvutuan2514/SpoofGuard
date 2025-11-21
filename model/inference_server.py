from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import tensorflow as tf
from keras.preprocessing.sequence import pad_sequences
import numpy as np
import pickle
import json
import re
from pathlib import Path

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE = Path(__file__).resolve().parent
with open(BASE / "tokenizer.pickle", "rb") as f:
    tokenizer = pickle.load(f)
with open(BASE / "meta.json", "r") as f:
    meta = json.load(f)
model = tf.keras.models.load_model(str(BASE / "sefaced_email_model.keras"))

class ClassifyRequest(BaseModel):
    text: str

def clean_text(text: str) -> str:
    t = text.lower()
    t = re.sub(r"http\S+", " ", t)
    t = re.sub(r"www\S+", " ", t)
    t = re.sub(r"\S+@\S+", " ", t)
    t = re.sub(r"\b(re|fwd|fw|forwarded|cc|to|from|subject)\b", " ", t)
    t = re.sub(r"\d+", " ", t)
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"[^a-z\s]", " ", t)
    return t.strip()

def preprocess(text: str):
    cleaned = clean_text(text or "")
    seq = tokenizer.texts_to_sequences([cleaned])
    return pad_sequences(seq, maxlen=meta.get("maxlen", 600), padding="post")

@app.post("/classify")
async def classify(req: ClassifyRequest):
    x = preprocess(req.text)
    probs = model.predict(x, verbose=0)[0]
    labels = meta.get("label_classes", ["Normal", "Fraudulent", "Harassing", "Suspicious"])
    idx = int(np.argmax(probs))
    return {
        "label": labels[idx],
        "probabilities": {labels[i]: float(probs[i]) for i in range(len(labels))}
    }