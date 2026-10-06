import json
import logging
import os
import re

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS

load_dotenv()

HF_API_KEY = os.getenv("HF_API_KEY")
HF_MODEL = os.getenv("HF_MODEL", "meta-llama/Llama-3.1-8B-Instruct")
HF_URL = os.getenv("HF_URL", "https://router.huggingface.co/v1/chat/completions")

DEFAULT_CARDS = 5
MAX_CARDS = 20
MAX_INPUT_CHARS = 6000

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ai-flashcards-backend")

app = Flask(__name__)
CORS(app)

SYSTEM_PROMPT = (
    "You write concise study flashcards. Reply with ONLY a JSON array, no prose and "
    'no code fences. Each item must be an object: {"question": "...", "answer": "..."}. '
    "Questions must be self-contained. Answers must be 1-2 short sentences."
)


def query_llm(user_prompt, timeout=45):
    """Call the Hugging Face chat-completions router. Returns (text, error)."""
    if not HF_API_KEY:
        return None, "Hugging Face API key not configured (set HF_API_KEY in backend/.env)."

    payload = {
        "model": HF_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": 1800,
        "temperature": 0.3,
    }
    headers = {"Authorization": f"Bearer {HF_API_KEY}"}

    try:
        resp = requests.post(HF_URL, headers=headers, json=payload, timeout=timeout)
    except requests.RequestException as e:
        logger.exception("Network error calling Hugging Face")
        return None, f"Network error: {e}"

    if resp.status_code != 200:
        logger.error("Hugging Face returned %s: %s", resp.status_code, resp.text[:500])
        return None, f"Hugging Face error {resp.status_code}: {resp.text[:300]}"

    try:
        return resp.json()["choices"][0]["message"]["content"], None
    except (ValueError, KeyError, IndexError, TypeError):
        logger.error("Unexpected Hugging Face response shape: %s", resp.text[:500])
        return None, "Unexpected response format from Hugging Face."


def _clean_card(item):
    if not isinstance(item, dict):
        return None
    q = item.get("question")
    a = item.get("answer")
    if not isinstance(q, str) or not isinstance(a, str):
        return None
    q, a = q.strip(), a.strip()
    if not q or not a:
        return None
    return {"question": q[:300], "answer": a[:800]}


def parse_flashcards(output, num_cards):
    """Parse model output into cards: JSON array first, then 'Q: ... A: ...' text."""
    if not output:
        return []

    cards = []
    start, end = output.find("["), output.rfind("]")
    if start != -1 and end > start:
        try:
            data = json.loads(output[start : end + 1])
            if isinstance(data, list):
                cards = [c for c in map(_clean_card, data) if c]
        except ValueError:
            pass

    if not cards:
        pattern = re.compile(
            r"Q(?:uestion)?\s*\d*\s*[:.)-]\s*(.+?)\s*A(?:nswer)?\s*[:.)-]\s*(.+?)"
            r"(?=\n\s*Q(?:uestion)?\s*\d*\s*[:.)-]|\Z)",
            re.S | re.I,
        )
        for q, a in pattern.findall(output):
            card = _clean_card({"question": " ".join(q.split()), "answer": " ".join(a.split())})
            if card:
                cards.append(card)

    return cards[:num_cards]


def fallback_flashcards(text, num_cards):
    """Sentence-based cards used when the model is unavailable. May return fewer than requested."""
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    cards = []
    for s in sentences:
        s = s.strip()
        words = s.split()
        if len(s) <= 20 or len(words) < 4:
            continue
        lead = " ".join(words[:6]) + ("..." if len(words) > 6 else "")
        cards.append({"question": f"Complete the idea: {lead}", "answer": s[:800]})
        if len(cards) >= num_cards:
            break
    return cards


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "huggingface": bool(HF_API_KEY), "model": HF_MODEL})


@app.route("/api/flashcards", methods=["POST"])
def api_flashcards():
    data = request.get_json(silent=True) or {}
    topic = str(data.get("topic") or "").strip()
    text = str(data.get("text") or "").strip()

    try:
        num_cards = int(data.get("num_cards", DEFAULT_CARDS))
    except (TypeError, ValueError):
        num_cards = DEFAULT_CARDS
    num_cards = max(1, min(num_cards, MAX_CARDS))

    if not topic and not text:
        return jsonify({"error": "No input provided; supply 'topic' or 'text'."}), 400

    if text:
        source = text[:MAX_INPUT_CHARS]
        prompt = f"Create {num_cards} flashcards from these notes:\n\n{source}"
    else:
        source = topic[:MAX_INPUT_CHARS]
        prompt = f"Create {num_cards} flashcards that teach the key facts about: {source}"

    output, error = query_llm(prompt)
    if not error:
        cards = parse_flashcards(output, num_cards)
        if cards:
            return jsonify({"flashcards": cards, "source": "ai"}), 200
        error = "The model returned no usable flashcards."

    logger.warning("Generation failed (%s); using fallback.", error)
    cards = fallback_flashcards(source, num_cards)
    if not cards:
        return jsonify({"error": error}), 502
    return jsonify({"flashcards": cards, "source": "fallback", "warning": error}), 200


if __name__ == "__main__":
    debug = os.getenv("FLASK_DEBUG", "0") == "1"
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "5000"))
    logger.info("Starting AI Flashcards backend on %s:%s (model=%s, key set=%s)", host, port, HF_MODEL, bool(HF_API_KEY))
    app.run(host=host, port=port, debug=debug)
