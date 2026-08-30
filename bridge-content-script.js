// Runs only on the Sift website itself (see manifest.json content_scripts
// match pattern) — never on x.com. Listens for the one specific message
// ConnectExtension.tsx posts after a successful token creation, and relays
// it to the background service worker. The extension never touches the
// website's own JWT — only this resulting Sift API token.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  if (event.data?.type !== "SIFT_EXTENSION_TOKEN") return;

  chrome.runtime.sendMessage({
    type: "EXTENSION_TOKEN_RECEIVED",
    token: event.data.token,
  });
});
