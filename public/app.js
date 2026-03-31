// --- State ---
let ws = null;
let workerOnline = false;
let currentConversationId = localStorage.getItem("rc_convId") || null;
let currentCwd = localStorage.getItem("rc_cwd") || null;
let directories = [];
let userRole = localStorage.getItem("rc_role") || "chat";
let isStreaming = false;
let currentAssistantEl = null;
let currentToolEls = {};

// --- Elements ---
const $ = (sel) => document.querySelector(sel);
const offlineOverlay = $("#offline-overlay");
const chatContainer = $("#chat-container");
const messagesEl = $("#messages");
const inputEl = $("#input");
const sendBtn = $("#send-btn");
const statusBadge = $("#status-badge");
const menuBtn = $("#menu-btn");
const sidebar = $("#sidebar");
const sidebarClose = $("#sidebar-close");
const convList = $("#conversation-list");
const newChatBtn = $("#new-chat-btn");
const newChatModal = $("#new-chat-modal");
const modalClose = $("#modal-close");
const dirList = $("#dir-list");

// --- WebSocket ---
function connectWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws/client`);

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    setTimeout(connectWs, 3000);
  };

  ws.onerror = () => {};
}

function handleMessage(msg) {
  switch (msg.type) {
    case "status":
      if (msg.directories) directories = msg.directories;
      setWorkerStatus(msg.workerOnline);
      break;
    case "conversation_created":
      currentConversationId = msg.conversationId;
      localStorage.setItem("rc_convId", msg.conversationId);
      break;
    case "stream_event":
      handleStreamEvent(msg.event);
      break;
    case "result":
      finalizeResponse(msg);
      break;
    case "error":
      showError(msg.message);
      break;
  }
}

function setWorkerStatus(online) {
  workerOnline = online;
  statusBadge.textContent = online ? "online" : "offline";
  statusBadge.className = online ? "online" : "offline";

  if (online) {
    offlineOverlay.classList.remove("visible");
    chatContainer.style.display = "flex";
    updateSendBtn();
  } else {
    offlineOverlay.classList.add("visible");
    chatContainer.style.display = "none";
  }
}

// --- Markdown rendering ---
marked.setOptions({ breaks: true, gfm: true });
function renderMarkdown(text) {
  return marked.parse(text);
}

// --- Streaming ---
let streamingRawText = "";

function ensureAssistantBubble() {
  if (!currentAssistantEl) {
    currentAssistantEl = document.createElement("div");
    currentAssistantEl.className = "message assistant";
    currentAssistantEl.style.display = "none";
    messagesEl.appendChild(currentAssistantEl);
    streamingRawText = "";
  }
  return currentAssistantEl;
}

// Close current text bubble so the next text starts fresh
function finalizeCurrentBubble() {
  if (currentAssistantEl) {
    currentAssistantEl.classList.remove("streaming-active");
    if (!currentAssistantEl.textContent.trim()) {
      currentAssistantEl.remove();
    }
    currentAssistantEl = null;
    streamingRawText = "";
  }
}

function parseToolInput(raw) {
  try {
    const parsed = JSON.parse(raw);
    // Show the most useful field depending on tool type
    if (parsed.command) return parsed.command;
    if (parsed.url) return parsed.url;
    if (parsed.file_path) return parsed.file_path;
    if (parsed.pattern) return parsed.pattern;
    if (parsed.query) return parsed.query;
    if (parsed.content) return parsed.content.slice(0, 200) + (parsed.content.length > 200 ? "..." : "");
    return raw;
  } catch {
    return raw;
  }
}

function handleStreamEvent(event) {
  isStreaming = true;
  hideSpinner();
  updateSendBtn();

  switch (event.type) {
    case "text_delta": {
      const bubble = ensureAssistantBubble();
      if (bubble.style.display === "none") {
        bubble.style.display = "";
        bubble.classList.add("streaming-active");
      }
      streamingRawText += event.text;
      bubble.innerHTML = renderMarkdown(streamingRawText);
      scrollToBottom();
      break;
    }
    case "tool_start": {
      // Close any current text bubble
      finalizeCurrentBubble();

      // Create tool call as its own message
      const toolDiv = document.createElement("div");
      toolDiv.className = "message tool-call executing";
      toolDiv.innerHTML = `<div class="tool-name">${escapeHtml(event.toolName)}</div><div class="tool-content"></div>`;
      messagesEl.appendChild(toolDiv);
      currentToolEls[event.toolId] = toolDiv;
      scrollToBottom();
      break;
    }
    case "tool_input": {
      const toolDiv = currentToolEls[event.toolId];
      if (toolDiv) {
        const content = toolDiv.querySelector(".tool-content");
        content.textContent += event.partialInput;
        scrollToBottom();
      }
      break;
    }
    case "tool_result": {
      const toolDiv = currentToolEls[event.toolId];
      if (toolDiv) {
        toolDiv.classList.remove("executing");
        // Parse the accumulated input for nicer display
        const content = toolDiv.querySelector(".tool-content");
        content.textContent = parseToolInput(content.textContent);
      }
      // Show spinner again — more processing may follow
      showSpinner();
      // Next text will start a new bubble
      scrollToBottom();
      break;
    }
  }
}

function finalizeResponse(msg) {
  isStreaming = false;
  hideSpinner();

  // If we have fullText, always ensure it's visible
  if (msg.fullText) {
    // Check if any assistant bubble already has this text
    const existingBubbles = messagesEl.querySelectorAll(".message.assistant");
    const hasText = Array.from(existingBubbles).some(b => b.textContent.trim());

    if (!hasText) {
      const bubble = ensureAssistantBubble();
      bubble.innerHTML = renderMarkdown(msg.fullText);
      bubble.style.display = "";
    }
  }

  finalizeCurrentBubble();
  currentToolEls = {};
  updateSendBtn();
}

function showError(message) {
  isStreaming = false;
  hideSpinner();
  const el = document.createElement("div");
  el.className = "message assistant";
  el.style.borderLeft = `3px solid var(--error)`;
  el.textContent = `Error: ${message}`;
  messagesEl.appendChild(el);
  currentAssistantEl = null;
  currentToolEls = {};
  updateSendBtn();
  scrollToBottom();
}

// --- Sending ---
function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || !workerOnline || isStreaming) return;

  // Show user message
  const userEl = document.createElement("div");
  userEl.className = "message user";
  userEl.textContent = text;
  messagesEl.appendChild(userEl);

  // Send to relay
  const payload = {
    type: "send",
    conversationId: currentConversationId,
    message: text,
  };
  if (!currentConversationId && currentCwd) {
    payload.cwd = currentCwd;
  }
  ws.send(JSON.stringify(payload));

  isStreaming = true;

  // Show spinner
  showSpinner();

  inputEl.value = "";
  autoResize();
  updateSendBtn();
  scrollToBottom();
}

let spinnerEl = null;

function showSpinner() {
  if (spinnerEl) return;
  spinnerEl = document.createElement("div");
  spinnerEl.className = "spinner";
  spinnerEl.innerHTML = "<span></span><span></span><span></span>";
  messagesEl.appendChild(spinnerEl);
  scrollToBottom();
}

function hideSpinner() {
  if (spinnerEl) {
    spinnerEl.remove();
    spinnerEl = null;
  }
}

// --- Conversations ---
async function loadConversations() {
  try {
    const res = await fetch("/api/conversations");
    const convs = await res.json();
    convList.innerHTML = "";
    for (const conv of convs) {
      const el = document.createElement("div");
      el.className = "conv-item" + (conv.id === currentConversationId ? " active" : "");
      el.innerHTML = `
        <div class="conv-title">${escapeHtml(conv.title || "Untitled")}</div>
        <div class="conv-time">${formatTime(conv.updatedAt)}</div>
      `;
      el.onclick = () => openConversation(conv.id);
      convList.appendChild(el);
    }
  } catch {}
}

async function openConversation(id) {
  currentConversationId = id;
  localStorage.setItem("rc_convId", id);
  messagesEl.innerHTML = "";
  sidebar.classList.remove("open");

  try {
    const res = await fetch(`/api/conversations/${id}/messages`);
    const msgs = await res.json();
    for (const msg of msgs) {
      const el = document.createElement("div");
      el.className = `message ${msg.role}`;
      if (msg.role === "assistant") {
        el.innerHTML = renderMarkdown(msg.content);
      } else {
        el.textContent = msg.content;
      }
      messagesEl.appendChild(el);
    }
    scrollToBottom();
  } catch {}
}

function startNewChat() {
  sidebar.classList.remove("open");

  if (userRole === "admin" && directories.length > 0) {
    showDirPicker();
  } else {
    currentConversationId = null;
    currentCwd = null;
    localStorage.removeItem("rc_convId");
    localStorage.removeItem("rc_cwd");
    messagesEl.innerHTML = "";
  }
}

function showDirPicker() {
  dirList.innerHTML = "";
  for (const dir of directories) {
    const el = document.createElement("div");
    el.className = "dir-item";
    el.innerHTML = `
      <div style="flex:1">
        <div class="dir-name">${escapeHtml(dir.name)}</div>
        <div class="dir-path">${escapeHtml(dir.path)}</div>
      </div>
      ${dir.hasClaudeMd ? '<span class="dir-badge">CLAUDE.md</span>' : ""}
    `;
    el.onclick = () => selectDir(dir.path);
    dirList.appendChild(el);
  }
  newChatModal.classList.add("open");
}

function selectDir(dirPath) {
  currentConversationId = null;
  currentCwd = dirPath;
  localStorage.removeItem("rc_convId");
  localStorage.setItem("rc_cwd", dirPath);
  messagesEl.innerHTML = "";
  newChatModal.classList.remove("open");
}

// --- UI helpers ---
function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function updateSendBtn() {
  sendBtn.disabled = !workerOnline || isStreaming || !inputEl.value.trim();
}

function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso + "Z");
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// --- Event listeners ---
sendBtn.addEventListener("click", sendMessage);

inputEl.addEventListener("input", () => {
  autoResize();
  updateSendBtn();
});

const isMobile = "ontouchstart" in window || navigator.maxTouchPoints > 0;

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !isMobile) {
    e.preventDefault();
    sendMessage();
  }
});

menuBtn.addEventListener("click", () => {
  sidebar.classList.add("open");
  loadConversations();
});

sidebarClose.addEventListener("click", () => {
  sidebar.classList.remove("open");
});

newChatBtn.addEventListener("click", startNewChat);

modalClose.addEventListener("click", () => {
  newChatModal.classList.remove("open");
});

// Close modal on backdrop click
newChatModal.addEventListener("click", (e) => {
  if (e.target === newChatModal) newChatModal.classList.remove("open");
});

// --- Init ---
connectWs();
if (currentConversationId) {
  openConversation(currentConversationId);
}
