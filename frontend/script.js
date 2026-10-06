// Same-origin when served by Flask (http://127.0.0.1:5000); otherwise assume the backend runs locally.
const servedByBackend = location.protocol.startsWith("http") && location.port === "5000";
const API_URL = window.API_URL || (servedByBackend ? "" : "http://127.0.0.1:5000");

// Input longer than this, or spanning several lines, is treated as pasted notes rather than a topic.
const NOTES_MIN_CHARS = 120;

const form = document.getElementById("form");
const input = document.getElementById("input");
const count = document.getElementById("count");
const submit = document.getElementById("submit");
const statusEl = document.getElementById("status");
const cardsEl = document.getElementById("flashcards");

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? "error" : "";
}

function buildCard(card) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "card";
  el.setAttribute("aria-pressed", "false");

  const inner = document.createElement("span");
  inner.className = "inner";

  const front = document.createElement("span");
  front.className = "face front";
  const frontLabel = document.createElement("strong");
  frontLabel.textContent = "Question";
  const frontText = document.createElement("span");
  frontText.textContent = card.question;
  front.append(frontLabel, frontText);

  const back = document.createElement("span");
  back.className = "face back";
  const backLabel = document.createElement("strong");
  backLabel.textContent = "Answer";
  const backText = document.createElement("span");
  backText.textContent = card.answer;
  back.append(backLabel, backText);

  inner.append(front, back);
  el.append(inner);

  el.addEventListener("click", () => {
    const flipped = el.classList.toggle("flipped");
    el.setAttribute("aria-pressed", String(flipped));
  });
  return el;
}

function buildPayload(raw, numCards) {
  const isNotes = raw.length > NOTES_MIN_CHARS || raw.includes("\n");
  return isNotes ? { text: raw, num_cards: numCards } : { topic: raw, num_cards: numCards };
}

async function generateFlashcards(event) {
  event.preventDefault();
  const raw = input.value.trim();
  if (!raw) {
    setStatus("Please enter a topic or some text.", true);
    return;
  }
  const numCards = Math.max(1, Math.min(parseInt(count.value, 10) || 5, 20));

  submit.disabled = true;
  submit.textContent = "Generating...";
  setStatus("Generating flashcards...");
  cardsEl.replaceChildren();

  try {
    const response = await fetch(`${API_URL}/api/flashcards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(raw, numCards)),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      setStatus(data.error || `Server error (${response.status}).`, true);
      return;
    }

    if (!Array.isArray(data.flashcards) || data.flashcards.length === 0) {
      setStatus("No flashcards generated.", true);
      return;
    }

    cardsEl.replaceChildren(...data.flashcards.map(buildCard));
    setStatus(
      data.warning
        ? `Showing basic cards built from your text (AI unavailable: ${data.warning})`
        : `${data.flashcards.length} flashcards ready.`,
      Boolean(data.warning)
    );
  } catch (error) {
    console.error("Error generating flashcards:", error);
    setStatus(`Could not reach the backend at ${API_URL || location.origin}. Is it running?`, true);
  } finally {
    submit.disabled = false;
    submit.textContent = "Generate Flashcards";
  }
}

form.addEventListener("submit", generateFlashcards);
