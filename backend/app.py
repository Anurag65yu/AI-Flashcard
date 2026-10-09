import json
import logging
import os
import re
import threading
import time
from collections import deque
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from werkzeug.middleware.proxy_fix import ProxyFix

load_dotenv()


def _clean(raw):
    """Tolerate values pasted with spaces, newlines or surrounding quotes."""
    return (raw or "").strip().strip("\"'").strip()


def _clean_key(raw):
    """Same as _clean, plus a stray 'Bearer ' prefix."""
    key = _clean(raw)
    if key.lower().startswith("bearer "):
        key = key[7:].strip()
    return key


HF_API_KEY = _clean_key(os.getenv("HF_API_KEY"))
HF_MODEL = _clean(os.getenv("HF_MODEL")) or "meta-llama/Llama-3.1-8B-Instruct"
HF_URL = _clean(os.getenv("HF_URL")) or "https://router.huggingface.co/v1/chat/completions"
PROVIDER_HOST = urlparse(HF_URL).netloc


def _env_int(name, default):
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


# Public-use limits. Counters live in memory, so run a single worker process (see Procfile / render.yaml).
RATE_PER_MIN = _env_int("RATE_PER_MIN", 5)        # per visitor IP
RATE_PER_HOUR = _env_int("RATE_PER_HOUR", 30)     # per visitor IP
DAILY_LIMIT = _env_int("DAILY_LIMIT", 500)        # all visitors together; protects your HF quota (0 = off)
MAX_CONCURRENT = _env_int("MAX_CONCURRENT", 4)    # simultaneous model calls
PROXY_HOPS = _env_int("PROXY_HOPS", 0)            # number of trusted reverse proxies in front (Render/Railway: 1)
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
LOG_MODEL_OUTPUT = os.getenv("LOG_MODEL_OUTPUT", "0") == "1"  # off by default: output can contain user text

DEFAULT_CARDS = 5
MAX_CARDS = 20
MAX_INPUT_CHARS = 6000

DIFFICULTIES = {
    "easy": "Beginner level: core facts and definitions only.",
    "medium": "Intermediate level: focus on understanding and how ideas relate.",
    "hard": "Advanced level: nuance, application and edge cases.",
}
STYLES = {
    "qa": "Standard question with a short answer.",
    "cloze": (
        "Fill-in-the-blank: each question is one sentence with ____ where a key term is missing; "
        "the answer is the missing term plus a few words of clarification."
    ),
    "definition": "Each question names a term or concept; the answer defines it clearly.",
    "mixed": "A varied mix of question-and-answer, fill-in-the-blank (use ____) and definition cards.",
}
LANGUAGES = ["English", "Hindi", "Spanish", "French", "German", "Portuguese", "Japanese"]

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ai-flashcards-backend")

if HF_API_KEY and not HF_API_KEY.startswith(("hf_", "gsk_")):
    logger.warning("API key has an unexpected prefix (length %s); check the value in your host's env vars.", len(HF_API_KEY))
if not HF_URL.startswith("https://") or not HF_URL.rstrip("/").endswith("/chat/completions"):
    logger.warning("HF_URL does not look like a chat-completions endpoint: %s", HF_URL)
logger.info("AI provider host=%s model=%s", PROVIDER_HOST, HF_MODEL)

FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))

# Serving the frontend from Flask means one command runs the whole app.
app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024  # a 6000-char request is far below this
if PROXY_HOPS:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=PROXY_HOPS, x_proto=PROXY_HOPS, x_host=PROXY_HOPS)
if CORS_ORIGINS:  # same-origin by default; only open the API to origins you list
    CORS(app, resources={r"/api/*": {"origins": CORS_ORIGINS}})


class RateLimiter:
    """Sliding-window limits per client key plus one global daily cap."""

    def __init__(self, per_minute, per_hour, per_day, max_keys=10000):
        self.per_minute, self.per_hour, self.per_day, self.max_keys = per_minute, per_hour, per_day, max_keys
        self.hits = {}
        self.day = None
        self.day_count = 0
        self.lock = threading.Lock()

    def check(self, key, now=None):
        """Return (allowed, retry_after_seconds, reason). Allowed calls are counted."""
        now = time.time() if now is None else now
        with self.lock:
            today = int(now // 86400)
            if today != self.day:
                self.day, self.day_count = today, 0
            if self.per_day and self.day_count >= self.per_day:
                return False, 86400 - int(now % 86400), "daily"

            q = self.hits.get(key)
            if q is not None:
                while q and now - q[0] >= 3600:
                    q.popleft()
                if self.per_hour and len(q) >= self.per_hour:
                    return False, int(3600 - (now - q[0])) + 1, "hour"
                recent = [t for t in q if now - t < 60]
                if self.per_minute and len(recent) >= self.per_minute:
                    return False, int(60 - (now - recent[0])) + 1, "minute"
            else:
                q = self.hits[key] = deque()

            q.append(now)
            self.day_count += 1
            if len(self.hits) > self.max_keys:
                self._purge(now)
            return True, 0, ""

    def _purge(self, now):
        for k in [k for k, q in self.hits.items() if not q or now - q[-1] >= 3600]:
            del self.hits[k]
        if len(self.hits) > self.max_keys:  # still too many (many distinct IPs): drop the least recent half
            oldest = sorted(self.hits, key=lambda k: self.hits[k][-1])
            for k in oldest[: len(oldest) // 2]:
                del self.hits[k]


limiter = RateLimiter(RATE_PER_MIN, RATE_PER_HOUR, DAILY_LIMIT)
llm_slots = threading.BoundedSemaphore(max(1, MAX_CONCURRENT))

CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' data: https://cdn.jsdelivr.net https://tessdata.projectnaptha.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])


@app.after_request
def security_headers(resp):
    resp.headers.setdefault("Content-Security-Policy", CSP)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    if request.is_secure:
        resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000")
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.errorhandler(413)
def too_large(_):
    return jsonify({"error": "That request is too large."}), 413


@app.errorhandler(404)
def not_found(_):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Not found."}), 404
    return "Not found", 404


@app.errorhandler(405)
def bad_method(_):
    return jsonify({"error": "Method not allowed."}), 405


@app.errorhandler(500)
def server_error(_):
    return jsonify({"error": "Something went wrong on the server."}), 500

SYSTEM_PROMPT = (
    "You write concise study flashcards. Reply with ONLY a JSON array, no prose and "
    'no code fences. Each item must be an object: {"question": "...", "answer": "...", "hint": "..."}. '
    "Questions must be self-contained. Answers must be 1-2 short sentences. "
    "The hint is a short nudge of at most 8 words that does not reveal the answer."
)


def upstream_message(status):
    """Short, secret-free explanation shown to visitors for a failed model call."""
    if status == 402:
        return "The AI credits for this site are used up. The site owner needs to top them up."
    if status in (401, 403):
        return "The AI service rejected this site's access key. The site owner needs to update it."
    if status in (400, 404):
        return "The configured AI model is not available. The site owner needs to pick another model."
    if status == 429:
        return "The AI service is busy right now. Please try again in a minute."
    return "The AI service is unavailable right now."


def query_llm(user_prompt, timeout=60):
    """Call the OpenAI-compatible chat-completions endpoint. Returns (text, error)."""
    if not HF_API_KEY:
        logger.error("HF_API_KEY is not set")
        return None, "The AI service is not configured on this server."

    payload = {
        "model": HF_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": 3000,
        "temperature": 0.3,
    }
    headers = {"Authorization": f"Bearer {HF_API_KEY}"}

    try:
        resp = requests.post(HF_URL, headers=headers, json=payload, timeout=timeout)
    except requests.RequestException as e:
        logger.exception("Network error calling the AI provider")
        return None, "The AI service could not be reached."

    if resp.status_code != 200:
        logger.error("AI provider %s (model %s) returned %s: %s", PROVIDER_HOST, HF_MODEL, resp.status_code, resp.text[:500])
        return None, upstream_message(resp.status_code)

    try:
        return resp.json()["choices"][0]["message"]["content"], None
    except (ValueError, KeyError, IndexError, TypeError):
        logger.error("Unexpected AI provider response shape: %s", resp.text[:500])
        return None, "The AI service returned an unexpected response."


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
    hint = item.get("hint")
    hint = hint.strip()[:160] if isinstance(hint, str) else ""
    return {"question": q[:300], "answer": a[:800], "hint": hint}


def build_prompt(num_cards, source, is_notes, difficulty, style, language):
    intro = (
        f"Create {num_cards} flashcards from these notes:\n\n{source}"
        if is_notes
        else f"Create {num_cards} flashcards that teach the key facts about: {source}"
    )
    return (
        f"{intro}\n\n"
        f"Difficulty: {DIFFICULTIES[difficulty]}\n"
        f"Card style: {STYLES[style]}\n"
        f"Write every question, answer and hint in {language}."
    )


def _extract_objects(output):
    """Pull individual {...} card objects out of messy or truncated model output."""
    decoder = json.JSONDecoder()
    cards, i = [], 0
    while True:
        i = output.find("{", i)
        if i == -1:
            return cards
        try:
            obj, end = decoder.raw_decode(output, i)
        except ValueError:
            i += 1
            continue
        items = [obj]
        if isinstance(obj, dict):
            for key in ("flashcards", "cards"):
                if isinstance(obj.get(key), list):
                    items = obj[key]
        cards.extend(c for c in map(_clean_card, items) if c)
        i = end


def parse_flashcards(output, num_cards):
    """Parse model output into cards: JSON array, then loose JSON objects, then 'Q: ... A: ...' text."""
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
        cards = _extract_objects(output)

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
        cards.append({"question": f"Complete the idea: {lead}", "answer": s[:800], "hint": ""})
        if len(cards) >= num_cards:
            break
    return cards


@app.route("/", methods=["GET"])
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "huggingface": bool(HF_API_KEY), "model": HF_MODEL, "provider": PROVIDER_HOST})


@app.route("/api/flashcards", methods=["POST"])
def api_flashcards():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Send a JSON object."}), 400
    topic = str(data.get("topic") or "").strip()
    text = str(data.get("text") or "").strip()

    try:
        num_cards = int(data.get("num_cards", DEFAULT_CARDS))
    except (TypeError, ValueError):
        num_cards = DEFAULT_CARDS
    num_cards = max(1, min(num_cards, MAX_CARDS))

    if not topic and not text:
        return jsonify({"error": "No input provided; supply 'topic' or 'text'."}), 400

    difficulty = str(data.get("difficulty") or "medium").lower()
    style = str(data.get("style") or "qa").lower()
    language = str(data.get("language") or "English")
    if difficulty not in DIFFICULTIES:
        return jsonify({"error": f"difficulty must be one of: {', '.join(DIFFICULTIES)}."}), 400
    if style not in STYLES:
        return jsonify({"error": f"style must be one of: {', '.join(STYLES)}."}), 400
    if language not in LANGUAGES:
        return jsonify({"error": f"language must be one of: {', '.join(LANGUAGES)}."}), 400

    allowed, retry_after, reason = limiter.check(request.remote_addr or "unknown")
    if not allowed:
        logger.warning("Rate limited (%s) for %s", reason, request.remote_addr)
        message = (
            "The free daily limit for everyone has been reached. Please try again tomorrow."
            if reason == "daily"
            else f"You are going a bit fast. Please try again in {retry_after} seconds."
        )
        resp = jsonify({"error": message, "retry_after": retry_after})
        resp.status_code = 429
        resp.headers["Retry-After"] = str(retry_after)
        return resp

    source = (text or topic)[:MAX_INPUT_CHARS]
    prompt = build_prompt(num_cards, source, bool(text), difficulty, style, language)

    if not llm_slots.acquire(blocking=False):
        return jsonify({"error": "The server is busy. Please try again in a few seconds."}), 503
    error = None
    try:
        for attempt in (1, 2):
            output, error = query_llm(prompt)
            if error:
                break
            cards = parse_flashcards(output, num_cards)
            if cards:
                return jsonify({"flashcards": cards, "source": "ai"}), 200
            shown = repr((output or "")[:300]) if LOG_MODEL_OUTPUT else f"{len(output or '')} chars"
            logger.warning("Attempt %s: unusable model output: %s", attempt, shown)
            error = "The model returned no usable flashcards."
    finally:
        llm_slots.release()

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
    if debug:
        logger.warning("FLASK_DEBUG=1: never use debug mode on a public server.")
    app.run(host=host, port=port, debug=debug)
