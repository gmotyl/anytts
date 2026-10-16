export { createTts } from "./tts.js";
export type { SynthesisRequest, SynthesisResult, Tts, TtsConfig, TtsEvent, TtsListener, EngineConfig } from "./tts.js";
export type { SchedulerConfig } from "./scheduler.js";
export { TtsError, isTransient } from "./errors.js";
export type { TtsErrorKind } from "./errors.js";
export type { EdgeEngineOptions } from "./engines/edge/engine.js";
export { resolveVoice } from "./voices.js";
export { listEngines, listVoices } from "./engines/registry.js";
export type { VoiceInfo, EngineInfo } from "./engines/registry.js";
