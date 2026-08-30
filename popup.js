document.addEventListener("DOMContentLoaded", async () => {
  const state = await chrome.runtime.sendMessage({ type: "GET_EXTENSION_STATE" });
  render(state);
});

function render(state) {
  const connectView = document.getElementById("connect-view");
  const connectedView = document.getElementById("connected-view");
  const statusDot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");

  if (!state?.connected) {
    connectView.hidden = false;
    connectedView.hidden = true;
    statusDot.style.background = "var(--muted-foreground)";
    statusText.textContent = "Not connected";
    return;
  }

  connectView.hidden = true;
  connectedView.hidden = false;
  statusDot.style.background = "var(--success)";
  statusText.textContent = "Connected";

  document.getElementById("inbox-count").textContent = state.inboxCount ?? 0;
  document.getElementById("favorites-count").textContent = state.favoritesCount ?? 0;
  renderRecentSaves(state.recentSaves ?? []);
}

function renderRecentSaves(saves) {
  const container = document.getElementById("recent-saves");

  container.replaceChildren();

  if (!Array.isArray(saves)) {
    console.warn("Invalid recentSaves:", saves);
    return;
  }

  for (const save of saves) {
    const item = document.createElement("div");
    item.className = "save-item";

    const username = document.createElement("strong");
    username.textContent = save.username;

    const text = document.createElement("span");
    text.textContent = save.text;

    item.append(username, text);

    container.appendChild(item);
  }
}

document.getElementById("connect").addEventListener("click", () => {
  chrome.tabs.create({ url: `${SIFT_WEBSITE_URL}/connect-extension` });
  // The popup closes as soon as the new tab takes focus — that's normal
  // Chrome popup behavior, not a bug. Reopening the popup after approving
  // on the website re-runs DOMContentLoaded and picks up the new state.
});

document.getElementById("open-sift").addEventListener("click", () => {
  chrome.tabs.create({ url: SIFT_WEBSITE_URL });
});

document.getElementById("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
