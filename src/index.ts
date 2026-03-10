import dotenv from "dotenv";
import express, { Request, Response } from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket, { WebSocketServer } from "ws";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, "public")));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

type ClientInbound =
  | { type: "ping" }
  | { type: "audio"; audio: string }
  | { type: "commit"; voice?: boolean };

type AssistantOutbound =
  | { type: "pong" }
  | { type: "user_transcript"; text: string }
  | { type: "assistant_partial"; text: string }
  | { type: "assistant_final"; text: string }
  | { type: "assistant_audio"; audio: string };

type OpenAIEvent =
  | { type: "conversation.item.input_audio_transcription.completed"; transcript: string }
  | { type: "response.audio.delta"; delta: string }
  | { type: "response.text.delta"; delta: string }
  | { type: "response.text.done"; text: string }
  | { type: "response.audio_transcript.delta"; delta: string }
  | { type: "response.audio_transcript.done"; transcript: string }
  | { type: string; [k: string]: unknown };

wss.on("connection", (clientWs: WebSocket) => {
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
            model: "gpt-4o-mini-transcribe",
          },
          turn_detection: null,
          modalities: ["text", "audio"],
          instructions:
            "Отвечай только на русском языке, даже если слышишь куски других языков.",
        },
      })
    );
  });

  clientWs.on("message", (raw: WebSocket.RawData) => {
    const data = JSON.parse(raw.toString()) as ClientInbound;

    if (data.type === "ping") {
      const msg: AssistantOutbound = { type: "pong" };
      clientWs.send(JSON.stringify(msg));
      return;
    }

    if (data.type === "audio") {
      openaiWs.send(
        JSON.stringify({ type: "input_audio_buffer.append", audio: data.audio })
      );
    }

    if (data.type === "commit") {
      voiceEnabled = data.voice === true;

      openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

      openaiWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: voiceEnabled ? ["text", "audio"] : ["text"],
          },
        })
      );
    }
  });

  openaiWs.on("message", (message: WebSocket.RawData) => {
    const event = JSON.parse(message.toString()) as OpenAIEvent;
    console.log((event as any).type, (event as any).transcript);

    switch (event.type) {
      case "conversation.item.input_audio_transcription.completed": {
        const payload: AssistantOutbound = {
          type: "user_transcript",
          text: (event as any).transcript as string,
        };
        clientWs.send(JSON.stringify(payload));
        break;
      }
      case "response.audio.delta": {
        const payload: AssistantOutbound = {
          type: "assistant_audio",
          audio: (event as any).delta as string,
        };
        clientWs.send(JSON.stringify(payload));
        break;
      }
      case "response.text.delta": {
        const payload: AssistantOutbound = {
          type: "assistant_partial",
          text: (event as any).delta as string,
        };
        clientWs.send(JSON.stringify(payload));
        break;
      }
      case "response.text.done": {
        const payload: AssistantOutbound = {
          type: "assistant_final",
          text: (event as any).text as string,
        };
        clientWs.send(JSON.stringify(payload));
        break;
      }
      case "response.audio_transcript.delta": {
        const payload: AssistantOutbound = {
          type: "assistant_partial",
          text: (event as any).delta as string,
        };
        clientWs.send(JSON.stringify(payload));
        break;
      }
      case "response.audio_transcript.done": {
        const payload: AssistantOutbound = {
          type: "assistant_final",
          text: (event as any).transcript as string,
        };
        clientWs.send(JSON.stringify(payload));
        break;
      }
      default:
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
