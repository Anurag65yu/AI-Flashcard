# AI Flashcard Generator

Type a topic or paste notes and get study flashcards. Flask backend calls a Hugging Face instruct model; the frontend is plain HTML/CSS/JS.

## Run it

Backend:

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                  # then put your HF token in .env
python app.py
```

Then open **http://127.0.0.1:5000**. Flask serves the frontend too, so there is only one server to run.
(You can still host `frontend/` separately, for example `python -m http.server 8000`; it will call the backend at `http://127.0.0.1:5000`.)

Never commit `backend/.env` or paste your token into code or the README. It is gitignored for that reason.

Check the backend with `curl http://127.0.0.1:5000/api/health`.

## API

`POST /api/flashcards` with JSON `{ "topic": "...", "text": "...", "num_cards": 5 }` (send `topic` or `text`; `num_cards` is 1-20).
Returns `{ "flashcards": [{ "question", "answer" }], "source": "ai" | "fallback", "warning"? }`.
If the model call fails, simple sentence-based cards are returned with a `warning`.

## Config (`backend/.env`)

| Variable | Default |
| --- | --- |
| `HF_API_KEY` | required |
| `HF_MODEL` | `meta-llama/Llama-3.1-8B-Instruct` |
| `PORT` | `5000` |
| `FLASK_DEBUG` | `0` |
