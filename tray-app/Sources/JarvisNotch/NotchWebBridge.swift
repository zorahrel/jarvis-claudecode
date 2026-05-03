import WebKit

// MARK: - JS bridge

/// Receives messageHandlers.jarvis.postMessage({type: …}) calls from the
/// webview. Handles `{type: 'collapse'}` (Escape key) and `{type: 'log', …}`
/// (console + error forwarding for the debug channel), plus VAD events,
/// audio lifecycle, voice partial transcripts, etc.
///
/// Acts also as the WKNavigationDelegate so we can self-heal a dead web
/// content process (`webViewWebContentProcessDidTerminate`) and log every
/// nav transition for the orb-loading debug channel.
final class NotchWebBridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let onCollapse: () -> Void
    let onLog: (String, String) -> Void
    let onVoiceStart: () -> Void
    let onVoiceStop: () -> Void
    let onInputChange: (Bool) -> Void
    let onHoverRecordToggle: (Bool) -> Void
    init(
        onCollapse: @escaping () -> Void,
        onLog: @escaping (String, String) -> Void,
        onVoiceStart: @escaping () -> Void,
        onVoiceStop: @escaping () -> Void,
        onInputChange: @escaping (Bool) -> Void,
        onHoverRecordToggle: @escaping (Bool) -> Void
    ) {
        self.onCollapse = onCollapse
        self.onLog = onLog
        self.onVoiceStart = onVoiceStart
        self.onVoiceStop = onVoiceStop
        self.onInputChange = onInputChange
        self.onHoverRecordToggle = onHoverRecordToggle
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        switch type {
        case "collapse":
            Task { @MainActor in self.onCollapse() }
        case "log":
            let level = (body["level"] as? String) ?? "log"
            let text = (body["text"] as? String) ?? ""
            onLog(level, text)
        case "voiceStart":
            Task { @MainActor in self.onVoiceStart() }
        case "voiceStop":
            Task { @MainActor in self.onVoiceStop() }
        case "inputChange":
            let hasText = (body["hasText"] as? Bool) ?? false
            Task { @MainActor in self.onInputChange(hasText) }
        case "setHoverRecord":
            let on = (body["on"] as? Bool) ?? false
            Task { @MainActor in self.onHoverRecordToggle(on) }
        case "audioLifecycle":
            // JS reports `audio` element start/end so the Swift side can
            // suppress STT during TTS playback (barge-in protection).
            let phase = (body["phase"] as? String) ?? ""
            Task { @MainActor in
                NotchController.shared.setAssistantSpeaking(phase == "start")
                let isStart = (phase == "start")
                NotchController.shared.assistantAudioPlaying = isStart
                NotchLogger.shared.log("info", "[audioLifecycle] \(phase)")
                // Safety auto-reset: if 'end' never arrives, force-clear
                // after assistantSpeakingMaxDuration. Otherwise stuck flag
                // locks out future logic that reads it.
                NotchController.shared.assistantSpeakingResetTimer?.invalidate()
                if isStart {
                    NotchController.shared.assistantSpeakingResetTimer = Timer.scheduledTimer(
                        withTimeInterval: NotchTuning.assistantSpeakingMaxDuration,
                        repeats: false
                    ) { _ in
                        Task { @MainActor in
                            if NotchController.shared.assistantAudioPlaying {
                                NotchLogger.shared.log("warn", "[audioLifecycle] safety auto-reset — 'end' never arrived")
                                NotchController.shared.assistantAudioPlaying = false
                                NotchController.shared.setAssistantSpeaking(false)
                            }
                        }
                    }
                } else {
                    NotchController.shared.assistantSpeakingResetTimer = nil
                }
            }
        case "voicePartial":
            // Live SFSpeechRecognizer transcript while the user is talking.
            // Mirror it under the system notch as a peek panel so the
            // words remain visible even while the chat log is offscreen
            // (compact mode) or behind the orb (expanded). Empty text →
            // dismiss any active peek (end-of-utterance signal from JS).
            let text = (body["text"] as? String) ?? ""
            Task { @MainActor in
                if text.isEmpty {
                    NotchController.shared.dismissPeek()
                } else if !NotchController.shared.isExpanded {
                    NotchController.shared.showMessagePeek(role: .user, text: text)
                }
            }
        case "vad.speechStart":
            // Silero VAD ha rilevato l'inizio del parlato dell'utente.
            // Se il TTS sta playing → barge-in: stop AVSpeech locale +
            // notify il router (via /api/notch/barge) per cancellare la
            // riga in-flight + emettere audio.stop al WebView.
            // Se nessun TTS attivo → semplice "user is speaking" hint
            // per accelerare lo state.change.
            Task { @MainActor in
                NotchController.shared.handleVADSpeechStart()
            }
        case "vad.speechEnd":
            // Silero ha rilevato la fine dell'utterance — accelera il flush
            // dello StreamingRecorder, bypassando il suo silence-detection
            // RMS-based che ha threshold 1.5s. UX più snappy.
            Task { @MainActor in
                NotchController.shared.handleVADSpeechEnd()
            }
        case "vad.ready", "vad.paused", "vad.resumed", "vad.stopped":
            NotchLogger.shared.log("debug", "[vad] state=\(type)")
        case "vad.error":
            let msg = (body["data"] as? [String: Any])?["message"] as? String ?? "?"
            NotchLogger.shared.log("warn", "[vad] error: \(msg)")
        default:
            break
        }
    }

    // MARK: WKNavigationDelegate — log everything that happens.

    func webView(_ w: WKWebView, didStartProvisionalNavigation nav: WKNavigation!) {
        onLog("info", "[nav] didStart \(w.url?.absoluteString ?? "?")")
    }
    func webView(_ w: WKWebView, didCommit nav: WKNavigation!) {
        onLog("info", "[nav] didCommit \(w.url?.absoluteString ?? "?")")
    }
    func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
        onLog("info", "[nav] didFinish \(w.url?.absoluteString ?? "?")")
    }
    func webView(_ w: WKWebView, didFail nav: WKNavigation!, withError error: Error) {
        onLog("error", "[nav] didFail \(error.localizedDescription)")
        scheduleReload(w, delay: 1.5, reason: "didFail")
    }
    func webView(_ w: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
        onLog("error", "[nav] didFailProvisional \(error.localizedDescription)")
        scheduleReload(w, delay: 1.5, reason: "didFailProvisional")
    }

    /// WebKit kills the WebContent process under memory/GPU pressure, after
    /// long sleeps, and occasionally after display-config changes. The
    /// previous stub here had the wrong selector signature — WebKit silently
    /// never invoked it, so the WebView stayed blank ("notch nero") until
    /// the user relaunched the app. Reload immediately to recover.
    func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
        onLog("error", "[nav] webContent process terminated — reloading")
        scheduleReload(w, delay: 0.0, reason: "processTerminated")
    }

    private func scheduleReload(_ w: WKWebView, delay: TimeInterval, reason: String) {
        Task { @MainActor in
            if delay > 0 { try? await Task.sleep(for: .milliseconds(Int(delay * 1000))) }
            // Prefer reloading the original URL — `reload()` is a no-op when
            // the previous load never committed (e.g. router was down at
            // boot), which is exactly the case we need to recover from.
            let remote = NotchEndpoints.orbHTML
            self.onLog("info", "[nav] reload (\(reason)) → \(remote)")
            w.load(URLRequest(url: remote))
        }
    }
}
