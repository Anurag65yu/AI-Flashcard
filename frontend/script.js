// Same-origin when served by Flask (http://127.0.0.1:5000); otherwise assume the backend runs locally.
const servedByBackend = location.protocol.startsWith("http") && location.port === "5000";
const API_URL = window.API_URL || (servedByBackend ? "" : "http://127.0.0.1:5000");

// Input longer than this, or spanning several lines, is treated as pasted notes rather than a topic.
const NOTES_MIN_CHARS = 120;
const STORE_KEY = "ai-flashcards:decks";
const MAX_SAVED_DECKS = 50;
const EXAMPLES = [
  "Photosynthesis",
  "How the immune system works",
  "Python decorators",
  "French Revolution",
  "Newton's laws of motion",
  "Machine learning basics",
];

const $ = (id) => document.getElementById(id);
const radio = (name) => document.querySelector(`input[name="${name}"]:checked`).value;

const els = {
  form: $("form"), input: $("input"), count: $("count"), countOut: $("countOut"), charCount: $("charCount"),
  language: $("language"), submit: $("submit"), status: $("status"), examples: $("examples"),
  empty: $("empty"), toolbar: $("toolbar"), grid: $("flashcards"), study: $("study"),
  deckName: $("deckName"), deckMeta: $("deckMeta"),
  studyCard: $("studyCard"), studyPos: $("studyPos"), studyScore: $("studyScore"), progressBar: $("progressBar"),
  studyActions: document.querySelector(".study-actions"), keys: document.querySelector(".keys"),
  modelBadge: $("modelBadge"), modelText: $("modelText"),
  dialog: $("decksDialog"), deckList: $("deckList"), noDecks: $("noDecks"), deckCount: $("deckCount"),
  toast: $("toast"),
};

const state = { cards: [], title: "", view: "grid", queue: [], pos: 0 };

// ---------- helpers ----------
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children.filter(Boolean));
  return node;
}

function setStatus(message, kind = "") {
  els.status.textContent = message;
  els.status.className = kind;
}

let toastTimer;
function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2200);
}

const pad = (n) => String(n + 1).padStart(2, "0");
const slug = (s) => (s || "deck").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "deck";

function download(name, mime, content) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = h("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- cards ----------
function toggleFlip(el) {
  el.setAttribute("aria-pressed", String(el.classList.toggle("flipped")));
}

function buildCard(card, index = 0) {
  const front = h("div", { class: "face front" },
    h("div", { class: "tag" }, h("span", { text: `Question ${pad(index)}` })),
    h("p", { class: "body", text: card.question }),
    card.hint ? h("p", { class: "hint", text: `Hint: ${card.hint}` }) : null,
  );
  const back = h("div", { class: "face back" },
    h("div", { class: "tag" }, h("span", { text: "Answer" })),
    h("p", { class: "body", text: card.answer }),
  );

  const el = h("div", {
    class: `card${card.status ? ` ${card.status}` : ""}`,
    role: "button",
    tabindex: "0",
    "aria-pressed": "false",
    "aria-label": `Flashcard ${index + 1}. Press to flip.`,
  }, h("div", { class: "inner" }, front, back));

  el.style.setProperty("--i", Math.min(index, 12));
  el.addEventListener("click", () => toggleFlip(el));
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleFlip(el);
    }
  });
  return el;
}

function renderGrid() {
  els.grid.replaceChildren(...state.cards.map((card, i) => buildCard(card, i)));
}

function applyView() {
  const has = state.cards.length > 0;
  els.empty.hidden = has;
  els.toolbar.hidden = !has;
  els.grid.hidden = !has || state.view !== "grid";
  els.study.hidden = !has || state.view !== "study";
  if (!has) return;
  if (state.view === "grid") renderGrid();
  else startStudy(state.cards, true);
}

function render() {
  els.deckName.textContent = state.title;
  els.deckMeta.textContent = `${state.cards.length} cards`;
  applyView();
}

// ---------- study mode ----------
function startStudy(cards, reset = false) {
  if (reset) state.cards.forEach((c) => delete c.status);
  state.queue = cards;
  state.pos = 0;
  renderStudy();
}

function renderStudy() {
  const { queue, pos } = state;
  const done = pos >= queue.length;
  els.studyActions.hidden = done;
  els.keys.hidden = done;
  els.progressBar.style.width = `${queue.length ? (Math.min(pos, queue.length) / queue.length) * 100 : 0}%`;

  const known = state.cards.filter((c) => c.status === "known").length;
  const learning = state.cards.filter((c) => c.status === "learning").length;
  els.studyScore.textContent = `${known} known · ${learning} to review`;

  if (done) {
    els.studyPos.textContent = "Session complete";
    const row = h("div", { class: "row" });
    if (learning) {
      row.append(h("button", {
        type: "button", class: "btn miss", text: `Review missed (${learning})`,
        onclick: () => startStudy(state.cards.filter((c) => c.status === "learning")),
      }));
    }
    row.append(h("button", { type: "button", class: "btn", text: "Study again", onclick: () => startStudy(state.cards, true) }));
    els.studyCard.replaceChildren(h("div", { class: "summary" },
      h("h2", { text: learning ? "Nice work." : "Perfect run." }),
      h("p", { class: "score", text: `${known} of ${state.cards.length} cards marked as known` }),
      row,
    ));
    return;
  }

  els.studyPos.textContent = `Card ${pos + 1} / ${queue.length}`;
  const card = queue[pos];
  els.studyCard.replaceChildren(buildCard(card, state.cards.indexOf(card)));
}

function grade(status) {
  if (state.pos >= state.queue.length) return;
  state.queue[state.pos].status = status;
  state.pos += 1;
  renderStudy();
}

function move(delta) {
  const next = state.pos + delta;
  if (next < 0 || next >= state.queue.length) return;
  state.pos = next;
  renderStudy();
}

// ---------- generate ----------
function showSkeleton(n) {
  els.empty.hidden = true;
  els.toolbar.hidden = true;
  els.study.hidden = true;
  els.grid.hidden = false;
  els.grid.replaceChildren(...Array.from({ length: n }, () => h("div", { class: "skeleton", "aria-hidden": "true" })));
}

function setBusy(busy) {
  els.submit.disabled = busy;
  els.submit.classList.toggle("busy", busy);
  els.submit.firstElementChild.textContent = busy ? "Thinking" : "Generate flashcards";
}

async function generate(event) {
  event.preventDefault();
  const raw = els.input.value.trim();
  if (!raw) {
    setStatus("Add a topic or some notes first.", "error");
    els.input.focus();
    return;
  }

  const n = Number(els.count.value);
  const isNotes = raw.length > NOTES_MIN_CHARS || raw.includes("\n");
  const payload = {
    ...(isNotes ? { text: raw } : { topic: raw }),
    num_cards: n,
    difficulty: radio("difficulty"),
    style: radio("style"),
    language: els.language.value,
  };

  setBusy(true);
  setStatus("The model is writing your cards...");
  showSkeleton(Math.min(n, 8));

  try {
    const response = await fetch(`${API_URL}/api/flashcards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      setStatus(data.error || `Server error (${response.status}).`, "error");
      render();
      return;
    }
    if (!Array.isArray(data.flashcards) || data.flashcards.length === 0) {
      setStatus("No flashcards generated.", "error");
      render();
      return;
    }

    state.cards = data.flashcards.map((c) => ({
      question: String(c.question),
      answer: String(c.answer),
      hint: typeof c.hint === "string" ? c.hint : "",
    }));
    state.title = raw.split("\n")[0].slice(0, 56);
    render();

    if (data.warning) {
      setStatus(`Showing basic cards built from your text (AI unavailable: ${data.warning})`, "error");
    } else {
      setStatus(`${state.cards.length} cards ready · ${payload.difficulty} · ${payload.language}`, "ok");
    }
    if (window.innerWidth <= 980) els.empty.closest(".deck").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    console.error("Error generating flashcards:", error);
    setStatus(`Could not reach the backend at ${API_URL || location.origin}. Is it running?`, "error");
    render();
  } finally {
    setBusy(false);
  }
}

// ---------- toolbar actions ----------
function shuffle() {
  for (let i = state.cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [state.cards[i], state.cards[j]] = [state.cards[j], state.cards[i]];
  }
  applyView();
  toast("Shuffled");
}

function flipAll() {
  const cards = [...els.grid.querySelectorAll(".card")];
  const flipTo = cards.some((c) => !c.classList.contains("flipped"));
  cards.forEach((c) => {
    c.classList.toggle("flipped", flipTo);
    c.setAttribute("aria-pressed", String(flipTo));
  });
}

const plainCards = () => state.cards.map(({ question, answer, hint }) => ({ question, answer, hint }));

function exportCsv() {
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const rows = [["question", "answer", "hint"], ...plainCards().map((c) => [c.question, c.answer, c.hint])];
  download(`${slug(state.title)}.csv`, "text/csv;charset=utf-8", `﻿${rows.map((r) => r.map(esc).join(",")).join("\r\n")}`);
}

function exportJson() {
  download(`${slug(state.title)}.json`, "application/json", JSON.stringify({ title: state.title, cards: plainCards() }, null, 2));
}

async function copyDeck() {
  const text = plainCards().map((c, i) => `${i + 1}. Q: ${c.question}\n   A: ${c.answer}`).join("\n\n");
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    toast("Copy is blocked by the browser");
  }
}

// ---------- saved decks ----------
function loadDecks() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((d) => d && typeof d.id === "string" && Array.isArray(d.cards))
      .map((d) => ({
        id: d.id,
        title: String(d.title || "Untitled deck"),
        createdAt: Number(d.createdAt) || Date.now(),
        cards: d.cards
          .filter((c) => c && typeof c.question === "string" && typeof c.answer === "string")
          .map((c) => ({ question: c.question, answer: c.answer, hint: typeof c.hint === "string" ? c.hint : "" })),
      }));
  } catch {
    return [];
  }
}

function storeDecks(decks) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(decks));
    return true;
  } catch {
    toast("Could not save: browser storage is full or blocked");
    return false;
  }
}

function updateDeckCount() {
  els.deckCount.textContent = String(loadDecks().length);
}

function saveDeck() {
  const decks = loadDecks();
  decks.unshift({ id: Date.now().toString(36), title: state.title || "Untitled deck", createdAt: Date.now(), cards: plainCards() });
  if (storeDecks(decks.slice(0, MAX_SAVED_DECKS))) toast("Deck saved");
  updateDeckCount();
}

function renderDeckList() {
  const decks = loadDecks();
  els.noDecks.hidden = decks.length > 0;
  els.deckList.replaceChildren(...decks.map((deck) => h("li", {},
    h("div", { class: "meta" },
      h("strong", { text: deck.title }),
      h("span", { text: `${deck.cards.length} cards · ${new Date(deck.createdAt).toLocaleDateString()}` }),
    ),
    h("div", { class: "acts" },
      h("button", { type: "button", class: "btn", text: "Open", onclick: () => openDeck(deck) }),
      h("button", { type: "button", class: "btn miss", text: "Delete", onclick: () => deleteDeck(deck.id) }),
    ),
  )));
}

function openDeck(deck) {
  if (!deck.cards.length) return;
  state.cards = deck.cards.map((c) => ({ ...c }));
  state.title = deck.title;
  els.dialog.close();
  render();
  setStatus(`Loaded "${deck.title}"`, "ok");
}

function deleteDeck(id) {
  storeDecks(loadDecks().filter((d) => d.id !== id));
  renderDeckList();
  updateDeckCount();
}

// ---------- backend status ----------
async function checkHealth() {
  try {
    const response = await fetch(`${API_URL}/api/health`);
    const data = await response.json();
    if (data.huggingface) {
      els.modelBadge.dataset.state = "online";
      els.modelText.textContent = String(data.model || "online").split("/").pop();
    } else {
      els.modelBadge.dataset.state = "nokey";
      els.modelText.textContent = "no API key";
    }
  } catch {
    els.modelBadge.dataset.state = "offline";
    els.modelText.textContent = "backend offline";
  }
}

// ---------- wiring ----------
EXAMPLES.forEach((topic) => {
  els.examples.append(h("button", {
    type: "button", text: topic,
    onclick: () => {
      els.input.value = topic;
      els.input.dispatchEvent(new Event("input"));
      els.input.focus();
    },
  }));
});

els.input.addEventListener("input", () => {
  els.charCount.textContent = `${els.input.value.length} / ${els.input.maxLength}`;
});
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) els.form.requestSubmit();
});
els.count.addEventListener("input", () => { els.countOut.textContent = els.count.value; });
els.form.addEventListener("submit", generate);

document.querySelectorAll('input[name="view"]').forEach((r) =>
  r.addEventListener("change", () => {
    state.view = radio("view");
    applyView();
  }));

$("shuffleBtn").addEventListener("click", shuffle);
$("flipAllBtn").addEventListener("click", flipAll);
$("saveBtn").addEventListener("click", saveDeck);
$("csvBtn").addEventListener("click", exportCsv);
$("jsonBtn").addEventListener("click", exportJson);
$("copyBtn").addEventListener("click", copyDeck);
$("hitBtn").addEventListener("click", () => grade("known"));
$("missBtn").addEventListener("click", () => grade("learning"));
$("prevBtn").addEventListener("click", () => move(-1));
$("nextBtn").addEventListener("click", () => move(1));
$("decksBtn").addEventListener("click", () => { renderDeckList(); els.dialog.showModal(); });
$("closeDecks").addEventListener("click", () => els.dialog.close());
els.dialog.addEventListener("click", (e) => { if (e.target === els.dialog) els.dialog.close(); });

document.addEventListener("keydown", (e) => {
  if (state.view !== "study" || els.study.hidden || els.dialog.open) return;
  if (e.target instanceof Element && e.target.closest("input, textarea, select")) return;
  if (e.key === "ArrowRight") move(1);
  else if (e.key === "ArrowLeft") move(-1);
  else if (e.key === "1") grade("learning");
  else if (e.key === "2") grade("known");
  else if (e.key === " " && e.target === document.body) {
    e.preventDefault();
    const card = els.studyCard.querySelector(".card");
    if (card) toggleFlip(card);
  }
});

updateDeckCount();
checkHealth();
render();
