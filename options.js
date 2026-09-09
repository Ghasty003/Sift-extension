async function loadSettings() {
  // "enabled" is deliberately per-browser only — never synced to the
  // backend, per product decision.
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  document.getElementById("enabled").checked = enabled;

  const state = await chrome.runtime.sendMessage({
    type: "GET_EXTENSION_STATE",
  });
  renderConnection(state);
}

function renderConnection(state) {
  const status = document.getElementById("connection-status");
  const account = document.getElementById("account-name");
  const disconnectBtn = document.getElementById("disconnect");

  if (state?.connected) {
    status.textContent = "● Connected";
    account.textContent = state.email ?? "—";
    disconnectBtn.hidden = false;
  } else {
    status.textContent = "○ Disconnected";
    account.textContent = "Not connected";
    disconnectBtn.hidden = true;
  }
}

loadSettings();

document.getElementById("enabled").addEventListener("change", async (event) => {
  await chrome.storage.local.set({
    enabled: event.target.checked,
  });
});

document.getElementById("disconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "DISCONNECT" });
  await loadSettings();
});

document.getElementById("open-dashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: SIFT_WEBSITE_URL });
});
