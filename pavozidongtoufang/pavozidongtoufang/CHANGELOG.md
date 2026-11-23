# Changelog

## 0.2.0

- Added the full automation pipeline (`pavo_pipeline`): send → wait → download → extract last frame → next segment.
- Added first-frame chaining support (`pavo_send_frame`, `pavo_mode`) with per-segment `firstFrame` flags.
- Added watermark-free CDN download (`pavo_download`).
- Hardened browser control: per-segment fresh conversation, create-mode verification, settings guard (16:9 / 10s), busy (Stop button) detection, download source de-duplication.
- Added a chat action card with 紧急终止 / 继续 (emergency stop / resume) buttons.

## 0.1.0

- Initial release: persistent login browser, prompt queue, settings calibration, simple new-video loop, local send log.
