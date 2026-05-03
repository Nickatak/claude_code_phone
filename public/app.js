/**
 * Pocket Claude v2 - Frontend application.
 *
 * Mobile-first chat UI that communicates with the server via REST + SSE.
 * Each assistant message has an explicit status (running | complete |
 * stopped | error) and the bubble's presentation tracks that status -
 * a running bubble shows animated dots, a terminal bubble shows content.
 *
 * No token streaming. Tool cards stream live, but the assistant's text
 * appears once at terminal - never partial.
 */

// -- State --

let currentConversationId = null;
let eventSource = null;

// -- DOM refs --

const messagesContainer = document.getElementById("messages");
const promptInput = document.getElementById("prompt-input");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const sidebar = document.getElementById("sidebar");
const sidebarBtn = document.getElementById("sidebar-btn");
const sidebarCloseBtn = document.getElementById("sidebar-close-btn");
const conversationList = document.getElementById("conversation-list");
const newChatBtn = document.getElementById("new-chat-btn");

// -- API helpers --

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || response.statusText);
  }
  return response.json();
}

// -- SSE connection --

/**
 * Connect to the SSE stream for a conversation. Receives tool events
 * and the message terminal transition as they happen. If the
 * connection drops, the client can catch up via REST - no data is lost.
 */
function connectSSE(conversationId) {
  disconnectSSE();

  eventSource = new EventSource(`/api/conversations/${conversationId}/events`);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
      case "tool_start":
        addToolCard(data.messageId, data.toolId, data.toolName);
        break;

      case "tool_complete":
        completeToolCard(data.toolId, data.input);
        break;

      case "message_transition":
        applyTerminal(data.messageId, data.status, data.content);
        break;

      case "connected":
        break;
    }
  };

  eventSource.onerror = () => {
    // SSE auto-reconnects. Server-down state surfaces as the running
    // bubble staying as a placeholder until the connection comes back.
  };
}

function disconnectSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

// -- Message rendering --

/**
 * Render a message row from the server. Branches on role and status
 * so the same function handles every flavor of bubble:
 *   - user: always terminal, just renders content
 *   - assistant running: placeholder bubble with dots
 *   - assistant terminal: bubble with content (markdown-rendered)
 */
function renderMessage(msg) {
  const div = document.createElement("div");
  div.className = `message ${msg.role}`;
  div.dataset.messageId = msg.id;

  if (msg.role === "user") {
    div.textContent = msg.content || "";
  } else if (msg.status === "running") {
    div.classList.add("running");
    div.innerHTML = 'Thinking<span class="thinking-dots"></span>';
  } else {
    div.classList.add(msg.status);
    div.innerHTML = marked.parse(msg.content || "");
  }

  messagesContainer.appendChild(div);
  scrollToBottom();
  return div;
}

/**
 * Find a running assistant bubble by id and replace its placeholder
 * with terminal content. Idempotent: if the bubble is already
 * terminal, this is a no-op (handles SSE replays).
 */
function applyTerminal(messageId, status, content) {
  const bubble = messagesContainer.querySelector(
    `.message.assistant[data-message-id="${cssEscape(messageId)}"]`
  );
  if (!bubble) return;
  if (!bubble.classList.contains("running")) return;

  bubble.classList.remove("running");
  bubble.classList.add(status);
  bubble.innerHTML = marked.parse(content || "");
  scrollToBottom();
  syncProcessingButtons();
}

/**
 * Add a tool card. Tools are children of an assistant message - we
 * insert the card before the parent bubble so it appears chronologically
 * (between the user prompt and the assistant response).
 */
function addToolCard(messageId, toolId, toolName) {
  if (document.getElementById(`tool-${toolId}`)) return;

  const card = document.createElement("div");
  card.className = "tool-card running";
  card.id = `tool-${toolId}`;

  card.innerHTML = `
    <div class="tool-header">
      <span class="tool-name">${escapeHtml(toolName)}</span>
      <span class="tool-status">running</span>
    </div>
    <div class="tool-detail"></div>
  `;

  card.addEventListener("click", () => {
    card.classList.toggle("expanded");
  });

  const parentBubble = messagesContainer.querySelector(
    `.message.assistant[data-message-id="${cssEscape(messageId)}"]`
  );
  if (parentBubble) {
    messagesContainer.insertBefore(card, parentBubble);
  } else {
    messagesContainer.appendChild(card);
  }
  scrollToBottom();
}

/** Mark an existing tool card as complete and populate its detail. */
function completeToolCard(toolId, input) {
  const card = document.getElementById(`tool-${toolId}`);
  if (!card) return;

  card.classList.remove("running");
  const statusEl = card.querySelector(".tool-status");
  if (statusEl) statusEl.textContent = "done";

  const detailEl = card.querySelector(".tool-detail");
  if (detailEl && input) {
    try {
      const parsed = JSON.parse(input);
      detailEl.textContent = formatToolInput(parsed);
    } catch {
      detailEl.textContent = input;
    }
  }
}

/**
 * Format tool input JSON into a readable summary.
 * Shows the most relevant fields (file paths, commands) without
 * dumping the entire JSON blob.
 */
function formatToolInput(input) {
  if (typeof input !== "object" || input === null) return String(input);
  if (input.file_path) return input.file_path;
  if (input.command) return input.command;
  if (input.pattern) return input.pattern;
  if (input.query) return input.query;
  if (input.url) return input.url;
  return JSON.stringify(input, null, 2);
}

// -- Processing state --

/**
 * Send/stop button visibility derives from "is the latest assistant
 * message running?" rather than being toggled imperatively.
 */
function syncProcessingButtons() {
  const runningBubble = messagesContainer.querySelector(".message.assistant.running");
  const processing = runningBubble !== null;
  sendBtn.style.display = processing ? "none" : "flex";
  stopBtn.style.display = processing ? "flex" : "none";
  sendBtn.disabled = processing;
}

// -- State sync --

/**
 * Pull the full conversation state from the server and render it.
 * Used by both reconnect (loading a conversation from history) and
 * post-POST (covering the race where the SDK already finished by the
 * time we subscribe to SSE).
 */
async function syncConversationState() {
  if (!currentConversationId) return;

  messagesContainer.innerHTML = "";

  const msgs = await api(`/conversations/${currentConversationId}/messages`);
  for (const msg of msgs) {
    renderMessage(msg);
  }

  const tools = await api(`/conversations/${currentConversationId}/tools`);
  for (const tool of tools) {
    addToolCard(tool.messageId, tool.toolId, tool.toolName);
    if (tool.status !== "running") {
      completeToolCard(tool.toolId, tool.input);
    }
  }

  syncProcessingButtons();
}

// -- Send / stop --

async function sendMessage() {
  const text = promptInput.value.trim();
  if (!text) return;

  // Don't allow concurrent sends
  if (messagesContainer.querySelector(".message.assistant.running")) return;

  promptInput.value = "";
  sessionStorage.removeItem("rc_draft");
  autoResize();

  try {
    const endpoint = currentConversationId || "new";
    const result = await api(`/conversations/${endpoint}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: text }),
    });

    if (!currentConversationId) {
      currentConversationId = result.conversationId;
      localStorage.setItem("rc_conversation_id", currentConversationId);
    }

    // Sync state from server (covers fast-SDK race where the message
    // already terminal-transitioned before we subscribe to SSE) and
    // then attach the live event stream.
    await syncConversationState();
    connectSSE(currentConversationId);
  } catch (error) {
    // Render the failure as an inline assistant bubble so it lands in
    // the conversation flow rather than a popup.
    renderMessage({
      id: crypto.randomUUID(),
      role: "assistant",
      status: "error",
      content: `Error: ${error.message}`,
    });
    syncProcessingButtons();
  }
}

async function stopExecution() {
  if (!currentConversationId) return;

  try {
    await api(`/conversations/${currentConversationId}/stop`, {
      method: "POST",
    });
  } catch (error) {
    console.error("Failed to stop:", error);
  }
}

// -- Conversation management --

async function loadConversations() {
  try {
    const conversations = await api("/conversations");
    conversationList.innerHTML = "";

    for (const conv of conversations) {
      const item = document.createElement("div");
      item.className = "conv-item";
      if (conv.id === currentConversationId) item.classList.add("active");

      const title = conv.title || "Untitled";
      const time = new Date(conv.updatedAt || conv.createdAt).toLocaleDateString();

      item.innerHTML = `
        <div class="conv-title">${escapeHtml(title)}</div>
        <div class="conv-time">${time}</div>
      `;

      item.addEventListener("click", () => openConversation(conv.id));
      conversationList.appendChild(item);
    }
  } catch (error) {
    console.error("Failed to load conversations:", error);
  }
}

async function openConversation(conversationId) {
  currentConversationId = conversationId;
  localStorage.setItem("rc_conversation_id", conversationId);
  closeSidebar();
  disconnectSSE();

  try {
    await syncConversationState();
    connectSSE(conversationId);
  } catch (error) {
    console.error("Failed to open conversation:", error);
    renderMessage({
      id: crypto.randomUUID(),
      role: "assistant",
      status: "error",
      content: `Error loading conversation: ${error.message}`,
    });
  }
}

function startNewChat() {
  currentConversationId = null;
  localStorage.removeItem("rc_conversation_id");
  messagesContainer.innerHTML = "";
  disconnectSSE();
  syncProcessingButtons();
  promptInput.focus();
}

// -- Sidebar --

function openSidebar() {
  loadConversations();
  sidebar.classList.add("open");
}

function closeSidebar() {
  sidebar.classList.remove("open");
}

// -- Utilities --

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/** CSS.escape polyfill-ish for use inside querySelector strings. */
function cssEscape(str) {
  if (window.CSS && CSS.escape) return CSS.escape(str);
  return String(str).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function autoResize() {
  promptInput.style.height = "auto";
  promptInput.style.height = Math.min(promptInput.scrollHeight, 120) + "px";
}

// -- Event listeners --

sendBtn.addEventListener("click", sendMessage);
stopBtn.addEventListener("click", stopExecution);
sidebarBtn.addEventListener("click", openSidebar);
sidebarCloseBtn.addEventListener("click", closeSidebar);
newChatBtn.addEventListener("click", startNewChat);

promptInput.addEventListener("input", () => {
  autoResize();
  sessionStorage.setItem("rc_draft", promptInput.value);
});

// Ctrl+Enter to send on desktop, Enter adds newline on mobile
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendMessage();
  }
});

// Re-sync when the page becomes visible. Mobile PWAs (and Chrome under
// memory pressure) suspend backgrounded tabs, killing the SSE connection.
// If a message_transition fires while we're suspended, the in-memory SSE
// emitter drops it - so on resume, pull authoritative state from the DB.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!currentConversationId) return;
  if (!messagesContainer.querySelector(".message.assistant.running")) return;
  syncConversationState();
});

// -- Init --

const savedDraft = sessionStorage.getItem("rc_draft");
if (savedDraft) {
  promptInput.value = savedDraft;
  autoResize();
}

const savedConversationId = localStorage.getItem("rc_conversation_id");
if (savedConversationId) {
  openConversation(savedConversationId);
} else {
  syncProcessingButtons();
}
