// Browser entry point for Thread's voice adapter (Vineet). See docs/voice.md.
export { createVoiceController, ThreadVoiceController, type VoiceOptions } from "./browser/controller.js";
export type { PlaybackEvent, PlaybackStopReason, PlayOptions, VoiceController, VoiceEvents } from "./types.js";
export type { AutoHintStatus } from "./core/autohint.js";
