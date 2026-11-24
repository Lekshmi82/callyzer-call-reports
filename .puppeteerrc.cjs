// whatsapp-web.js uses Playwright's Chromium (see src/service.ts), so skip Puppeteer's own browser download.
module.exports = { skipDownload: true };
