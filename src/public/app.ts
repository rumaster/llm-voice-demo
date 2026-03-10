const protocol: string = window.location.protocol === "https:" ? "wss:" : "ws:";
const host: string = window.location.host;

// === CONNECTION MANAGEMENT ===
let ws: WebSocket | null = null;
let isConnected = false;
let pingInterval: number | null = null;
const PING_INTERVAL_MS = 10000; // 10 seconds
const RECONNECT_DELAY_MS = 2000; // 2 seconds delay before reconnect

function connect(): void {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return; // Already connected or connecting
  }

  ws = new WebSocket(`${protocol}//${host}`);

  ws.onopen = () => {
    console.log("WebSocket connected");
    isConnected = true;
    updateConnectionUI();
    startPing();
  };

  ws.onclose = () => {
    console.log("WebSocket disconnected");
    isConnected = false;
    updateConnectionUI();
    stopPing();
    scheduleReconnect();
  };

  ws.onerror = (error) => {
    console.error("WebSocket error:", error);
    // onclose will be called after onerror
  };

  ws.onmessage = handleMessage;
}

function startPing(): void {
  stopPing(); // Clear any existing interval
  pingInterval = window.setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, PING_INTERVAL_MS);
}

function stopPing(): void {
  if (pingInterval !== null) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

function scheduleReconnect(): void {
  console.log(`Reconnecting in ${RECONNECT_DELAY_MS / 1000} seconds...`);
  setTimeout(() => {
    console.log("Attempting to reconnect...");
    connect();
  }, RECONNECT_DELAY_MS);
}

function updateConnectionUI(): void {
  const statusIndicator = document.getElementById("connectionStatus");
  if (isConnected) {
    talkBtn.disabled = false;
    talkBtn.classList.remove("disabled");
    if (statusIndicator) {
      statusIndicator.textContent = "Подключено";
      statusIndicator.className = "connection-status connected";
    }
  } else {
    talkBtn.disabled = true;
    talkBtn.classList.add("disabled");
    if (statusIndicator) {
      statusIndicator.textContent = "Отключено. Переподключение...";
      statusIndicator.className = "connection-status disconnected";
    }
  }
}

const talkBtn = document.getElementById("talkBtn") as HTMLButtonElement;
const voiceToggle = document.getElementById("voiceToggle") as HTMLInputElement;
const userTextEl = document.getElementById("userText") as HTMLDivElement;
const assistantTextEl = document.getElementById("assistantText") as HTMLDivElement;
const historyContainer = document.getElementById("historyContainer") as HTMLDivElement;
const clearHistoryBtn = document.getElementById("clearHistoryBtn") as HTMLButtonElement;

// === CONVERSATION HISTORY ===
interface HistoryItem { role: "user" | "assistant"; content: string }
let conversationHistory: HistoryItem[] = [];
let currentUserTranscript = "";
let currentAssistantResponse = "";

function addToHistory(role: HistoryItem["role"], text: string): void {
  if (!text || text.trim() === "") return;

  conversationHistory.push({ role, content: text });
  renderHistory();
}

function renderHistory(): void {
  historyContainer.innerHTML = "";

  for (const item of conversationHistory) {
    const div = document.createElement("div");
    div.className = `history-item ${item.role}`;

    const roleLabel = document.createElement("div");
    roleLabel.className = "history-role";
    roleLabel.textContent = item.role === "user" ? "Вы:" : "Ассистент:";

    const content = document.createElement("div");
    content.textContent = item.content;

    div.appendChild(roleLabel);
    div.appendChild(content);
    historyContainer.appendChild(div);
  }

  // Scroll to bottom
  historyContainer.scrollTop = historyContainer.scrollHeight;
}

function clearHistory(): void {
  conversationHistory = [];
  renderHistory();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "clear_history" }));
  }
}

clearHistoryBtn.onclick = clearHistory;

let audioContext: AudioContext;
let processor: ScriptProcessorNode;
let input: MediaStreamAudioSourceNode;
let stream: MediaStream;
let isRecording = false;

// === AUDIO PLAYBACK ===
let playbackContext = new AudioContext({ sampleRate: 24000 });
let playbackQueue: ArrayBuffer[] = [];
let isPlaying = false;

function playNextChunk(): void {
  if (playbackQueue.length === 0) {
    isPlaying = false;
    return;
  }

  isPlaying = true;

  const pcm16 = playbackQueue.shift()!;
  const float32 = convertPCM16ToFloat32(pcm16);

  const buffer = playbackContext.createBuffer(1, float32.length, 24000);
  buffer.copyToChannel(float32 as any, 0);

  const source = playbackContext.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackContext.destination);
  source.onended = playNextChunk;
  source.start();
}

function enqueueAudio(base64Chunk: string): void {
  if (!base64Chunk || typeof base64Chunk !== "string") {
    return;
  }

  // base64 должна быть кратна 4
  if (base64Chunk.length % 4 !== 0) {
    return;
  }

  let binary: string;
  try {
    binary = atob(base64Chunk);
  } catch (e) {
    console.error("Invalid base64 audio chunk", e);
    return;
  }

  const len = binary.length;
  const buffer = new ArrayBuffer(len);
  const view = new Uint8Array(buffer);

  for (let i = 0; i < len; i++) {
    view[i] = binary.charCodeAt(i);
  }

  playbackQueue.push(buffer);

  if (!isPlaying) {
    playNextChunk();
  }
}

function convertPCM16ToFloat32(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer);
  const length = buffer.byteLength / 2;
  const float32 = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    float32[i] = view.getInt16(i * 2, true) / 32768;
  }

  return float32;
}

// === WEBSOCKET EVENTS ===

type ServerMessage =
  | { type: "pong" }
  | { type: "user_transcript"; text: string }
  | { type: "assistant_partial"; text: string }
  | { type: "assistant_final"; text: string }
  | { type: "assistant_audio"; audio: string };

function handleMessage(event: MessageEvent<string>): void {
  const data = JSON.parse(event.data) as ServerMessage;

  if (data.type === "pong") {
    return; // keep-alive only
  }

  if (data.type === "user_transcript") {
    userTextEl.textContent = data.text;
    assistantTextEl.textContent = "";
    currentUserTranscript = data.text;
    currentAssistantResponse = "";
    console.log("user_transcript", data);
  }

  if (data.type === "assistant_partial") {
    console.log("assistant_partial", data);
    assistantTextEl.textContent += data.text;
  }

  if (data.type === "assistant_final") {
    console.log("assistant_final", data);
    assistantTextEl.textContent = data.text;
    currentAssistantResponse = data.text;

    if (currentUserTranscript) addToHistory("user", currentUserTranscript);
    if (currentAssistantResponse) addToHistory("assistant", currentAssistantResponse);

    currentUserTranscript = "";
    currentAssistantResponse = "";
  }

  if (data.type === "assistant_audio") {
    enqueueAudio(data.audio);
  }
}

// === RECORDING ===

async function startRecording(): Promise<void> {
  if (isRecording) return;
  if (!isConnected) return;

  stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  audioContext = new AudioContext({ sampleRate: 16000 });
  input = audioContext.createMediaStreamSource(stream);
  processor = audioContext.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (e: AudioProcessingEvent) => {
    if (!isRecording || !ws) return;

    const floatData = e.inputBuffer.getChannelData(0);
    const pcmBuffer = floatTo16BitPCM(floatData);
    const base64 = arrayBufferToBase64(pcmBuffer);

    ws.send(
      JSON.stringify({
        type: "audio",
        audio: base64,
      })
    );
  };

  input.connect(processor);
  processor.connect(audioContext.destination);

  talkBtn.classList.add("recording");
  userTextEl.textContent = "";
  assistantTextEl.textContent = "";

  isRecording = true;
}

function stopRecording(): void {
  if (!isRecording) return;

  isRecording = false;

  ws?.send(
    JSON.stringify({
      type: "commit",
      voice: voiceToggle.checked,
    })
  );

  processor.disconnect();
  input.disconnect();
  stream.getTracks().forEach((track) => track.stop());

  talkBtn.classList.remove("recording");
}

// === BUTTON HANDLERS ===

talkBtn.onmousedown = startRecording;
talkBtn.onmouseup = stopRecording;
talkBtn.onmouseleave = stopRecording;

talkBtn.ontouchstart = startRecording;
talkBtn.ontouchend = stopRecording;

// === HELPERS ===

function floatTo16BitPCM(float32Array: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);

  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);

  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}

// === INITIALIZE CONNECTION ===
connect();
