const CHANNEL_NAME = "tts-desktop-preview";

export function createPreviewChannel() {
  return new BroadcastChannel(CHANNEL_NAME);
}

export function publishPreviewState(channel, payload) {
  channel.postMessage(payload);
}
