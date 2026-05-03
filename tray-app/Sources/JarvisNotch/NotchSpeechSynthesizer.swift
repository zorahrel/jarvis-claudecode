import AVFoundation
import Foundation

/// Native TTS pipeline for the notch. Replaces the previous "router →
/// `say` → MP3 → fetch → <audio>" roundtrip with a direct call to
/// `AVSpeechSynthesizer`, which has three big advantages:
///
///   - Access to Siri-quality neural voices (Premium / Enhanced) that
///     `say -v` silently skips or misroutes to English variants.
///   - No MP3 file round trip → speech starts within ~80 ms of the
///     event landing instead of 500+ ms.
///   - Streaming friendly: you can call `speak` on every `message.chunk`
///     and AVSpeechSynthesizer will queue utterances seamlessly.
///
/// Voice selection order (when the caller doesn't pass a voice id):
///   1. Best quality it-IT voice (Premium → Enhanced → Default)
///   2. System default it-IT
///   3. Whatever the OS returns for the user's locale
@MainActor
final class NotchSpeechSynthesizer: NSObject {
    static let shared = NotchSpeechSynthesizer()

    private let synth = AVSpeechSynthesizer()
    private var cachedVoice: AVSpeechSynthesisVoice?

    override init() {
        super.init()
        synth.delegate = self
    }

    /// Speak `text`. If a current utterance is still in progress this
    /// utterance is appended to the queue — so calling `speak()` once
    /// per LLM chunk gives you smooth streaming playback.
    func speak(_ text: String, voiceId: String? = nil) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let utterance = AVSpeechUtterance(string: trimmed)
        if let voiceId, let explicit = AVSpeechSynthesisVoice(identifier: voiceId) {
            utterance.voice = explicit
        } else {
            utterance.voice = cachedVoice ?? Self.resolveBestItalianVoice()
            if cachedVoice == nil { cachedVoice = utterance.voice }
        }
        // Default rate is a touch too fast for conversational speech; nudge
        // it down. Pitch left at 1.0 — Siri voices already sound natural.
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.95
        utterance.pitchMultiplier = 1.0
        utterance.preUtteranceDelay = 0.0
        utterance.postUtteranceDelay = 0.0

        synth.speak(utterance)
        NotchLogger.shared.log("info",
            "[tts] speak chars=\(trimmed.count) voice=\(utterance.voice?.identifier ?? "default") rate=\(utterance.rate)")
    }

    /// Drop whatever is currently speaking and flush the queue. Called
    /// when the user starts a new hover-record session so Jarvis doesn't
    /// talk over the mic.
    func stop() {
        if synth.isSpeaking {
            synth.stopSpeaking(at: .immediate)
        }
    }

    /// True while AVSpeechSynthesizer has an utterance playing or queued.
    /// Used by NotchController.handleVADSpeechStart() to decide if a
    /// Silero VAD trigger should be treated as a hard barge-in (TTS active)
    /// or just an idle "user is speaking" hint.
    func isSpeaking() -> Bool {
        return synth.isSpeaking
    }

    // MARK: - Voice selection

    static func resolveBestItalianVoice() -> AVSpeechSynthesisVoice? {
        let allVoices = AVSpeechSynthesisVoice.speechVoices()
        let italian = allVoices.filter { $0.language == "it-IT" }
        if italian.isEmpty {
            NotchLogger.shared.log("warn", "[tts] no it-IT voice installed")
            return AVSpeechSynthesisVoice(language: "it-IT")
        }
        // Premium (Siri-quality, macOS 15+) → Enhanced (Siri novelty voices
        // like Eddy, Flo, Sandy — already much better than default) →
        // Default (legacy Alice).
        if let premium = italian.first(where: { $0.quality == .premium }) {
            return premium
        }
        if let enhanced = italian.first(where: { $0.quality == .enhanced }) {
            return enhanced
        }
        return italian.first
    }

    /// Debug helper — lists every it-IT voice available with quality
    /// tier so we can log the best match at boot.
    static func listItalianVoices() -> [String] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language == "it-IT" }
            .map { v in "\(v.name) [\(qualityTag(v.quality))] id=\(v.identifier)" }
    }

    private static func qualityTag(_ q: AVSpeechSynthesisVoiceQuality) -> String {
        switch q {
        case .premium: return "premium"
        case .enhanced: return "enhanced"
        case .default: return "default"
        @unknown default: return "unknown"
        }
    }
}

extension NotchSpeechSynthesizer: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        NotchLogger.shared.log("info", "[tts] didStart chars=\(utterance.speechString.count)")
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        NotchLogger.shared.log("info", "[tts] didFinish chars=\(utterance.speechString.count)")
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        NotchLogger.shared.log("info", "[tts] cancelled")
    }
}
