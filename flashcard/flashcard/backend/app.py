# app.py
import os
import json
import logging
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv
import requests

# --- Setup / config --------------------------------------------------------
load_dotenv()
HF_API_KEY = os.getenv("HF_API_KEY")  # must be set in backend/.env

HF_MODEL = os.getenv("HF_MODEL", "google/flan-t5-base")
HF_URL = f"https://api-inference.huggingface.co/models/{HF_MODEL}"
HEADERS = {"Authorization": f"Bearer {HF_API_KEY}"} if HF_API_KEY else {}

# Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ai-flashcards-backend")

# Flask app
app = Flask(__name__)
CORS(app)


# --- Helper functions -----------------------------------------------------
def query_huggingface(prompt, timeout=30):
    """
    Send prompt to HF Inference API and return text result or (None, error_message).
    """
    if not HF_API_KEY:
        return None, "Hugging Face API key not configured."

    payload = {"inputs": prompt}

    try:
        resp = requests.post(HF_URL, headers=HEADERS, json=payload, timeout=timeout)
    except requests.RequestException as e:
        logger.exception("Network error calling Hugging Face")
        return None, f"Network error: {str(e)}"

    if resp.status_code != 200:
        logger.error("Hugging Face returned status %s: %s", resp.status_code, resp.text)
        return None, f"Hugging Face error {resp.status_code}: {resp.text}"

    try:
        result = resp.json()
    except ValueError:
        # if response is plain text
        return resp.text, None

    # Different HF models / endpoints return different JSON shapes.
    # Common: [{"generated_text": "..."}, ...]  or just a plain string in a list.
    if isinstance(result, list):
        first = result[0]
        if isinstance(first, dict) and "generated_text" in first:
            return first["generated_text"], None
        if isinstance(first, str):
            return first, None
        # sometimes the list contains nested structure - stringify as fallback
        return json.dumps(result), None

    if isinstance(result, dict):
        # sometimes API returns {"error": "..."} on model error
        if "error" in result:
            return None, f"Hugging Face model error: {result['error']}"
        # other dict -> stringify
        return json.dumps(result), None

    # fallback to string
    return str(result), None


def fallback_flashcards(text, n=5):
    """
    Simple heuristic fallback if API is unavailable: split into sentences
    and create Q/A items.
    """
    import re

    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    usable = [s.strip() for s in sentences if len(s.strip()) > 20]
    cards = []
    for i, s in enumerate(usable[:n]):
        q = f"Explain: {' '.join(s.split()[:6])}{'...' if len(s.split())>6 else ''}"
        a = s
        cards.append({"question": q, "answer": a})
    while len(cards) < n:
        idx = len(cards) + 1
        cards.append({"question": f"Flashcard {idx}", "answer": "More input required to create a useful card."})
    return cards


def parse_flashcards_from_text(model_output, num_cards=5):
    """
    Tries to parse model output into a list of {"question":.., "answer":..}.
    Accepts outputs where QA appears as lines with '?', or lines of 'Q: ... A: ...'
    """
    cards = []
    if not model_output:
        return cards

    # Split into lines and try to extract question/answer patterns
    lines = [ln.strip() for ln in model_output.splitlines() if ln.strip()]
    for ln in lines:
        # Format: "Q: ...? A: ..." or "Question: ...? Answer: ..."
        if ("Q:" in ln and "A:" in ln) or ("Question" in ln and "Answer" in ln):
            # try splitting
            parts = ln.replace("Question:", "Q:").replace("Answer:", "A:").split("A:")
            qpart = parts[0].replace("Q:", "").strip()
            apart = parts[1].strip() if len(parts) > 1 else ""
            if qpart and apart:
                cards.append({"question": qpart, "answer": apart})
                continue

        # If line contains a question mark, split at first '?'
        if "?" in ln:
            q, _, a = ln.partition("?")
            q = q.strip() + "?"
            a = a.strip()
            # If answer on same line after ? use it; otherwise try next line
            if a:
                cards.append({"question": q, "answer": a})
            else:
                # try next line as answer
                next_idx = lines.index(ln) + 1
                if next_idx < len(lines):
                    cards.append({"question": q, "answer": lines[next_idx]})
                else:
                    cards.append({"question": q, "answer": ""})
            continue

    # If parsing produced nothing, attempt to split the output into sentence pairs
    if not cards:
        import re

        sentences = re.split(r"(?<=[.!?])\s+", model_output)
        for i in range(0, min(len(sentences), num_cards * 2), 2):
            q = sentences[i].strip() if i < len(sentences) else ""
            a = sentences[i + 1].strip() if i + 1 < len(sentences) else ""
            if q and a:
                cards.append({"question": q[:200], "answer": a[:600]})

    # Cap number of cards
    return cards[:num_cards]


# --- Routes ---------------------------------------------------------------
@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "huggingface": bool(HF_API_KEY)})


@app.route("/api/flashcards", methods=["POST"])
def api_flashcards():
    """
    Request JSON:
    {
      "topic": "optional short topic string",
      "text": "optional longer text (notes).",
      "num_cards": 5   # optional
    }
    """
    data = request.get_json(silent=True) or {}
    topic = (data.get("topic") or "").strip()
    text = (data.get("text") or "").strip()
    try:
        num_cards = int(data.get("num_cards", 5))
    except Exception:
        num_cards = 5
    if not topic and not text:
        return jsonify({"error": "No input provided; supply 'topic' or 'text'."}), 400

    prompt_source = topic if topic else (text[:2000] if text else topic)
    # Build a clear prompt that asks for concise Q/A pairs separated by newlines.
    prompt = (
        f"Generate {num_cards} concise study flashcards in Q/A format for quick revision about the following:\n\n"
        f"{prompt_source}\n\n"
        "Output them as short lines. Prefer formats like:\n"
        "Q: <question>? A: <short answer>\n"
        "or\n"
        "<question>? <answer>\n\n"
        "Keep each Q/A pair on its own line and keep answers to 1-2 short sentences."
    )

    # Call Hugging Face
    model_output, error = query_huggingface(prompt)
    if error:
        logger.warning("Hugging Face call failed: %s. Using fallback generator.", error)
        # Use fallback (based on text or topic)
        source_text = text if text else topic
        cards = fallback_flashcards(source_text, n=num_cards)
        return jsonify({"flashcards": cards, "warning": f"Hugging Face error: {error}"}), 200

    # Parse flashcards from model output
    cards = parse_flashcards_from_text(model_output, num_cards=num_cards)
    if not cards:
        # if parsing failed, fallback
        source_text = text if text else topic
        cards = fallback_flashcards(source_text, n=num_cards)
        return jsonify({"flashcards": cards, "warning": "Parsed model output was empty; returned fallback cards."}), 200

    return jsonify({"flashcards": cards}), 200


# --- Start server ---------------------------------------------------------
if __name__ == "__main__":
    # Helpful start message
    logger.info("Starting AI Flashcards backend. Hugging Face configured: %s", bool(HF_API_KEY))
    app.run(host="0.0.0.0", port=5000, debug=True)
