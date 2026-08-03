const message = (ws, { data, platform }) => {
  const frame = JSON.parse(Buffer.from(data).toString());
  if (frame.type !== "fixture-publish") return;
  platform.publish("svelte4-floor", "roundtrip", frame.payload, { seq: false });
};
export {
  message
};
