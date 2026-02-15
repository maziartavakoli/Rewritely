// --- CONFIGURATION ---
const API_KEY = "sk-ogFtw9Fbx9Xa2GWXN3L7DyxPa7rrZv3lqVR9loznSsT4TcZt"; 
const API_URL = "https://api.gapgpt.app/v1/chat/completions";
// ---------------------

// Helper function to handle the AI call
async function handleAI(mode) {
  const targetLang = document.getElementById("targetLang").value;
  const tone = document.getElementById("tone").value;
  const resultBox = document.getElementById("result");
  const translateBtn = document.getElementById("translateBtn");
  const replyBtn = document.getElementById("replyBtn");

  // Disable buttons while thinking
  translateBtn.disabled = true;
  replyBtn.disabled = true;
  resultBox.value = "BegooMagoo is thinking...";

  try {
    // 1. Get Active Tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // 2. Get Selected Text
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: () => window.getSelection().toString()
    });

    if (!injectionResults || !injectionResults[0] || !injectionResults[0].result) {
      throw new Error("No text selected! Please highlight text first.");
    }

    const selectedText = injectionResults[0].result.trim();
    if (!selectedText) throw new Error("Selection is empty.");

    // 3. Define the Prompt based on which button was clicked
    let systemPrompt = "";
    if (mode === "translate") {
      systemPrompt = `You are a translator. Translate the text to ${targetLang}. Tone: ${tone}. Output ONLY the translation.`;
    } else {
      systemPrompt = `You are a communication assistant. Write a reply/answer to the user's text. Write the reply in ${targetLang}. Tone: ${tone}. Output ONLY the reply.`;
    }

    // 4. Call GapGPT API
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: selectedText }
        ]
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || "API Error");
    }

    const data = await response.json();

    if (data.choices && data.choices[0]) {
      // Put the result in the editable box
      resultBox.value = data.choices[0].message.content;
    } else {
      throw new Error("No response.");
    }

  } catch (error) {
    resultBox.value = "Error: " + error.message;
  } finally {
    translateBtn.disabled = false;
    replyBtn.disabled = false;
  }
}

// Attach listeners to the two buttons
document.getElementById("translateBtn").addEventListener("click", () => handleAI("translate"));
document.getElementById("replyBtn").addEventListener("click", () => handleAI("reply"));