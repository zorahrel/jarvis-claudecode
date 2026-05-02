# Jarvis — TODO & Roadmap

## Done
- [x] ChromaDB server (:3342) — doc RAG
- [x] OMEGA server (:3343) — conversation memory
- [x] Dashboard Memory section (search, docs, memories, stats, 3D force graph)
- [x] Voice/images/files on all channels (Telegram, WhatsApp, Discord)
- [x] Quoted messages context
- [x] Native LaunchAgents (router, chroma, omega)
- [x] macOS tray app (SwiftUI popover, SF Symbols, health checks)
- [x] Vision via Claude content blocks
- [x] Per-route configurable MCP
- [x] Visible/editable capabilities per route
- [x] Dashboard Services section (live health checks)
- [x] CLI session tracking via hooks
- [x] Health endpoint: `GET /api/services`
- [x] Bidirectional file upload — Claude Write/Edit → auto-sent as attachment
- [x] Secrets in `.env` — keys out of source
- [x] YAML config env interpolation — `$ENV_VAR` expanded automatically
- [x] Dashboard React SPA (replaced inline Alpine.js)
- [x] Memory v2 UI: view mode toggle Graph/List/Grid, scope chips, quick-add modal, keyboard shortcuts
- [x] Memory v2: Related panel in preview (top-5 semantically similar docs)
- [x] Semantic search: word highlight, skeleton loading, click-to-open document
- [x] Skills marketplace (`~/jarvis/skills-marketplace/`) — lets remote-channel agents create skills
- [x] Dashboard drill-downs + unified tooltips (portaled `Tooltip`, shared primitives)
- [x] Dashboard WebSocket activity stream (`/ws`) — push updates with polling fallback
- [x] Telegram slash-command menu — publishes Claude Code commands to Telegram's native `/`-menu
- [x] Cron jobs runtime: schedule Claude tasks from `config.yaml` with channel delivery (JSONL run history, agent-inherited config, ASCII footer, conversation-cache seeding)
- [x] Router hardening — proactive notify endpoint, Discord mention/multi-speaker hygiene, connector boot retry, log redaction, rate-limit + dedup (PR #8 + follow-ups #9-#17)
- [x] SDK migration — backend Claude su `@anthropic-ai/claude-agent-sdk` (typed event stream, compaction nativa, hooks API). `claude-cli.ts` rimosso. Audit in `.planning/audit/sdk-*.md`
- [x] Per-agent session isolation + `additionalDirectories` per media access (sicurezza guild Discord multi-agent)
- [x] WhatsApp quoted-media download (replies "trascrivi"/"riassumi" ora processano l'allegato citato)
- [x] MCP hot-reload — modifiche al fcache vengono recepite mid-turn senza restart router

## In Progress
- [ ] Tray popover positioning (multi-display)
- [ ] Tray status refresh after start/stop (more responsive)

## Notch / Tray app — outstanding from session 2026-04-22 → 2026-04-26

### Done in session
- [x] Notch chat history persistente (JSONL `~/.claude/jarvis/state/notch-history.jsonl`)
- [x] Notch TTS auto-trigger via SSE `audio.play`
- [x] Notch hover-to-record (OFF di default) — dwell 400ms, VAD silence 1.5s, cooldown 800ms
- [x] Notch prefs JSON persistenti (`tts`, `hoverRecord`, `mute`)
- [x] Toolbar 3-toggle nel notch.html
- [x] StreamingRecorder + VoiceRecorder refactor (HW format raw + afconvert in stop) — fix `CAAssertRtn` macOS 26.x
- [x] Phantom-ship guard: `streamRecorder.hadVoice` → niente upload se VAD non sente nulla
- [x] Whisper-cli: model path corretto + `-l it -nt` (non più `models/ggml-base.en.bin`)
- [x] TTS footer strip (telemetry `[t … | tok … | agent/model]` non parlato)
- [x] Agente notch: da `fullAccess: true` a `fileAccess:readonly` (no edit accidentali da dictation)
- [x] Two-process app: `JarvisTray.app` (menubar) + `JarvisNotch.app` (notch), supervisor con SIGTERM/respawn
- [x] swift-bundler + Bundler.toml + entitlements per i due target
- [x] `make-app.sh --install` → build + ad-hoc sign + install in `/Applications`
- [x] `LSUIElement: true` + `NSMicrophoneUsageDescription` + bundle id `io.armonia.jarvis.{tray,notch}`
- [x] `NSApp.setActivationPolicy(.accessory)` forced via `NSApplicationDelegateAdaptor` (era invisibile)
- [x] Static path orb: router serve `/notch/orb/*` da `Sources/JarvisNotch/Orb/*`
- [x] TTS engine MLX Voxtral 4B IT (mlx-community/Voxtral-4B-TTS-2603-mlx-4bit) come primary, fallback Kokoro → say
  - Wrapper `router/scripts/tts-mlx.py`, integrato in `router/src/services/tts.ts` con priority `mlx → kokoro → say`
  - Voce default `it_male`; cambiabile via env `JARVIS_TTS_MLX_VOICE`
  - RTF ~1.34x su M-series, peak RAM ~2.8GB
  - Deps installate user-scope: `pip install --user --break-system-packages mlx-audio tiktoken mistral-common`
- [x] AVSpeechSynthesizer Swift-native (`NotchSpeechSynthesizer.swift`) come secondary path via SSE `tts.speak` event
- [x] Dashboard mirror NON suona (evita doppia voce)

### TODO concreti rimanenti
- [ ] **Streaming risposta LLM nel notch** — handler.ts patch per `--output-format stream-json`, emit SSE `message.chunk`, UI append progressivo, AVSpeechSynthesizer consuma chunks come arrivano
- [ ] **Feedback UI completi nel notch chat** — bubble "sto scrivendo…" mentre attende, indicator "registrazione/trascrizione/risposta" con stato visivo
- [ ] **Voci Apple Premium**: documentare nel SETUP.md come installarle (System Settings → Accessibility → Spoken Content → Manage Voices → cerca Italian → Alice/Federica Premium). Picker già esistente in `NotchSpeechSynthesizer.resolveBestItalianVoice()` le sceglierà automaticamente
- [ ] **Notch login item** via `SMAppService.mainApp.register()` (Fase 7 piano originale) — toggle in popover, JarvisTray spawna JarvisNotch automaticamente. Già parzialmente fatto via `NotchProcessController` ma manca il register/unregister dal menubar
- [ ] **Sparkle 2.x + GitHub Releases** (Fase 8 piano originale) — appcast, EdDSA keys, `.github/workflows/release.yml` su `git tag v*`, ad-hoc sign senza notarization. **Decisione confermata: ad-hoc sign, no Apple Developer ID**
- [ ] **TTS chunking per testi lunghi** — Voxtral genera in 1 colpo, blocca per ~3s. Spezzare la risposta su `. ! ?` e generare per frase, accodare in `<audio>` o usare `--stream` di mlx-audio
- [ ] **Notch UI streaming waveform** — `window.__notchPartialLevel(level)` dal Swift chiama un waveform live ma manca il rendering JS che usa `level`
- [ ] **Voce alternativa**: provare KugelAudio 7B (SOTA EU 2026, no MLX port quantizzato ad oggi) o Chatterbox MLX (`mlx-community/Chatterbox-TTS-4bit`) come comparison qualitativo

### Decisioni prese da non rimettere in discussione
- **Niente Apple Developer ID** ($99/anno) — uso personale, ad-hoc sign basta
- **Niente Homebrew cask** — Sparkle copre tutto da solo per single-user
- **Hardened runtime OFF** — incompatibile con `DynamicNotchKit FluidSpringAnimation` su macOS 26.x. Da riabilitare solo con Apple Developer ID + notarization
- **Hover-record OFF di default** — UX troppo accident-prone come default (cursore che attraversa il notch verso menubar)
- **Notch agent `fileAccess:readonly`** — dictation poteva editare file inavvertitamente
- **TTS engine priority**: MLX Voxtral > Kokoro > say (lato router); AVSpeechSynthesizer è path manuale via `tts.speak` SSE
- **Voxtral over Chatterbox**: Voxtral 4B 4bit verificato funzionante con `it_male`, MLX-nativo. Chatterbox MLX disponibile come secondo step se la qualità Voxtral non basta

## Next Up
- [ ] Sub-agents from chat — "do X in background" → spawn Claude task
- [ ] Log rotation for service logs
- [ ] Periodic config.yaml backup
- [ ] Extended config-driven services (the `services:` section in config.yaml is already wired in)

## Future
- [ ] Auto-update Claude CLI
- [ ] Dashboard auth (when exposed outside tailscale/LAN)
- [ ] Location-aware responses

## Known Issues
- Tray popover appears far from the icon on multi-display
- WhatsApp "Bad MAC" errors (normal reconnection, not a bug)
