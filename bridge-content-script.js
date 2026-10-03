// Runs only on the Sift website itself (see manifest.json content_scripts
// match pattern) — never on x.com. Listens for the one specific message
// ConnectExtension.tsx posts after a successful token creation, and relays
// it to the background service worker. The extension never touches the
// website's own JWT — only this resulting Sift API token.
window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  if (event.data?.type !== "SIFT_EXTENSION_TOKEN") return;
  if (typeof event.data.token !== "string") return;
  if (typeof event.data.requestId !== "string") return;

  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: "EXTENSION_TOKEN_RECEIVED",
      token: event.data.token,
    });
  } catch (error) {
    result = { success: false, reason: error.message };
  }

  window.postMessage(
    {
      type: "SIFT_EXTENSION_TOKEN_RESULT",
      requestId: event.data.requestId,
      success: result?.success === true,
      reason: result?.reason,
    },
    window.location.origin,
  );
});
