importScripts("config.js");

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") {
    // Don't stomp on an existing user's preferences (e.g. enabled: false,
    // or an already-connected token) on every extension update/reload —
    // only set defaults the very first time this extension is installed.
    return;
  }

  await chrome.storage.local.set({
    enabled: true,
    connected: false,
    siftToken: null,
    email: null,
  });
});

async function getStoredToken() {
  const { siftToken } = await chrome.storage.local.get("siftToken");
  return siftToken ?? null;
}

async function clearConnection() {
  await chrome.storage.local.set({
    siftToken: null,
    connected: false,
    email: null,
  });
}

async function apiFetch(path, options = {}) {
  const token = await getStoredToken();

  if (!token) {
    throw new Error("NOT_CONNECTED");
  }

  const response = await fetch(`${SIFT_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });

  if (response.status === 401) {
    // Token was revoked (e.g. from the website's own settings) or is
    // otherwise invalid. Reflect that locally immediately rather than keep
    // believing we're connected until the user notices something's broken.
    await clearConnection();
    throw new Error("UNAUTHORIZED");
  }

  if (!response.ok) {
    throw new Error(`REQUEST_FAILED_${response.status}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function connectWithToken(rawToken) {
  await chrome.storage.local.set({ siftToken: rawToken });

  try {
    const me = await apiFetch("/users/me");
    await chrome.storage.local.set({ connected: true, email: me.email });
  } catch (error) {
    console.error("Sift: failed to verify token after connecting:", error);
    await clearConnection();
  }
}

async function getExtensionState() {
  const { connected } = await chrome.storage.local.get({ connected: false });

  if (!connected) {
    return { connected: false };
  }

  try {
    const [me, summary] = await Promise.all([
      apiFetch("/users/me"),
      apiFetch("/bookmarks/summary"),
    ]);

    return {
      connected: true,
      email: me.email,
      inboxCount: summary.inboxCount,
      favoritesCount: summary.favoriteCount,
      recentSaves: (summary.recentBookmarks ?? []).slice(0, 5).map((b) => ({
        username: `@${b.tweet.authorUsername}`,
        text: b.tweet.text,
        url: b.tweet.url,
      })),
    };
  } catch (error) {
    console.error("Sift: failed to load extension state:", error);
    // apiFetch already cleared local connection state on a 401; for any
    // other failure (network, 500, etc.) we still report disconnected to
    // the UI rather than show stale/partial data.
    return { connected: false };
  }
}

async function saveBookmark(bookmark) {
  // Built explicitly field-by-field (rather than forwarding the raw
  // extracted object) so we only ever send exactly what
  // CreateBookmarkRequestDTO expects, even if content.js's extraction ever
  // picks up extra fields later.
  const body = {
    url: bookmark.url,
    tweetId: bookmark.tweetId,
    authorUsername: bookmark.authorUsername,
    authorName: bookmark.authorName,
    text: bookmark.text,
    createdAt: bookmark.createdAt,
  };

  await apiFetch("/bookmarks", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function disconnect() {
  const token = await getStoredToken();

  if (token) {
    // Raw token shape is sift_<tokenId>_<secret> — the id the revoke
    // endpoint wants is embedded in the token we already have.
    const parts = token.split("_");
    const tokenId = parts[1];

    try {
      if (tokenId) {
        await apiFetch(`/auth/tokens/${tokenId}/revoke`, { method: "POST" });
      }
    } catch (error) {
      // Best-effort: the user explicitly asked to disconnect on this device
      // right now, so we still clear local state even if the network call
      // failed. They can also revoke from the website's token list directly
      // if this request never reached the server.
      console.error(
        "Sift: revoke request failed, disconnecting locally anyway:",
        error,
      );
    }
  }

  await clearConnection();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "EXTENSION_TOKEN_RECEIVED") {
    connectWithToken(message.token).then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.type === "GET_EXTENSION_STATE") {
    getExtensionState().then(sendResponse);
    return true;
  }

  if (message.type === "SAVE_BOOKMARK") {
    saveBookmark(message.bookmark)
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        console.error("Sift: save bookmark failed:", error);
        sendResponse({ success: false, reason: error.message });
      });
    return true;
  }

  if (message.type === "DISCONNECT") {
    disconnect().then(() => sendResponse({ success: true }));
    return true;
  }
});
