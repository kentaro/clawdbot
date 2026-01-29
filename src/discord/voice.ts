/**
 * Discord Voice Support
 *
 * Uses @discordjs/voice with a minimal discord.js Client for voice channel operations.
 * Designed to coexist with Carbon (which handles text Gateway).
 *
 * Features:
 * - Join/leave voice channels
 * - Play audio files (TTS, etc.)
 * - Listen to users and transcribe with Whisper
 */

import {
  AudioPlayer,
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { Client, GatewayIntentBits, type Guild, type VoiceBasedChannel } from "discord.js";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as prism from "prism-media";

// Noise patterns to filter out (Whisper hallucinations and short noise)
const NOISE_PATTERNS = [
  /^ん+[。、]?$/,
  /^あ+[。、]?$/,
  /^え+[。、]?$/,
  /^う+[。、]?$/,
  /^はい[。、]?$/,
  /^いっ[。、]?$/,
  /^ご視聴ありがとうございました/,
  /^ご清聴ありがとうございました/,
  /^【.*エンディング.*】/,
  /^by\s+[A-Z]\./i,
  /^またね[。、]?$/,
  /^どうも[。、]?$/,
  /^\s*$/,
];

/**
 * Check if transcript is likely noise/hallucination from Whisper.
 */
function isNoiseTranscript(text: string): boolean {
  const trimmed = text.trim();
  // Too short (less than 3 chars excluding punctuation)
  const withoutPunct = trimmed.replace(/[。、！？!?.,\s]/g, "");
  if (withoutPunct.length < 3) return true;

  // Matches known noise patterns
  return NOISE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export type VoiceManagerOptions = {
  token: string;
  /** Directory for temporary audio files. Defaults to system temp. */
  tempDir?: string;
};

export type TranscriptionCallback = (
  userId: string,
  username: string,
  text: string,
  guildId: string,
  channelId: string,
) => void | Promise<void>;

export type VoiceListenerOptions = {
  /** Callback when transcription is ready */
  onTranscription: TranscriptionCallback;
  /** Silence duration in ms before considering speech ended. Default: 1500 */
  silenceThreshold?: number;
  /** Minimum speech duration in ms to process. Default: 500 */
  minSpeechDuration?: number;
  /** OpenAI API key for Whisper. Falls back to OPENAI_API_KEY env */
  openaiApiKey?: string;
  /** Language hint for Whisper (e.g., 'ja', 'en') */
  language?: string;
};

/**
 * VoiceManager handles Discord voice operations.
 * Uses discord.js internally for voice adapter support.
 */
export class VoiceManager {
  private client: Client;
  private players = new Map<string, AudioPlayer>();
  private ready = false;
  private readyPromise: Promise<void>;
  private tempDir: string;
  private listenerOptions: VoiceListenerOptions | undefined;
  private activeListeners = new Map<string, Set<string>>(); // guildId -> Set<userId>
  private userBuffers = new Map<string, { chunks: Buffer[]; lastActivity: number }>();

  constructor(opts: VoiceManagerOptions) {
    this.tempDir = opts.tempDir ?? join(tmpdir(), "clawdbot-voice");
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });

    this.readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Voice client login timeout"));
      }, 30_000);

      this.client.once("ready", () => {
        clearTimeout(timeout);
        this.ready = true;
        resolve();
      });

      this.client.once("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.client.login(opts.token).catch(reject);
    });
  }

  /**
   * Wait for the voice client to be ready.
   */
  async waitReady(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Join a voice channel.
   */
  async join(guildId: string, channelId: string): Promise<VoiceConnection> {
    if (!this.ready) {
      await this.waitReady();
    }

    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      // Try to fetch if not in cache
      try {
        await this.client.guilds.fetch(guildId);
      } catch {
        throw new Error(`Guild ${guildId} not accessible`);
      }
    }

    const fetchedGuild = this.client.guilds.cache.get(guildId);
    if (!fetchedGuild) {
      throw new Error(`Guild ${guildId} not found`);
    }

    const channel = fetchedGuild.channels.cache.get(channelId) as VoiceBasedChannel | undefined;
    if (!channel) {
      // Try to fetch channel
      try {
        await fetchedGuild.channels.fetch(channelId);
      } catch {
        throw new Error(`Channel ${channelId} not accessible`);
      }
    }

    const fetchedChannel = fetchedGuild.channels.cache.get(channelId) as
      | VoiceBasedChannel
      | undefined;
    if (!fetchedChannel || !fetchedChannel.isVoiceBased()) {
      throw new Error(`Channel ${channelId} is not a voice channel`);
    }

    const existing = getVoiceConnection(guildId);
    if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) {
      existing.rejoin({
        channelId,
        selfDeaf: false,
        selfMute: false,
      });
      return existing;
    }

    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: fetchedGuild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (error) {
      connection.destroy();
      throw new Error(`Failed to join voice channel: ${error}`);
    }

    return connection;
  }

  /**
   * Play an audio file in the voice channel.
   */
  async play(guildId: string, filePath: string, volume?: number): Promise<void> {
    const connection = getVoiceConnection(guildId);
    if (!connection) {
      throw new Error(`Not connected to voice in guild ${guildId}`);
    }

    const resolvedPath = resolve(filePath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`Audio file not found: ${resolvedPath}`);
    }

    let player = this.players.get(guildId);
    if (!player) {
      player = createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Pause,
        },
      });
      this.players.set(guildId, player);
      connection.subscribe(player);
    }

    const resource = createAudioResource(createReadStream(resolvedPath), {
      inlineVolume: volume !== undefined,
    });

    if (volume !== undefined && resource.volume) {
      resource.volume.setVolume(volume);
    }

    player.play(resource);

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        player?.removeListener(AudioPlayerStatus.Idle, onIdle);
        player?.removeListener("error", onError);
      };

      const onIdle = () => {
        cleanup();
        resolve();
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      player!.once(AudioPlayerStatus.Idle, onIdle);
      player!.once("error", onError);
    });
  }

  /**
   * Stop playback.
   */
  stop(guildId: string): void {
    const player = this.players.get(guildId);
    if (player) {
      player.stop(true);
    }
  }

  /**
   * Leave voice channel.
   */
  leave(guildId: string): void {
    const player = this.players.get(guildId);
    if (player) {
      player.stop(true);
      this.players.delete(guildId);
    }

    const connection = getVoiceConnection(guildId);
    if (connection) {
      connection.destroy();
    }
  }

  /**
   * Check if connected to voice.
   */
  isConnected(guildId: string): boolean {
    const connection = getVoiceConnection(guildId);
    return connection !== undefined && connection.state.status !== VoiceConnectionStatus.Destroyed;
  }

  /**
   * Get current voice channel ID.
   */
  getChannelId(guildId: string): string | undefined {
    const connection = getVoiceConnection(guildId);
    if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
      return undefined;
    }
    return connection.joinConfig.channelId ?? undefined;
  }

  /**
   * Destroy the voice manager and disconnect all.
   */
  async destroy(): Promise<void> {
    for (const guildId of this.players.keys()) {
      this.leave(guildId);
    }
    await this.client.destroy();
    this.ready = false;
  }

  /**
   * Get the discord.js Guild object for a guild.
   */
  getGuild(guildId: string): Guild | undefined {
    return this.client.guilds.cache.get(guildId);
  }

  /**
   * Start listening to voice in a guild.
   * Transcribes user speech using Whisper and calls the callback.
   */
  async startListening(guildId: string, options: VoiceListenerOptions): Promise<void> {
    const connection = getVoiceConnection(guildId);
    if (!connection) {
      throw new Error(`Not connected to voice in guild ${guildId}`);
    }

    this.listenerOptions = options;
    const silenceThreshold = options.silenceThreshold ?? 1500;
    const minSpeechDuration = options.minSpeechDuration ?? 500;

    // Ensure temp directory exists
    await mkdir(this.tempDir, { recursive: true });

    const receiver = connection.receiver;

    // Track speaking users
    receiver.speaking.on("start", (userId) => {
      this.handleSpeakingStart(guildId, userId, connection, {
        silenceThreshold,
        minSpeechDuration,
      });
    });
  }

  private handleSpeakingStart(
    guildId: string,
    userId: string,
    connection: VoiceConnection,
    opts: { silenceThreshold: number; minSpeechDuration: number },
  ): void {
    // Skip if already listening to this user
    let guildListeners = this.activeListeners.get(guildId);
    if (!guildListeners) {
      guildListeners = new Set();
      this.activeListeners.set(guildId, guildListeners);
    }
    if (guildListeners.has(userId)) return;
    guildListeners.add(userId);

    const receiver = connection.receiver;
    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: opts.silenceThreshold,
      },
    });

    const chunks: Buffer[] = [];
    const startTime = Date.now();

    // Decode Opus to PCM
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    opusStream.pipe(decoder);

    decoder.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    decoder.on("end", () => {
      guildListeners?.delete(userId);

      const duration = Date.now() - startTime;
      if (duration < opts.minSpeechDuration || chunks.length === 0) {
        return; // Too short, ignore
      }

      // Process the audio
      this.processAudio(guildId, userId, chunks).catch((err) => {
        console.error(`[voice] Error processing audio for user ${userId}:`, err);
      });
    });

    decoder.on("error", (err: Error) => {
      console.error(`[voice] Decoder error for user ${userId}:`, err);
      guildListeners?.delete(userId);
    });

    opusStream.on("error", (err: Error) => {
      console.error(`[voice] Opus stream error for user ${userId}:`, err);
      guildListeners?.delete(userId);
    });
  }

  private async processAudio(guildId: string, userId: string, chunks: Buffer[]): Promise<void> {
    if (!this.listenerOptions) return;

    const connection = getVoiceConnection(guildId);
    const channelId = connection?.joinConfig.channelId ?? "";

    // Get username
    const guild = this.client.guilds.cache.get(guildId);
    let username = userId;
    if (guild) {
      try {
        const member = await guild.members.fetch(userId);
        username = member.displayName || member.user.username;
      } catch {
        // Keep userId as fallback
      }
    }

    // Combine chunks into PCM buffer
    const pcmBuffer = Buffer.concat(chunks);

    // Convert PCM to WAV
    const wavBuffer = this.pcmToWav(pcmBuffer, 48000, 2, 16);

    // Save to temp file
    const tempFile = join(this.tempDir, `${guildId}-${userId}-${Date.now()}.wav`);
    await writeFile(tempFile, wavBuffer);

    try {
      // Transcribe with Whisper
      const transcript = await this.transcribeWithWhisper(tempFile);

      const trimmedTranscript = transcript?.trim();
      if (trimmedTranscript && !isNoiseTranscript(trimmedTranscript)) {
        // Call the callback
        await this.listenerOptions.onTranscription(
          userId,
          username,
          trimmedTranscript,
          guildId,
          channelId,
        );
      }
    } finally {
      // Cleanup temp file
      try {
        await unlink(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  private pcmToWav(
    pcm: Buffer,
    sampleRate: number,
    channels: number,
    bitsPerSample: number,
  ): Buffer {
    const byteRate = (sampleRate * channels * bitsPerSample) / 8;
    const blockAlign = (channels * bitsPerSample) / 8;
    const dataSize = pcm.length;
    const headerSize = 44;
    const fileSize = headerSize + dataSize - 8;

    const header = Buffer.alloc(headerSize);

    // RIFF header
    header.write("RIFF", 0);
    header.writeUInt32LE(fileSize, 4);
    header.write("WAVE", 8);

    // fmt chunk
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20); // audio format (PCM)
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);

    // data chunk
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcm]);
  }

  private async transcribeWithWhisper(audioPath: string): Promise<string | null> {
    const apiKey = this.listenerOptions?.openaiApiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OpenAI API key not configured for Whisper transcription");
    }

    const formData = new FormData();
    const audioBuffer = await import("node:fs/promises").then((fs) => fs.readFile(audioPath));
    const audioBlob = new Blob([audioBuffer], { type: "audio/wav" });
    formData.append("file", audioBlob, "audio.wav");
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");

    if (this.listenerOptions?.language) {
      formData.append("language", this.listenerOptions.language);
    }

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Whisper API error: ${response.status} ${error}`);
    }

    type WhisperSegment = {
      text: string;
      no_speech_prob: number;
    };
    type WhisperVerboseResponse = {
      text: string;
      segments?: WhisperSegment[];
    };

    const result = (await response.json()) as WhisperVerboseResponse;

    // Filter by confidence: if no_speech_prob is too high, likely noise
    if (result.segments && result.segments.length > 0) {
      const avgNoSpeechProb =
        result.segments.reduce((sum, seg) => sum + (seg.no_speech_prob ?? 0), 0) /
        result.segments.length;

      // If average no_speech_prob > 0.5, likely not real speech
      if (avgNoSpeechProb > 0.5) {
        console.log(
          `[voice] Filtered low-confidence transcript (no_speech_prob: ${avgNoSpeechProb.toFixed(2)}): "${result.text}"`,
        );
        return null;
      }
    }

    return result.text;
  }

  /**
   * Stop listening to voice in a guild.
   */
  stopListening(guildId: string): void {
    const listeners = this.activeListeners.get(guildId);
    if (listeners) {
      listeners.clear();
      this.activeListeners.delete(guildId);
    }
  }

  /**
   * Check if listening is active.
   */
  isListening(guildId: string): boolean {
    return this.listenerOptions !== undefined && this.activeListeners.has(guildId);
  }
}

// Singleton instance for the gateway
let voiceManager: VoiceManager | undefined;

/**
 * Get or create the global VoiceManager instance.
 */
export function getVoiceManager(token?: string): VoiceManager | undefined {
  if (voiceManager) return voiceManager;
  if (!token) return undefined;
  voiceManager = new VoiceManager({ token });
  return voiceManager;
}

/**
 * Initialize the global VoiceManager.
 */
export async function initVoiceManager(token: string): Promise<VoiceManager> {
  if (voiceManager) {
    return voiceManager;
  }
  voiceManager = new VoiceManager({ token });
  await voiceManager.waitReady();
  return voiceManager;
}

/**
 * Destroy the global VoiceManager.
 */
export async function destroyVoiceManager(): Promise<void> {
  if (voiceManager) {
    await voiceManager.destroy();
    voiceManager = undefined;
  }
}

/**
 * Get all guild IDs with active voice connections.
 */
export function getActiveVoiceGuildIds(): string[] {
  if (!voiceManager) return [];
  const guildIds: string[] = [];
  // Use the players map to track connected guilds
  for (const [guildId] of (voiceManager as any).players) {
    if (voiceManager.isConnected(guildId)) {
      guildIds.push(guildId);
    }
  }
  return guildIds;
}

// Global active voice guild for auto-TTS
let activeVoiceGuildId: string | undefined;

export function setActiveVoiceGuild(guildId: string | undefined): void {
  activeVoiceGuildId = guildId;
}

export function getActiveVoiceGuild(): string | undefined {
  return activeVoiceGuildId;
}
