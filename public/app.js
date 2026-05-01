/**
 * Remote Claude v2 - Frontend application.
 *
 * Mobile-first chat UI that communicates with the server via REST + SSE.
 * No token streaming - tool calls appear as cards in real time, and the
 * final response renders once as a complete message.
 */

// -- State --

let currentConversationId = null;
let eventSource = null;
let isProcessing = false;

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
 * and the final response in real time. If the connection drops, the
 * client can catch up via REST - no data is lost.
 */
function connectSSE(conversationId) {
  disconnectSSE();

  eventSource = new EventSource(`/api/conversations/${conversationId}/events`);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
      case "tool_start":
        addToolCard(data.toolId, data.toolName);
        break;

      case "tool_complete":
        completeToolCard(data.toolId, data.input);
        break;

      case "response_complete":
        removeThinking();
        addMessage("assistant", data.content);
        setProcessing(false);
        break;

      case "error":
        removeThinking();
        addMessage("assistant", `Error: ${data.message}`);
        setProcessing(false);
        break;

      case "stopped":
        removeThinking();
        addMessage("assistant", "(stopped)");
        setProcessing(false);
        break;

      case "connected":
        break;
    }
  };

  eventSource.onerror = () => {
    // SSE will auto-reconnect. If the server is down, the connection
    // will keep retrying. No special handling needed.
  };
}

function disconnectSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

// -- Message rendering --

/** Add a chat message to the UI. */
function addMessage(role, content) {
  const div = document.createElement("div");
  div.className = `message ${role}`;

  if (role === "assistant") {
    div.innerHTML = marked.parse(content || "");
  } else {
    div.textContent = content;
  }

  messagesContainer.appendChild(div);
  scrollToBottom();
}

/** Add a tool card that shows a tool call in progress. */
function addToolCard(toolId, toolName) {
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

  // Toggle detail on tap
  card.addEventListener("click", () => {
    card.classList.toggle("expanded");
  });

  // Insert before the thinking indicator so it stays at the bottom
  const thinking = document.getElementById("thinking-indicator");
  if (thinking) {
    messagesContainer.insertBefore(card, thinking);
  } else {
    messagesContainer.appendChild(card);
  }
  scrollToBottom();
}

/** Mark a tool card as complete and populate its detail. */
function completeToolCard(toolId, input) {
  const card = document.getElementById(`tool-${toolId}`);
  if (!card) return;

  card.classList.remove("running");
  const statusEl = card.querySelector(".tool-status");
  if (statusEl) statusEl.textContent = "done";

  // Parse and display the tool input as readable detail
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

  // Common patterns: show the most useful field
  if (input.file_path) return input.file_path;
  if (input.command) return input.command;
  if (input.pattern) return input.pattern;
  if (input.query) return input.query;
  if (input.url) return input.url;

  return JSON.stringify(input, null, 2);
}

/** Show the thinking indicator. */
function showThinking() {
  removeThinking();
  const div = document.createElement("div");
  div.className = "thinking";
  div.id = "thinking-indicator";
  div.innerHTML = 'Thinking<span class="thinking-dots"></span>';
  messagesContainer.appendChild(div);
  scrollToBottom();
}

/** Remove the thinking indicator. */
function removeThinking() {
  const indicator = document.getElementById("thinking-indicator");
  if (indicator) indicator.remove();
}

// -- Processing state --

/** Toggle between send and stop buttons, enable/disable input. */
function setProcessing(processing) {
  isProcessing = processing;
  sendBtn.style.display = processing ? "none" : "flex";
  stopBtn.style.display = processing ? "flex" : "none";
  sendBtn.disabled = processing;
}

// -- Send / stop --

async function sendMessage() {
  const text = promptInput.value.trim();
  if (!text || isProcessing) return;

  promptInput.value = "";
  sessionStorage.removeItem("rc_draft");
  autoResize();
  addMessage("user", text);
  showThinking();
  setProcessing(true);

  try {
    const endpoint = currentConversationId || "new";
    const result = await api(`/conversations/${endpoint}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: text }),
    });

    // If this was a new conversation, store the ID and connect SSE
    if (!currentConversationId) {
      currentConversationId = result.conversationId;
      localStorage.setItem("rc_conversation_id", currentConversationId);
      connectSSE(currentConversationId);
    }
  } catch (error) {
    removeThinking();
    addMessage("assistant", `Error: ${error.message}`);
    setProcessing(false);
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
  messagesContainer.innerHTML = "";
  closeSidebar();
  disconnectSSE();
  setProcessing(false);

  try {
    // Load message history
    const msgs = await api(`/conversations/${conversationId}/messages`);
    for (const msg of msgs) {
      addMessage(msg.role, msg.content);
    }

    const status = await api(`/conversations/${conversationId}/status`);
    if (status.status === "running") {
      showThinking();
      setProcessing(true);

      // Load any tool events that happened while we were away
      const tools = await api(`/conversations/${conversationId}/tools`);
      for (const tool of tools) {
        addToolCard(tool.toolId, tool.toolName);
        if (tool.status === "complete") {
          completeToolCard(tool.toolId, tool.input);
        }
      }
    }

    connectSSE(conversationId);
  } catch (error) {
    console.error("Failed to open conversation:", error);
    addMessage("assistant", `Error loading conversation: ${error.message}`);
  }
}

function startNewChat() {
  currentConversationId = null;
  localStorage.removeItem("rc_conversation_id");
  messagesContainer.innerHTML = "";
  disconnectSSE();
  setProcessing(false);
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

/** Auto-resize textarea to fit content. */
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

// -- Init --

// Restore draft if the app was backgrounded
const savedDraft = sessionStorage.getItem("rc_draft");
if (savedDraft) {
  promptInput.value = savedDraft;
  autoResize();
}

// If we had a conversation open, reconnect to it
const savedConversationId = localStorage.getItem("rc_conversation_id");
if (savedConversationId) {
  openConversation(savedConversationId);
}
