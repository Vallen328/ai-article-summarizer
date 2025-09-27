// popup.js - Full updated script for Gemini / Generative Language
// - Uses endpoint pattern: https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}
// - Chunking, timeout, retry, promisified chrome APIs, safe UI updates

// ---------- Promisified Chrome helpers ----------
function getFromStorage(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
}
function queryActiveTab() {
  return new Promise((resolve) =>
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
      resolve(tabs && tabs[0] ? tabs[0] : null)
    )
  );
}
function sendMessageToTab(tabId, message) {
  return new Promise((resolve) =>
    chrome.tabs.sendMessage(tabId, message, (res) => resolve(res))
  );
}

// ---------- UI helpers ----------
const resultDiv = document.getElementById("result");
const summarizeBtn = document.getElementById("summarize");
const copyBtn = document.getElementById("copy-btn");
const summaryTypeSelect = document.getElementById("summary-type");
const modelSelect = document.getElementById("model-name"); // optional select in popup HTML

function showLoading() {
  resultDiv.innerHTML = '<div class="loading"><div class="loader"></div></div>';
}
function showError(msg) {
  resultDiv.innerText = msg;
}
function showText(text) {
  // preserve newlines, wrap long lines
  resultDiv.innerHTML = `<pre style="white-space:pre-wrap;word-wrap:break-word;">${text}</pre>`;
}

// ---------- Main click handler ----------
summarizeBtn.addEventListener("click", async () => {
  showLoading();

  try {
    const { geminiApiKey } = await getFromStorage(["geminiApiKey"]);
    if (!geminiApiKey) {
      showError("API key not found. Please set your API key in the extension options.");
      return;
    }

    const tab = await queryActiveTab();
    if (!tab) {
      showError("No active tab found.");
      return;
    }

    const res = await sendMessageToTab(tab.id, { type: "GET_ARTICLE_TEXT" });
    if (!res || !res.text) {
      showError("Could not extract article text from this page. Make sure your content script responds to GET_ARTICLE_TEXT.");
      return;
    }

    const summaryType = summaryTypeSelect?.value || "brief";
    const chosenModel = modelSelect?.value || "gemini-2.5-flash";

    const summary = await getGeminiSummary(res.text, summaryType, geminiApiKey, chosenModel);
    showText(summary);
  } catch (err) {
    console.error(err);
    showError(`Error: ${err?.message || "Failed to summarize."}`);
  }
});

// ---------- Copy button ----------
copyBtn.addEventListener("click", async () => {
  const summaryText = resultDiv.innerText || "";
  if (!summaryText.trim()) return;
  try {
    await navigator.clipboard.writeText(summaryText);
    const original = copyBtn.innerText;
    copyBtn.innerText = "Copied!";
    setTimeout(() => (copyBtn.innerText = original), 2000);
  } catch (err) {
    console.error("Failed to copy text:", err);
  }
});

// ---------- Gemini / Generative Language logic ----------
// High-level: chunk -> summarize each chunk -> combine partial summaries (if multiple)
// Uses callGeminiWithRetry -> callGemini (with timeout & endpoint pattern)

async function getGeminiSummary(fullText, summaryType, apiKey, modelName = "gemini-2.5-flash") {
  // Conservative chunk size in characters (adjust based on tokenization & costs)
  const MAX_CHUNK_CHARS = 18000;
  const textChunks = chunkTextOnParagraph(fullText, MAX_CHUNK_CHARS);

  const makePrompt = (t) => {
    switch (summaryType) {
      case "brief":
        return `Provide a brief summary of the following article in 2-3 sentences:\n\n${t}`;
      case "detailed":
        return `Provide a detailed summary of the following article, covering all main points and key details:\n\n${t}`;
      case "bullets":
        return `Summarize the following article in 5-7 key points. Format each point as a line starting with "- " (dash followed by a space). Do not use asterisks or other bullet symbols. Keep each point concise and focused on a single idea:\n\n${t}`;
      default:
        return `Summarize the following article:\n\n${t}`;
    }
  };

  const partialSummaries = [];
  for (let i = 0; i < textChunks.length; i++) {
    const prompt = makePrompt(textChunks[i]);
    const singleSummary = await callGeminiWithRetry(prompt, apiKey, modelName);
    partialSummaries.push(singleSummary);
  }

  if (partialSummaries.length === 1) return partialSummaries[0];

  // Combine partial summaries into a final summary (dedupe + concise)
  const combinedPrompt = `You are given multiple partial summaries from a long article. Combine them into one coherent ${
    summaryType === "bullets" ? "bullet list" : "summary"
  }, remove duplicates, and keep it concise. Preserve the same format (bullet list vs. paragraph) as requested:\n\n${partialSummaries.join("\n\n---\n\n")}`;

  return await callGeminiWithRetry(combinedPrompt, apiKey, modelName);
}

// Prefer splitting on paragraph boundaries where possible
function chunkTextOnParagraph(text, maxChars) {
  if (!text || text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n{2,}|\r\n{2,}/).filter(Boolean);
  const chunks = [];
  let current = "";

  for (const p of paragraphs) {
    if ((current + "\n\n" + p).length <= maxChars) {
      current = current ? current + "\n\n" + p : p;
    } else {
      if (current) chunks.push(current);
      // If a single paragraph is larger than maxChars, slice it
      if (p.length > maxChars) {
        let start = 0;
        while (start < p.length) {
          chunks.push(p.slice(start, start + maxChars));
          start += maxChars;
        }
        current = "";
      } else {
        current = p;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// callGeminiWithRetry: retry wrapper
async function callGeminiWithRetry(prompt, apiKey, modelName = "gemini-2.5-flash", attempts = 2) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await callGemini(prompt, apiKey, modelName);
    } catch (err) {
      lastErr = err;
      console.warn(`Gemini attempt ${i + 1} failed:`, err);
      // small backoff
      await new Promise((r) => setTimeout(r, 400 + i * 250));
    }
  }
  throw lastErr;
}

// callGemini: POST to the Generative Language endpoint with timeout
async function callGemini(prompt, apiKey, modelName = "gemini-2.5-flash", timeoutMs = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    modelName
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        // Keep payload simple and consistent with REST examples
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          // You can add other generationConfig settings here (maxOutputTokens, topK, etc.)
        },
      }),
    });

    clearTimeout(id);

    if (!res.ok) {
      // try to get readable error
      const errText = await res.text().catch(() => "");
      try {
        const parsed = JSON.parse(errText || "{}");
        throw new Error(parsed.error?.message || `API error ${res.status}`);
      } catch {
        throw new Error(`API error ${res.status} - ${errText}`);
      }
    }

    const data = await res.json();
    // data.candidates[0].content.parts[0].text is typically where text lives
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "No summary available.";
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Request timed out.");
    throw err;
  }
}

