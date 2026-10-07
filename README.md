# AI Flashcards

Type a topic, paste notes, or upload a PDF or photo and get study flashcards. A Flask backend calls a Hugging Face instruct model; the frontend is plain HTML/CSS/JS with a light, grid-paper look (bracket labels, pill inputs, pastel blue and orange accents).

## Features

- **Photo / PDF upload**: drop a PDF or a PNG/JPG/WebP/BMP photo and the text is read in your browser, put into the editable box, then turned into cards. Text PDFs are read directly (first 30 pages). Scanned PDFs and photos use OCR (first 5 pages, English only). Max 15 MB, text is trimmed to 6000 characters. The file itself is never sent to the server; only the extracted text is, like any pasted notes.
- **Options**: difficulty (easy / medium / hard), card style (Q&A, fill in the blank, definition, mixed), output language (English, Hindi, Spanish, French, German, Portuguese, Japanese) and 3-20 cards.
- **Hints**: every card can carry a short hint, blurred until you hover or focus it.
- **Grid or Study view**: study mode tracks "Got it" / "Still learning", then offers "Review missed" or "Study again".
- **Keyboard**: Ctrl+Enter generates; in study mode Space flips, arrow keys move, `1` / `2` grade the card.
- **Saved decks**: stored in your browser (localStorage), up to 50.
- **Export**: CSV (opens in Excel / Anki import), JSON, or copy to clipboard. Shuffle and flip-all are included.
- **Example topics** as one-click chips and a live model/status badge.

## Run it

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                  # then put your HF token in .env
python app.py
```

Then open **http://127.0.0.1:5000**. Flask serves the frontend too, so there is only one server to run.

Never commit `backend/.env` or paste your token into code or the README. It is gitignored for that reason. If a token was ever shared publicly, revoke it at huggingface.co/settings/tokens and create a new one.

Check the backend with `curl http://127.0.0.1:5000/api/health`.

## API

`POST /api/flashcards` with JSON:

```json
{ "topic": "...", "text": "...", "num_cards": 8, "difficulty": "medium", "style": "qa", "language": "English" }
```

- Send `topic` or `text` (notes). `num_cards` is 1-20.
- `difficulty`: `easy` | `medium` | `hard`. `style`: `qa` | `cloze` | `definition` | `mixed`. `language`: one of the languages above. Invalid values return 400.
- Returns `{ "flashcards": [{ "question", "answer", "hint" }], "source": "ai" | "fallback", "warning"? }`.
- If the model call fails, simple sentence-based cards are returned with a `warning`.
- Over the rate limit returns 429 with a `Retry-After` header; a busy server returns 503.

## Put it online (public use)

The app is one Flask service that also serves the frontend, so any host that runs Python works. The repo includes a `render.yaml` and a `Procfile`.

**Render (free tier):**
1. Revoke any Hugging Face token that was ever pasted into chat or code, then create a **new fine-grained token** that can only make Inference Provider calls.
2. On render.com choose **New > Blueprint**, connect this repo and apply `render.yaml`.
3. When asked, paste the token as `HF_API_KEY`. It is stored in Render, never in git.
4. Open the `https://...onrender.com` URL you get. The free tier sleeps when idle, so the first visit after a pause takes about 30 seconds.

Railway, Fly.io and similar hosts work the same way: install `backend/requirements.txt`, run the `Procfile` command, set `HF_API_KEY` and `PROXY_HOPS=1`.

**Built in for strangers using it:**
- Per-visitor limits (5 per minute, 30 per hour) and a daily cap for everyone together (300 on Render), so nobody can drain your Hugging Face quota. Tune with `RATE_PER_MIN`, `RATE_PER_HOUR`, `DAILY_LIMIT`.
- At most 4 model calls at once (`MAX_CONCURRENT`); extra requests get a friendly "busy" message.
- Upstream error details stay in the server logs; visitors only see generic messages. Pasted text is not logged.
- Same-origin API (no open CORS), request size cap, a strict Content-Security-Policy and other security headers, HTTPS-only HSTS.
- A privacy note in the footer: text goes to Hugging Face, files stay in the browser, nothing is stored server side.

The counters live in memory, so keep a single worker process (as configured) and expect them to reset when the service restarts. Also set a monthly spending limit on your Hugging Face account as a second safety net.

## Config (`backend/.env`)

| Variable | Default |
| --- | --- |
| `HF_API_KEY` | required |
| `HF_MODEL` | `meta-llama/Llama-3.1-8B-Instruct` |
| `PORT` | `5000` |
| `FLASK_DEBUG` | `0` (never `1` on a public server) |
| `RATE_PER_MIN` / `RATE_PER_HOUR` | `5` / `30` per visitor |
| `DAILY_LIMIT` | `500` for everyone together, `0` = off |
| `MAX_CONCURRENT` | `4` |
| `PROXY_HOPS` | `0` locally, `1` behind Render/Railway/Fly |
| `CORS_ORIGINS` | empty (same-origin) |
| `LOG_MODEL_OUTPUT` | `0`; set `1` only to debug unusable model output |

## Upload notes

The readers (pdf.js and Tesseract.js) are loaded on demand from jsDelivr with pinned versions and SRI hashes, so you need internet access the first time you upload. OCR also downloads its English language data and a WebAssembly core from a CDN; those are fetched by the library and cannot be SRI-pinned. To avoid third-party CDNs entirely, self-host the files and change `LIBS` in `frontend/script.js`.

Render Live site - https://ai-flashcards-j936.onrender.com/
