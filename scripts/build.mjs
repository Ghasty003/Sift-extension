import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "dist");
const mode = process.argv[2] ?? "production";
const production = mode === "production";

if (!production && mode !== "development") {
  throw new Error(`Unknown build mode: ${mode}`);
}

const apiBaseUrl = readUrl(
  "SIFT_API_BASE_URL",
  production ? undefined : "http://localhost:8080/api/v1",
);
const websiteUrl = readUrl(
  "SIFT_WEBSITE_URL",
  production ? undefined : "http://localhost:8443",
);

if (production && (apiBaseUrl.protocol !== "https:" || websiteUrl.protocol !== "https:")) {
  throw new Error("Production API and website URLs must use HTTPS");
}

const manifest = JSON.parse(
  await readFile(path.join(root, "manifest.json"), "utf8"),
);

manifest.host_permissions = [`${apiBaseUrl.origin}/*`];

const bridgeScript = manifest.content_scripts.find((entry) =>
  entry.js?.includes("bridge-content-script.js"),
);

if (!bridgeScript) {
  throw new Error("Bridge content-script entry is missing from manifest.json");
}

bridgeScript.matches = [`${websiteUrl.origin}/*`];

if (process.env.SIFT_EXTENSION_KEY) {
  manifest.key = process.env.SIFT_EXTENSION_KEY;
} else {
  delete manifest.key;
}

const files = [
  "bridge-content-script.js",
  "content.js",
  "icon-16.png",
  "icon-32.png",
  "icon-48.png",
  "icon-128.png",
  "options.css",
  "options.html",
  "options.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "service-worker.js",
  "sift-button.css",
];

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await Promise.all(
  files.map((file) =>
    copyFile(path.join(root, file), path.join(outputDirectory, file)),
  ),
);

await writeFile(
  path.join(outputDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await writeFile(
  path.join(outputDirectory, "config.js"),
  [
    `const SIFT_API_BASE_URL = ${JSON.stringify(trimTrailingSlash(apiBaseUrl.href))};`,
    `const SIFT_WEBSITE_URL = ${JSON.stringify(trimTrailingSlash(websiteUrl.href))};`,
    "",
  ].join("\n"),
);

console.log(`Built ${mode} extension in ${outputDirectory}`);
console.log(`Website: ${trimTrailingSlash(websiteUrl.href)}`);
console.log(`API: ${trimTrailingSlash(apiBaseUrl.href)}`);

function readUrl(name, fallback) {
  const value = process.env[name] || fallback;
  if (!value) {
    throw new Error(`${name} is required for a production extension build`);
  }

  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, a query, or a hash`);
  }
  return url;
}

function trimTrailingSlash(value) {
  return value.replace(/\/$/, "");
}
