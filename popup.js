document.getElementById("translateBtn").addEventListener("click", async () => {
  // --- CONFIGURATION ---
  const API_KEY = "sk-ogFtw9Fbx9Xa2GWXN3L7DyxPa7rrZv3lqVR9loznSsT4TcZt"; 
  const API_URL = "https://api.gapgpt.app/v1/chat/completions";
  // ---------------------

  const targetLang = document.getElementById("targetLang").value;
  const tone = document.getElementById("tone").value;
  const resultDiv = document.getElementById("result");
  const btn = document.getElementById("translateBtn");

  // Reset UI
  resultDiv.className = "";
  resultDiv.innerText = "BegooMagoo is thinking...";
  btn.disabled = true;

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

    const textToTranslate = injectionResults[0].result.trim();
    if (!textToTranslate) throw new Error("Selection is empty.");

    // 3. Call GapGPT API
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // Use mini for faster speed
        messages: [
          {
            role: "system", 
            content: `You are 'BegooMagoo', a helpful translator. Translate the user's text to ${targetLang}. 
            Tone: ${tone}. 
            IMPORTANT: Output ONLY the translated text. Do not add quotes or explanations.`
          },
          { role: "user", content: textToTranslate }
        ]
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || "API Connection Failed");
    }

    const data = await response.json();

    if (data.choices && data.choices[0]) {
      resultDiv.innerText = data.choices[0].message.content;
    } else {
      throw new Error("No translation returned.");
    }

  } catch (error) {
    resultDiv.className = "error";
    resultDiv.innerText = "Error: " + error.message;
  } finally {
    btn.disabled = false;
  }
});