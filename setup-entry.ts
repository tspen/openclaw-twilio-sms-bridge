import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { twilioSmsBridgePlugin } from "./src/channel.js";

export default defineSetupPluginEntry(twilioSmsBridgePlugin);
