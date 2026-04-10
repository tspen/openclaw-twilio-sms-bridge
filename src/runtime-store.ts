import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

export const { setRuntime: setTwilioSmsRuntime, getRuntime: getTwilioSmsRuntime } =
  createPluginRuntimeStore("Twilio SMS runtime not initialized");
