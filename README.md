# Email OTP Autofill (Local)

Local helper + Chrome extension to fetch email one-time codes (OTP) from QQ Mail / Outlook and fill them into the current page via a hotkey.

## Components

- `agent/`: Local HTTP service on `127.0.0.1:17373` that connects to mailboxes and extracts OTP codes.
- `chrome-extension/`: Chrome MV3 extension (hotkey fill, popup, onboarding/options UI).

## Status

MVP in-progress: QQ via IMAP first, Outlook via OAuth device-code flow (Graph) next, with plugin-guided setup.

