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

## Config (`backend/.env`)

| Variable | Default |
| --- | --- |
| `HF_API_KEY` | required |
| `HF_MODEL` | `meta-llama/Llama-3.1-8B-Instruct` |
| `PORT` | `5000` |
| `FLASK_DEBUG` | `0` |

## Upload notes

The readers (pdf.js and Tesseract.js) are loaded on demand from jsDelivr with pinned versions and SRI hashes, so you need internet access the first time you upload. OCR also downloads its English language data and a WebAssembly core from a CDN; those are fetched by the library and cannot be SRI-pinned. To avoid third-party CDNs entirely, self-host the files and change `LIBS` in `frontend/script.js`.
