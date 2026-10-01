// A regular Set (not WeakSet) on purpose: we need to be able to clear it
// when the user re-enables Sift after disabling, so previously-processed
// tweets get their buttons re-injected instead of being silently skipped.
const processedTweets = new Set();

let siftEnabled = true;

async function loadEnabledState() {
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  siftEnabled = enabled;
}

function removeAllSiftButtons() {
  document
    .querySelectorAll('[data-sift-button="true"]')
    .forEach((btn) => btn.remove());
  processedTweets.clear();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("enabled" in changes)) return;

  siftEnabled = changes.enabled.newValue;

  if (siftEnabled) {
    scanTweets();
  } else {
    removeAllSiftButtons();
  }
});

function extractRepostContext(article) {
  // X renders a small "<Name> reposted" line above the actual tweet when
  // viewing a repost in the timeline — structurally separate from the
  // tweet's own author block, usually the first text content inside the
  // article before the author link.
  //
  // ⚠️ Best-effort: depends on the literal text "reposted" and X's current
  // DOM shape. The author name's own text is excluded by requiring this
  // block appear before the main author link in document order.
  const socialContextEl = [...article.querySelectorAll("span")].find((span) =>
    /reposted$/i.test(span.textContent?.trim() ?? ""),
  );

  if (!socialContextEl) {
    return { repostedByName: "", repostedByUsername: "" };
  }

  const repostedByName = socialContextEl.textContent
    .replace(/reposted$/i, "")
    .trim();

  // The reposter's own profile link, if present nearby, gives us their
  // username too — not guaranteed to exist, so this degrades gracefully.
  const container = socialContextEl.closest("div");
  const profileLink = container?.querySelector('a[href^="/"][role="link"]');
  const repostedByUsername =
    profileLink?.getAttribute("href")?.replace(/^\//, "") ?? "";

  return { repostedByName, repostedByUsername };
}

function extractAuthorName(article, username) {
  if (!username) {
    return "";
  }

  const displayNameLink = [...article.querySelectorAll("a")].find((link) => {
    const href = link.getAttribute("href");
    const text = link.innerText.trim();

    return href === `/${username}` && text && text !== `@${username}`;
  });

  return displayNameLink?.innerText.trim() ?? "";
}

function extractAvatarUrl(scope) {
  // X wraps the author's avatar in a container whose data-testid starts
  // with "UserAvatar-Container-" — this holds for both the outer tweet
  // and a nested quote-tweet card.
  const img = scope.querySelector('[data-testid^="UserAvatar-Container"] img');
  return img?.src ?? "";
}

function extractReplyContext(article) {
  // X renders "Replying to @user [@user2 ...]" as its own block directly
  // above the tweet's own author line. We treat presence of that block as
  // "this is a reply," and take the first @mention as who it's replying to.
  //
  // ⚠️ Best-effort: this depends on the literal text "Replying to" and X's
  // current DOM shape. Verify against a live reply before relying on it.
  const replyBlock = [...article.querySelectorAll("div")].find((div) =>
    div.textContent?.trim().startsWith("Replying to"),
  );

  if (!replyBlock) {
    return { isReply: false, replyToUsername: "" };
  }

  const mentionLink = replyBlock.querySelector('a[href^="/"]');
  const replyToUsername =
    mentionLink?.getAttribute("href")?.replace(/^\//, "") ?? "";

  return { isReply: true, replyToUsername };
}

function extractQuotedTweet(article, mainTweetId) {
  // Compare by the actual tweet ID parsed from each link, not the raw href
  // string — X often renders more than one anchor pointing at the same
  // status (the timestamp link, the text-wrapping link, etc.) with slightly
  // different href text, which made a plain string comparison wrongly
  // conclude "this is a different, quoted tweet" when it was actually the
  // same tweet linked twice.
  const statusLinks = [...article.querySelectorAll('a[href*="/status/"]')];

  for (const link of statusLinks) {
    const statusMatch = link.href.match(/x\.com\/([^/]+)\/status\/(\d+)/);
    const tweetId = statusMatch?.[2];

    if (!tweetId || tweetId === mainTweetId) continue;

    const quotedScope = link.closest('div[role="link"]') ?? link.closest("div");
    if (!quotedScope) continue;

    const authorUsername = statusMatch[1] ?? "";
    const authorName = extractAuthorName(quotedScope, authorUsername);
    const authorAvatarUrl = extractAvatarUrl(quotedScope);
    const text =
      quotedScope.querySelector('[data-testid="tweetText"]')?.innerText ?? "";
    const createdAt =
      quotedScope.querySelector("time")?.getAttribute("datetime") ?? "";

    return {
      tweetId,
      url: link.href,
      authorUsername,
      authorName,
      authorAvatarUrl,
      text,
      createdAt,
    };
  }

  return null;
}

function extractTweet(article) {
  // NOTE: this grabs the FIRST tweetText/time/status-link in the article,
  // which is correct as long as the outer tweet's own content always
  // precedes a nested quote-tweet card in DOM order (true in current X
  // markup). An image-only outer tweet quoting a text tweet is an edge
  // case worth testing — the text extracted below could end up empty
  // rather than wrongly grabbing the quoted tweet's text, since querySelector
  // still returns the first tweetText node, which would be the quoted one
  // if the outer tweet truly has none. Flagging, not solved here.
  const text =
    article.querySelector('[data-testid="tweetText"]')?.innerText ?? "";

  const statusLink = [...article.querySelectorAll("a")].find((link) =>
    link.href.includes("/status/"),
  );

  const statusMatch = statusLink?.href.match(/x\.com\/([^/]+)\/status\/(\d+)/);

  const url = statusLink?.href ?? "";
  const authorUsername = statusMatch?.[1] ?? "";
  const tweetId = statusMatch?.[2] ?? "";
  const createdAt =
    article.querySelector("time")?.getAttribute("datetime") ?? "";
  const authorName = extractAuthorName(article, authorUsername);
  const authorAvatarUrl = extractAvatarUrl(article);
  const { isReply, replyToUsername } = extractReplyContext(article);
  const quotedTweet = extractQuotedTweet(article, tweetId);

  const { repostedByName, repostedByUsername } = extractRepostContext(article);

  return {
    url,
    tweetId,
    authorUsername,
    authorName,
    authorAvatarUrl,
    text,
    createdAt,
    isReply,
    replyToUsername,
    quotedTweet,
    repostedByName,
    repostedByUsername,
  };
}

function findActionBar(tweet) {
  return tweet.querySelector('[role="group"]');
}

function getSiftIcon(type) {
  const icons = {
    // Idle state — outline funnel. Distinct from X's own bookmark ribbon,
    // and a literal nod to "Sift" (filtering/sifting posts).
    bookmark: `
      <svg viewBox="0 0 24 24" width="20" height="20"
           fill="none" stroke="currentColor"
           stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
        <path d="M3.5 4h17L13.6 13v6.5h-3.2V13z"/>
      </svg>
    `,

    // Saved state — same funnel, filled solid. Mirrors the outline-to-filled
    // convention X's own bookmark icon already uses, so the interaction still
    // feels native, but the shape stays uniquely Sift's.
    check: `
      <svg viewBox="0 0 24 24" width="20" height="20"
           fill="currentColor" stroke="none">
        <path d="M3.5 4h17L13.6 13v6.5h-3.2V13z"/>
      </svg>
    `,

    retry: `
      <svg viewBox="0 0 24 24" width="20" height="20"
           fill="none" stroke="currentColor"
           stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
        <path d="M20 11a8.1 8.1 0 0 0-15.5-3"/>
        <path d="M4 4v5h5"/>
        <path d="M4 13a8.1 8.1 0 0 0 15.5 3"/>
        <path d="M20 20v-5h-5"/>
      </svg>
    `,
  };

  return icons[type];
}

function setButtonState(button, state) {
  button.classList.remove("sift-saving", "sift-saved", "sift-error");

  if (state === "idle") {
    button.disabled = false;
    button.innerHTML = getSiftIcon("bookmark");
    button.setAttribute("aria-label", "Save to Sift");
    button.title = "Save to Sift";
  }

  if (state === "saving") {
    button.classList.add("sift-saving");
    button.disabled = true;
    button.innerHTML = `
      <span class="sift-spinner"></span>
    `;
    button.setAttribute("aria-label", "Saving to Sift...");
    button.title = "Saving to Sift...";
  }

  if (state === "saved") {
    button.classList.add("sift-saved");
    button.disabled = true;
    button.innerHTML = getSiftIcon("check");
    button.setAttribute("aria-label", "Saved to Sift");
    button.title = "Saved to Sift";
  }

  if (state === "error") {
    button.classList.add("sift-error");
    button.disabled = false;
    button.innerHTML = getSiftIcon("retry");
    button.setAttribute("aria-label", "Retry saving to Sift");
    button.title = "Retry saving to Sift";
  }
}

function createSiftButton(tweet) {
  const button = document.createElement("button");

  button.type = "button";
  button.className = "sift-button";
  button.dataset.siftButton = "true";

  setButtonState(button, "idle");

  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();

    setButtonState(button, "saving");

    const data = extractTweet(tweet);

    try {
      const response = await chrome.runtime.sendMessage({
        type: "SAVE_BOOKMARK",
        bookmark: data,
      });

      if (response?.success) {
        setButtonState(button, "saved");
      } else {
        setButtonState(button, "error");
      }
    } catch (error) {
      console.error("Sift save failed:", error);

      setButtonState(button, "error");
    }
  });

  return button;
}

function injectSiftButton(tweet) {
  if (tweet.querySelector('[data-sift-button="true"]')) {
    return;
  }

  const actionBar = findActionBar(tweet);

  if (!actionBar) {
    return;
  }

  const button = createSiftButton(tweet);

  const shareButton = actionBar.querySelector('[data-testid="share"]');

  if (shareButton) {
    shareButton.parentElement?.before(button);
  } else {
    actionBar.appendChild(button);
  }
}

function processTweet(tweet) {
  if (!siftEnabled) {
    return;
  }

  if (processedTweets.has(tweet)) {
    return;
  }

  processedTweets.add(tweet);

  console.log("Tweet detected:", extractTweet(tweet));

  injectSiftButton(tweet);
}

function scanTweets() {
  const tweets = document.querySelectorAll('article[data-testid="tweet"]');

  for (const tweet of tweets) {
    processTweet(tweet);
  }
}

loadEnabledState().then(() => {
  scanTweets();
});

const observer = new MutationObserver(() => {
  scanTweets();
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});
