# Sift browser extension

The source manifest and `config.js` target local development. Always load or
publish a generated build from `dist/` for production.

## Development build

```sh
npm run build:dev
```

Load the generated `dist/` folder as an unpacked extension.

## Production build

```sh
SIFT_API_BASE_URL=https://api.example.com/api/v1 \
SIFT_WEBSITE_URL=https://app.example.com \
npm run build
```

The production build fails unless both URLs exist and use HTTPS. It generates
the precise API host permission and website bridge match instead of shipping
localhost access.

After the Chrome Web Store assigns the extension ID, configure the backend:

```text
CORS_ALLOWED_ORIGINS=https://app.example.com,chrome-extension://<extension-id>
```

For a stable ID in privately distributed/unpacked builds, provide Chrome's
public manifest key through `SIFT_EXTENSION_KEY` during the build. Do not put a
private signing key in this repository.
