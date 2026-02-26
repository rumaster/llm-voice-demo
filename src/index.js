import dotenv from 'dotenv';
dotenv.config();

import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket, { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

wss.on("connection", (clientWs) => {
  console.log("Client connected");

  let voiceEnabled = false;

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI Realtime");

    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          input_audio_format: "pcm16",
          input_audio_transcription: {
            model: "gpt-4o-mini-transcribe"
          },
          turn_detection: null,
          modalities: ["text"]
        }
      })
    );
  });

  clientWs.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.type === "audio") {
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: data.audio
      }));
    }

    if (data.type === "commit") {
      voiceEnabled = data.voice === true;
      console.log('COMMIT', voiceEnabled)

      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.commit"
      }));

      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: voiceEnabled ? ["text", "audio"] : ["text"]
        }
      }));
    }
  });

  openaiWs.on("message", (message) => {
    const event = JSON.parse(message.toString());
    switch (event.type) {
      case 'conversation.item.input_audio_transcription.completed':
        console.log(event.type, event.transcript, event.usage)
        // Распознанная речь пользователя
        clientWs.send(JSON.stringify({
          type: "user_transcript",
          text: event.transcript
        }));
        break;
      case 'response.audio.delta':
        console.log(event.type, event)
        // Частичный аудио-ответ модели
        clientWs.send(JSON.stringify({
          type: "assistant_audio",
          audio: event.delta
        }));
        break;
      case 'response.text.delta':
        console.log(event.type, event)
        // Частичный ответ модели
        clientWs.send(JSON.stringify({
          type: "assistant_partial",
          text: event.delta
        }));
        break;
      case 'response.text.done':
        console.log(event.type, event.text)
        // Финальный ответ модели
        clientWs.send(JSON.stringify({
          type: "assistant_final",
          text: event.text
        }));
        break;
      case 'response.audio_transcript.delta':
        console.log(event.type, event)
        // Частичный ответ модели
        clientWs.send(JSON.stringify({
          type: "assistant_partial",
          text: event.delta
        }));
        break;
      case 'response.audio_transcript.done':
        console.log(event.type, event)
        // Финальный ответ модели
        clientWs.send(JSON.stringify({
          type: "assistant_final",
          text: event.transcript
        }));
        break;
    }

  });

  openaiWs.on("close", () => {
    console.log("OpenAI connection closed");
  });

  clientWs.on("close", () => {
    console.log("Client disconnected");
    openaiWs.close();
  });
});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
