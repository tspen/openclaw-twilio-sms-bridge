import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { twilioSmsBridgePlugin, registerTwilioSmsWebhook } from "./src/channel.js";
import { setTwilioSmsRuntime } from "./src/runtime-store.js";

export default defineChannelPluginEntry({
  id: "twilio-sms-bridge",
  name: "Twilio SMS Bridge",
  description: "Custom SMS channel plugin for OpenClaw via Twilio",
  plugin: twilioSmsBridgePlugin,
  setRuntime: setTwilioSmsRuntime,
  registerFull(api) {
    registerTwilioSmsWebhook(api);
  },
});
