const ws = new WebSocket("ws://localhost:3000");

const talkBtn = document.getElementById("talkBtn");
const voiceToggle = document.getElementById("voiceToggle");
const userTextEl = document.getElementById("userText");
const assistantTextEl = document.getElementById("assistantText");

let audioContext;
let processor;
let input;
let stream;
let isRecording = false;

// === AUDIO PLAYBACK ===
let playbackContext = new AudioContext({ sampleRate: 24000 });
let playbackQueue = [];
let isPlaying = false;

function playNextChunk() {
  if (playbackQueue.length === 0) {
    isPlaying = false;
    return;
  }

  isPlaying = true;

  const pcm16 = playbackQueue.shift();
  const float32 = convertPCM16ToFloat32(pcm16);

  const buffer = playbackContext.createBuffer(
    1,
    float32.length,
    24000
  );

  buffer.copyToChannel(float32, 0);

  const source = playbackContext.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackContext.destination);
  source.onended = playNextChunk;
  source.start();
}

function enqueueAudio(base64Chunk) {
  console.log(base64Chunk)
  if (!base64Chunk || typeof base64Chunk !== "string") {
    return;
  }

  // base64 должна быть кратна 4
  if (base64Chunk.length % 4 !== 0) {
    return;
  }

  let binary;
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

function convertPCM16ToFloat32(buffer) {
  const view = new DataView(buffer);
  const length = buffer.byteLength / 2;
  const float32 = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    float32[i] = view.getInt16(i * 2, true) / 32768;
  }

  return float32;
}

// === WEBSOCKET EVENTS ===

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  if (data.type === "user_transcript") {
    userTextEl.textContent = data.text;
    assistantTextEl.textContent = "";
    console.log("user_transcript", data)
  }

  if (data.type === "assistant_partial") {
    console.log("assistant_partial", data)
    assistantTextEl.textContent += data.text;
  }

  if (data.type === "assistant_final") {
    console.log("assistant_final", data)
    assistantTextEl.textContent = data.text;
  }

  if (data.type === "assistant_audio") {
    enqueueAudio(data.audio);
  }
};

// === RECORDING ===

async function startRecording() {
  if (isRecording) return;

  stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  audioContext = new AudioContext({ sampleRate: 16000 });
  input = audioContext.createMediaStreamSource(stream);
  processor = audioContext.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (e) => {
    if (!isRecording) return;

    const floatData = e.inputBuffer.getChannelData(0);
    const pcmBuffer = floatTo16BitPCM(floatData);
    const base64 = arrayBufferToBase64(pcmBuffer);

    ws.send(JSON.stringify({
      type: "audio",
      audio: base64
    }));
  };

  input.connect(processor);
  processor.connect(audioContext.destination);

  talkBtn.classList.add("recording");
  userTextEl.textContent = "";
  assistantTextEl.textContent = "";

  isRecording = true;
}

function stopRecording() {
  if (!isRecording) return;

  isRecording = false;

  ws.send(JSON.stringify({
    type: "commit",
    voice: voiceToggle.checked
  }));

  processor.disconnect();
  input.disconnect();
  stream.getTracks().forEach(track => track.stop());

  talkBtn.classList.remove("recording");
}

// === BUTTON HANDLERS ===

talkBtn.onmousedown = startRecording;
talkBtn.onmouseup = stopRecording;
talkBtn.onmouseleave = stopRecording;

talkBtn.ontouchstart = startRecording;
talkBtn.ontouchend = stopRecording;

// === HELPERS ===

function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);

  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return buffer;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);

  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}
