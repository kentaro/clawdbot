/**
 * Discord Voice Tool
 *
 * Agent tool for Discord voice channel operations:
 * - join: Join a voice channel
 * - play: Play an audio file
 * - leave: Leave the voice channel
 * - tts: Generate and play TTS in voice channel
 */

import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import { loadConfig, type MoltbotConfig } from "../../config/config.js";
import { textToSpeech } from "../../tts/tts.js";
import {
  destroyVoiceManager,
  getVoiceManager,
  initVoiceManager,
  setActiveVoiceGuild,
  type TranscriptionCallback,
} from "../../discord/voice.js";
import { callGateway } from "../../gateway/call.js";
import type { AnyAgentTool } from "./common.js";
import { readStringParam, readNumberParam } from "./common.js";

// Global transcription callback registry
let globalTranscriptionCallback: TranscriptionCallback | undefined;

const VoiceToolSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("join"),
      Type.Literal("play"),
      Type.Literal("stop"),
      Type.Literal("leave"),
      Type.Literal("tts"),
      Type.Literal("status"),
      Type.Literal("listen"),
      Type.Literal("stop-listen"),
    ],
    {
      description: "Voice action: join, play, stop, leave, tts, status, listen, stop-listen",
    },
  ),
  guildId: Type.Optional(Type.String({ description: "Discord server (guild) ID" })),
  channelId: Type.Optional(Type.String({ description: "Voice channel ID (for join)" })),
  filePath: Type.Optional(Type.String({ description: "Path to audio file (for play)" })),
  text: Type.Optional(Type.String({ description: "Text to speak (for tts action)" })),
  volume: Type.Optional(Type.Number({ description: "Volume (0.0-1.0, default 1.0)" })),
  language: Type.Optional(
    Type.String({ description: "Language hint for Whisper (e.g., 'ja', 'en')" }),
  ),
});

type VoiceToolParams = {
  action: "join" | "play" | "stop" | "leave" | "tts" | "status" | "listen" | "stop-listen";
  guildId?: string;
  channelId?: string;
  filePath?: string;
  text?: string;
  volume?: number;
  language?: string;
};

async function handleVoiceAction(
  params: VoiceToolParams,
  cfg: MoltbotConfig,
  agentSessionKey?: string,
): Promise<AgentToolResult<unknown>> {
  const { action, guildId, channelId, filePath, text, volume, language } = params;

  // Get Discord token from config
  const discordConfig = cfg.channels?.discord;
  const token =
    process.env.DISCORD_BOT_TOKEN ??
    discordConfig?.token ??
    discordConfig?.accounts?.default?.token;

  if (!token) {
    return {
      content: [{ type: "text", text: "Discord bot token not configured" }],
      details: { error: "missing_token" },
    };
  }

  try {
    switch (action) {
      case "join": {
        if (!guildId || !channelId) {
          return {
            content: [{ type: "text", text: "guildId and channelId required for join" }],
            details: { error: "missing_params" },
          };
        }
        const manager = await initVoiceManager(token);
        await manager.join(guildId, channelId);

        // Auto-start listening after join
        const openaiApiKey = process.env.OPENAI_API_KEY;
        let listening = false;
        if (openaiApiKey) {
          // Use voice-specific session key
          const voiceSessionKey = `agent:main:discord:voice:${channelId}`;
          setActiveVoiceGuild(guildId);

          const onTranscription: TranscriptionCallback = async (
            userId,
            username,
            transcript,
            gId,
            chId,
          ) => {
            console.log(`[voice] Transcription from ${username} (${userId}): ${transcript}`);
            if (globalTranscriptionCallback) {
              globalTranscriptionCallback(userId, username, transcript, gId, chId);
            }
            // Send transcription to voice session via chat.send
            if (transcript.trim()) {
              try {
                const voiceMessage = `[Voice from ${username}]: ${transcript}`;
                await callGateway({
                  method: "chat.send",
                  params: {
                    sessionKey: voiceSessionKey,
                    message: voiceMessage,
                    idempotencyKey: randomUUID(),
                  },
                  config: cfg,
                });
                console.log(`[voice] Sent transcription to voice session ${voiceSessionKey}`);
              } catch (err) {
                console.error(`[voice] Failed to send transcription to session:`, err);
              }
            }
          };
          await manager.startListening(guildId, {
            onTranscription,
            language: language ?? "ja",
            openaiApiKey,
          });
          listening = true;
        }

        return {
          content: [
            {
              type: "text",
              text: `Joined voice channel ${channelId}${listening ? " (listening)" : ""}`,
            },
          ],
          details: { guildId, channelId, listening },
        };
      }

      case "play": {
        if (!guildId || !filePath) {
          return {
            content: [{ type: "text", text: "guildId and filePath required for play" }],
            details: { error: "missing_params" },
          };
        }
        const manager = getVoiceManager(token);
        if (!manager) {
          return {
            content: [{ type: "text", text: "Not connected to voice. Use join first." }],
            details: { error: "not_connected" },
          };
        }
        await manager.play(guildId, filePath, volume);
        return {
          content: [{ type: "text", text: `Played audio: ${filePath}` }],
          details: { guildId, filePath },
        };
      }

      case "stop": {
        if (!guildId) {
          return {
            content: [{ type: "text", text: "guildId required for stop" }],
            details: { error: "missing_params" },
          };
        }
        const manager = getVoiceManager(token);
        if (manager) {
          manager.stop(guildId);
        }
        return {
          content: [{ type: "text", text: "Stopped playback" }],
          details: { guildId },
        };
      }

      case "leave": {
        if (!guildId) {
          return {
            content: [{ type: "text", text: "guildId required for leave" }],
            details: { error: "missing_params" },
          };
        }
        const manager = getVoiceManager(token);
        if (manager) {
          manager.leave(guildId);
        }
        setActiveVoiceGuild(undefined);
        return {
          content: [{ type: "text", text: "Left voice channel" }],
          details: { guildId },
        };
      }

      case "tts": {
        if (!guildId || !text) {
          return {
            content: [{ type: "text", text: "guildId and text required for tts" }],
            details: { error: "missing_params" },
          };
        }
        const manager = getVoiceManager(token);
        if (!manager || !manager.isConnected(guildId)) {
          return {
            content: [{ type: "text", text: "Not connected to voice. Use join first." }],
            details: { error: "not_connected" },
          };
        }

        // Generate TTS audio
        const ttsResult = await textToSpeech({
          text,
          cfg,
          channel: "discord",
        });

        if (!ttsResult.success || !ttsResult.audioPath) {
          return {
            content: [{ type: "text", text: ttsResult.error ?? "TTS failed" }],
            details: { error: "tts_failed" },
          };
        }

        // Play the generated audio
        await manager.play(guildId, ttsResult.audioPath, volume);
        return {
          content: [{ type: "text", text: `Spoke in voice channel: "${text}"` }],
          details: { guildId, text, audioPath: ttsResult.audioPath },
        };
      }

      case "status": {
        const manager = getVoiceManager(token);
        if (!manager) {
          return {
            content: [{ type: "text", text: "Voice manager not initialized" }],
            details: { connected: false },
          };
        }
        if (guildId) {
          const connected = manager.isConnected(guildId);
          const channelId = manager.getChannelId(guildId);
          const listening = manager.isListening(guildId);
          return {
            content: [
              {
                type: "text",
                text: connected
                  ? `Connected to voice channel ${channelId} in guild ${guildId}${listening ? " (listening)" : ""}`
                  : `Not connected to voice in guild ${guildId}`,
              },
            ],
            details: { guildId, connected, channelId, listening },
          };
        }
        return {
          content: [{ type: "text", text: "Voice manager initialized" }],
          details: { initialized: true },
        };
      }

      case "listen": {
        if (!guildId) {
          return {
            content: [{ type: "text", text: "guildId required for listen" }],
            details: { error: "missing_params" },
          };
        }
        const manager = getVoiceManager(token);
        if (!manager || !manager.isConnected(guildId)) {
          return {
            content: [{ type: "text", text: "Not connected to voice. Use join first." }],
            details: { error: "not_connected" },
          };
        }

        // Get OpenAI API key
        const openaiApiKey = process.env.OPENAI_API_KEY;
        if (!openaiApiKey) {
          return {
            content: [{ type: "text", text: "OPENAI_API_KEY not set for Whisper transcription" }],
            details: { error: "missing_api_key" },
          };
        }

        // Set up transcription callback
        const onTranscription: TranscriptionCallback = async (
          userId,
          username,
          transcript,
          gId,
          chId,
        ) => {
          console.log(`[voice] Transcription from ${username} (${userId}): ${transcript}`);
          // Call the global callback if registered
          if (globalTranscriptionCallback) {
            globalTranscriptionCallback(userId, username, transcript, gId, chId);
          }
          // Send transcription to agent session via chat.send
          if (agentSessionKey && transcript.trim()) {
            try {
              const voiceMessage = `[Voice from ${username}]: ${transcript}`;
              await callGateway({
                method: "chat.send",
                params: {
                  sessionKey: agentSessionKey,
                  message: voiceMessage,
                  idempotencyKey: randomUUID(),
                },
                config: cfg,
              });
              console.log(`[voice] Sent transcription to session ${agentSessionKey}`);
            } catch (err) {
              console.error(`[voice] Failed to send transcription to session:`, err);
            }
          }
        };

        await manager.startListening(guildId, {
          onTranscription,
          language: language ?? "ja",
          openaiApiKey,
        });

        return {
          content: [
            {
              type: "text",
              text: `Started listening in guild ${guildId}. Transcriptions will be logged.`,
            },
          ],
          details: { guildId, listening: true, language: language ?? "ja" },
        };
      }

      case "stop-listen": {
        if (!guildId) {
          return {
            content: [{ type: "text", text: "guildId required for stop-listen" }],
            details: { error: "missing_params" },
          };
        }
        const manager = getVoiceManager(token);
        if (manager) {
          manager.stopListening(guildId);
        }
        return {
          content: [{ type: "text", text: `Stopped listening in guild ${guildId}` }],
          details: { guildId, listening: false },
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown voice action: ${action}` }],
          details: { error: "unknown_action" },
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Voice error: ${message}` }],
      details: { error: message },
    };
  }
}

export function createVoiceTool(opts?: {
  config?: MoltbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool {
  return {
    label: "Voice",
    name: "voice",
    description:
      "Discord voice channel operations. Actions: join (connect to VC), play (play audio file), stop, leave, tts (speak text), listen (start transcribing), stop-listen, status.",
    parameters: VoiceToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", {
        required: true,
      }) as VoiceToolParams["action"];
      const guildId = readStringParam(params, "guildId");
      const channelId = readStringParam(params, "channelId");
      const filePath = readStringParam(params, "filePath");
      const text = readStringParam(params, "text");
      const volume = readNumberParam(params, "volume");
      const language = readStringParam(params, "language");

      const cfg = opts?.config ?? loadConfig();

      return handleVoiceAction(
        { action, guildId, channelId, filePath, text, volume, language },
        cfg,
        opts?.agentSessionKey,
      );
    },
  };
}

/**
 * Set a global callback for voice transcriptions.
 * This allows integrating transcriptions with the agent session.
 */
export function setTranscriptionCallback(callback: TranscriptionCallback | undefined): void {
  globalTranscriptionCallback = callback;
}
