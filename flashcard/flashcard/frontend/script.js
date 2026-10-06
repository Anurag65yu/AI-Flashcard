const backendUrl = "http://127.0.0.1:5000"; // Flask backend

async function generateFlashcards() {
  const topic = document.getElementById("topicInput").value.trim();
  if (!topic) {
    alert("Please enter a topic or some text!");
    return;
  }

  try {
    const response = await fetch(`${backendUrl}/api/flashcards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic })
    });

    const data = await response.json();
    const flashcardsDiv = document.getElementById("flashcards");
    flashcardsDiv.innerHTML = "";

    if (data.flashcards && data.flashcards.length > 0) {
      data.flashcards.forEach(card => {
        const cardDiv = document.createElement("div");
        cardDiv.className = "card";
        cardDiv.innerHTML = `<strong>Q:</strong> ${card.question}<br><strong>A:</strong> ${card.answer}`;
        flashcardsDiv.appendChild(cardDiv);
      });
    } else {
      flashcardsDiv.innerHTML = "<p>No flashcards generated.</p>";
    }
  } catch (error) {
    console.error("Error generating flashcards:", error);
    alert("Error connecting to backend!");
  }
}
