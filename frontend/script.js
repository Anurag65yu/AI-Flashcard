// Same-origin whenever the page is served over http(s) (Flask serves the frontend); only a double-clicked file needs the local URL.
const API_URL = window.API_URL || (location.protocol === "file:" ? "http://127.0.0.1:5000" : "");

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
  file: $("file"), drop: $("drop"), dropHint: $("dropHint"), fileChip: $("fileChip"), fileName: $("fileName"),
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
    const firstLine = raw.split("\n")[0].trim();
    state.title = upload.name && raw === upload.text.trim() ? `File: ${upload.name.slice(0, 44)}` : isNotes ? `Notes: ${firstLine.slice(0, 32)}${firstLine.length > 32 ? "…" : ""}` : firstLine.slice(0, 56);
    render();

    if (data.warning) {
      setStatus(`Showing basic cards built from your text (AI unavailable: ${data.warning})`, "error");
    } else {
      setStatus(`${state.cards.length} cards ready · ${payload.difficulty} · ${payload.language}`, "ok");
    }
    if (window.innerWidth <= 980) els.empty.closest(".stage").scrollIntoView({ behavior: "smooth", block: "start" });
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

// ---------- photo / pdf upload (extraction runs in the browser, the file never leaves the device) ----------
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_PDF_PAGES = 30;
const MAX_OCR_PAGES = 5;
const MIN_PDF_TEXT = 80;
const LIBS = {
  pdf: {
    url: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js",
    sri: "sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e",
    worker: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js",
  },
  ocr: {
    url: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js",
    sri: "sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F",
  },
};
const upload = { name: "", text: "", token: 0 };
const loaded = {};

function loadLib(key) {
  if (!loaded[key]) {
    const lib = LIBS[key];
    loaded[key] = new Promise((resolve, reject) => {
      const tag = h("script", { src: lib.url, integrity: lib.sri, crossorigin: "anonymous" });
      tag.onload = resolve;
      tag.onerror = () => { delete loaded[key]; reject(new Error("Could not load the reader library (are you online?)")); };
      document.head.append(tag);
    });
  }
  return loaded[key];
}

async function ocrImages(sources, progress) {
  await loadLib("ocr");
  let index = 0;
  const worker = await window.Tesseract.createWorker("eng", 1, {
    logger: (m) => { if (m.status === "recognizing text") progress(index, sources.length, m.progress); },
  });
  try {
    const parts = [];
    for (; index < sources.length; index++) {
      const { data } = await worker.recognize(sources[index]);
      parts.push(data.text);
    }
    return parts.join("\n\n");
  } finally {
    await worker.terminate();
  }
}

async function readPdf(file, progress) {
  await loadLib("pdf");
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = LIBS.pdf.worker;
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  try {
    const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
    let text = "";
    for (let i = 1; i <= pages; i++) {
      progress(`Reading page ${i} / ${pages}`);
      const content = await (await doc.getPage(i)).getTextContent();
      text += `${content.items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join("")}\n\n`;
    }
    if (text.replace(/\s/g, "").length >= MIN_PDF_TEXT) return { text, note: doc.numPages > pages ? `first ${pages} of ${doc.numPages} pages` : "" };

    const ocrPages = Math.min(doc.numPages, MAX_OCR_PAGES);
    const canvases = [];
    for (let i = 1; i <= ocrPages; i++) {
      progress(`Scanned pdf, preparing page ${i} / ${ocrPages}`);
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = h("canvas", { width: String(Math.floor(viewport.width)), height: String(Math.floor(viewport.height)) });
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      canvases.push(canvas);
    }
    const ocr = await ocrImages(canvases, (n, total, p) => progress(`Reading scanned page ${n + 1} / ${total} (${Math.round(p * 100)}%)`));
    return { text: ocr, note: `OCR on first ${ocrPages} page${ocrPages > 1 ? "s" : ""}` };
  } finally {
    doc.destroy();
  }
}

async function readImage(file, progress) {
  progress("Loading text reader...");
  const text = await ocrImages([file], (n, total, p) => progress(`Reading text from photo (${Math.round(p * 100)}%)`));
  return { text, note: "OCR" };
}

function tidyText(text) {
  return text.replace(/\r/g, "").replace(/[ \t ]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function clearUpload() {
  upload.token += 1;
  upload.name = "";
  upload.text = "";
  els.fileChip.hidden = true;
  els.file.value = "";
  els.drop.classList.remove("busy");
  els.submit.disabled = false;
}

async function handleFile(file) {
  if (!file) return;
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const isImage = /^image\/(png|jpe?g|webp|bmp)$/.test(file.type);
  if (!isPdf && !isImage) return setStatus("Please choose a PDF or a PNG, JPG, WebP or BMP photo.", "error");
  if (file.size > MAX_FILE_BYTES) return setStatus("That file is over 15 MB. Try a smaller one.", "error");

  const token = ++upload.token;
  els.drop.classList.add("busy");
  els.submit.disabled = true;
  els.fileChip.hidden = true;
  const progress = (msg) => { if (token === upload.token) setStatus(msg); };

  try {
    const { text, note } = isPdf ? await readPdf(file, progress) : await readImage(file, progress);
    if (token !== upload.token) return;
    let clean = tidyText(text);
    if (clean.replace(/\s/g, "").length < 20) {
      setStatus("No readable text found in that file. Try a sharper photo or a text-based PDF.", "error");
      return;
    }
    const max = els.input.maxLength;
    const cut = clean.length > max;
    if (cut) clean = clean.slice(0, max);

    els.input.value = clean;
    els.input.dispatchEvent(new Event("input"));
    upload.name = file.name;
    upload.text = clean;
    els.fileName.textContent = `${file.name} · ${clean.length} chars${note ? ` · ${note}` : ""}`;
    els.fileChip.hidden = false;
    setStatus(cut ? `Text extracted and trimmed to ${max} characters. Edit it if you like, then generate.` : "Text extracted. Edit it if you like, then generate.", "ok");
  } catch (error) {
    console.error("File read failed:", error);
    if (token === upload.token) setStatus(`Could not read that file: ${error.message || "unknown error"}`, "error");
  } finally {
    if (token === upload.token) {
      els.drop.classList.remove("busy");
      els.submit.disabled = false;
      els.file.value = "";
    }
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

els.file.addEventListener("change", () => handleFile(els.file.files[0]));
$("fileClear").addEventListener("click", () => { clearUpload(); setStatus(""); });
["dragenter", "dragover"].forEach((t) => els.drop.addEventListener(t, (e) => { e.preventDefault(); els.drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => els.drop.addEventListener(t, () => els.drop.classList.remove("over")));
els.drop.addEventListener("drop", (e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); });
["dragover", "drop"].forEach((t) => window.addEventListener(t, (e) => e.preventDefault()));

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
