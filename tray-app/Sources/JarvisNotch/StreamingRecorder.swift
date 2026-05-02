import Foundation
import AVFoundation

/// Streaming mic recorder with RMS-based silence detection. Built on top of
/// the same AVAudioEngine pipeline as `VoiceRecorder` (16 kHz mono Int16 WAV
/// on disk) but adds:
///
///   - `onPartial(levelRMS:Float)` — called ~10 Hz with the rolling audio
///     level so the UI can drive a live waveform without needing the raw
///     buffers.
///   - `onSilenceDetected()` — fires once when we've seen ≥ `silenceSeconds`
///     of continuous low-level input. The caller typically uses this to
///     auto-stop the hover-record session.
///
/// The recorder does NOT transcribe anything — it just produces a WAV the
/// caller can POST to `/api/notch/voice` (or `/api/notch/transcript`) to
/// flow through the same Whisper pipeline as click-to-record. Keeping the
/// transcription server-side avoids bundling a multi-hundred-MB model into
/// the tray app.
@MainActor
final class StreamingRecorder {
    private let engine = AVAudioEngine()
    private var file: AVAudioFile?
    private var converter: AVAudioConverter?
    /// Dedicated converter from the AEC-processed input format to a Float32
    /// 44.1kHz mono format that SFSpeechRecognizer accepts. The file write
    /// keeps the raw input format (resampled at stop() via afconvert).
    private var speechConverter: AVAudioConverter?
    private var speechFormat: AVAudioFormat?
    private let outputURL: URL

    /// Serial queue for AVAudioFile writes. Writing the file directly from
    /// the tap callback (which runs on a real-time audio IO thread) trips a
    /// CoreAudio `CAAssertRtn` abort on macOS 26.x — AVAudioFile isn't
    /// documented as RT-safe and in practice panics when called from the
    /// audio IO thread. Hopping onto this queue keeps IO linear and off the
    /// RT thread.
    private let writeQueue = DispatchQueue(label: "jarvis.streamrec.write", qos: .userInitiated)

    /// RMS below which a frame counts as silence. 0.005 is roughly quiet
    /// room-tone at normal mic gain; louder rooms need more. Tune with
    /// NotchLogger output if false-silence triggers are too eager.
    private let silenceThreshold: Float = 0.006
    /// Continuous silence needed to call `onSilenceDetected`. Bumped from
    /// 0.7s → 1.5s on user feedback ("non mi dà neanche il tempo di finire
    /// bene la frase o il pensiero"). Long pauses between thoughts are
    /// natural in dictation; auto-stop should be patient enough to
    /// survive them.
    private let silenceSeconds: Double = 1.5

    private var silenceStart: TimeInterval = 0
    /// Toggled by NotchController via setAssistantSpeaking() while Jarvis's
    /// own TTS is playing. We keep the audio tap running (so VAD / barge-in
    /// can still observe in real time) but DROP every buffer before it
    /// touches the WAV file or the silence detector. This prevents:
    ///   - whisper-cli on the server transcribing the TTS as user input
    ///   - the silence-detector tripping while the speaker output is loud
    ///   - the level-meter spiking on Jarvis's own voice
    /// Apple's SFSpeechRecognizer (in VoiceTranscriber) has its own equivalent
    /// flag — we set both from one entry point in NotchController.
    private var assistantSpeaking: Bool = false
    /// Exposed so the controller can decide NOT to upload a recording
    /// that captured only room tone — mouse-out during hover-record can
    /// otherwise ship 300 ms of noise to whisper-cli, which hallucinates
    /// random Italian words ("grazie", "okay", …) and injects them as if
    /// the user had spoken.
    private(set) var hadVoice: Bool = false
    private var didFireSilence: Bool = false
    private var lastLevelEmitAt: TimeInterval = 0

    private var onPartial: ((Float) -> Void)?
    private var onSilenceDetected: (() -> Void)?
    /// Optional buffer-fanout — invoked from the audio tap thread for every
    /// PCM buffer the engine produces. Used by `VoiceTranscriber` to feed
    /// Apple's SFSpeechRecognizer in parallel to the WAV write. Must NOT
    /// allocate or take @MainActor state — runs on a real-time thread.
    private var onBuffer: ((AVAudioPCMBuffer) -> Void)?

    init() {
        self.outputURL = URL(fileURLWithPath: "/tmp/jarvis-notch-stream.wav")
    }

    var isRunning: Bool { engine.isRunning }
    var fileURL: URL { outputURL }

    /// Set the assistant-speaking flag. While true, the tap callback drops
    /// every frame before file write / RMS processing — equivalent to the
    /// flag VoiceTranscriber holds for the SFSpeechRecognizer feed.
    func setAssistantSpeaking(_ speaking: Bool) {
        assistantSpeaking = speaking
    }

    /// Start capture. `onPartial` fires ~10 Hz with the current RMS level
    /// (0…1-ish). `onSilenceDetected` fires ONCE after a voiced segment
    /// followed by `silenceSeconds` of quiet — the caller can then stop()
    /// and ship the WAV for transcription.
    func start(
        onPartial: @escaping (Float) -> Void,
        onSilenceDetected: @escaping () -> Void,
        onBuffer: ((AVAudioPCMBuffer) -> Void)? = nil
    ) throws {
        try requestPermissionSync()

        self.onPartial = onPartial
        self.onSilenceDetected = onSilenceDetected
        self.onBuffer = onBuffer
        self.silenceStart = 0
        self.hadVoice = false
        self.didFireSilence = false
        self.lastLevelEmitAt = 0

        let input = engine.inputNode

        // ECHO CANCELLATION (AEC) — Apple's voiceProcessing AudioUnit
        // sottrae lo speaker output dal mic input prima del tap. Critico
        // quando user usa speakers MacBook (no cuffie): senza AEC, il mic
        // capta il TTS che esce dagli altoparlanti e Apple SFSpeechRecognizer
        // lo trascrive come user input.
        //
        // Trade-off precedente: voiceProcessing cambiava il format del input
        // node (24kHz mono Float32 invece di 48kHz) e SFSpeechRecognizer
        // smetteva di emettere partials. Soluzione: AVAudioConverter dedicato
        // sul path verso il transcriber (file di WAV resta in hwFormat post-AEC).
        // AEC voiceProcessing disabilitato per ora — alterava il routing
        // audio macOS-wide e il WebView <audio> non emetteva più sound nei
        // speaker. Echo handling resta software (drop buffer durante TTS,
        // VAD pause, AVSpeech.stop su barge-in).
        // Per riabilitare in futuro: serve confinare il routing al solo
        // input node, oppure usare AUVoiceIO custom invece di
        // setVoiceProcessingEnabled.
        // try? input.setVoiceProcessingEnabled(true)

        let hwFormat = input.outputFormat(forBus: 0)
        NotchLogger.shared.log("info", "[stream-rec] input format sr=\(hwFormat.sampleRate) ch=\(hwFormat.channelCount)")

        // Mono buffer per SFSpeechRecognizer: stesso sample rate del input
        // (Apple STT accetta 16k..48k senza problemi), 1 canale. Prendiamo
        // channel 0 manualmente nel tap — AVAudioConverter automatico su 5ch
        // (output di voiceProcessing su macOS) downmixa a silence senza un
        // channel layout esplicito. Pickando il primo canale evitiamo tutto
        // il problema layout.
        if hwFormat.channelCount > 1 {
            self.speechFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: hwFormat.sampleRate,
                channels: 1,
                interleaved: false
            )
            self.speechConverter = nil // not used in this path
            NotchLogger.shared.log("info", "[stream-rec] mono extract active: \(hwFormat.sampleRate)Hz/\(hwFormat.channelCount)ch → \(hwFormat.sampleRate)Hz/1ch (channel 0)")
        } else {
            self.speechFormat = nil
            self.speechConverter = nil
        }

        // macOS 26.x's AVAudioFile refuses to write an interleaved Int16
        // PCM stream produced by AVAudioConverter from the tap thread —
        // ExtAudioFile's WriteInputProc asserts in CoreAudio. The only
        // stable recipe is to open the file in the EXACT hardware format
        // (whatever the mic reports, typically 48 kHz Float32 stereo) and
        // write the tap buffer verbatim. Resampling to 16 kHz mono Int16
        // happens offline in `stop()` via `afconvert`, which is what the
        // whisper-cli pipeline expects anyway.
        self.file = try AVAudioFile(forWriting: outputURL, settings: hwFormat.settings)
        self.converter = nil

        input.installTap(onBus: 0, bufferSize: 4096, format: hwFormat) { [weak self] buf, _ in
            guard let self = self else { return }

            // RMS is cheap and safe from the tap thread — no allocations,
            // no locks, no Objective-C.
            let rms = Self.computeRMS(buffer: buf)

            // Forward to SFSpeechRecognizer. Two paths:
            //   - multi-channel input (voiceProcessing 5ch on macOS): extract
            //     channel 0 into a fresh mono buffer (same sample rate). Apple
            //     STT accepts any sample rate 16-48kHz; the channel 0 path
            //     avoids the silent-downmix bug AVAudioConverter has on 5ch
            //     without an explicit channel layout.
            //   - mono input: pass through.
            // Buffer alloc is fixed-size and the loop is a memcpy-equivalent.
            if let monoFmt = self.speechFormat, hwFormat.channelCount > 1 {
                let frameLen = Int(buf.frameLength)
                if frameLen > 0,
                   let monoBuf = AVAudioPCMBuffer(pcmFormat: monoFmt, frameCapacity: AVAudioFrameCount(frameLen)),
                   let srcCh0 = buf.floatChannelData?[0],
                   let dstCh0 = monoBuf.floatChannelData?[0] {
                    for i in 0..<frameLen { dstCh0[i] = srcCh0[i] }
                    monoBuf.frameLength = AVAudioFrameCount(frameLen)
                    self.onBuffer?(monoBuf)
                }
            } else {
                self.onBuffer?(buf)
            }

            // File write hops to the serial queue so we never touch
            // ExtAudioFile from the real-time audio IO thread. `buf` is
            // kept alive by ARC inside the closure.
            self.writeQueue.async { [weak self] in
                try? self?.file?.write(from: buf)
            }

            // Dispatch level update + silence check back onto the main
            // actor. AVAudioEngine taps run on an internal real-time thread,
            // so we can't touch `@MainActor` state from here.
            Task { @MainActor [weak self] in
                self?.processFrameRMS(rms)
            }
        }

        engine.prepare()
        try engine.start()
    }

    /// Stop capture and return a 16 kHz mono Int16 WAV URL ready for
    /// whisper-cli. The tap writes the raw HW-format file; we post-process
    /// to the target format here via `afconvert` (ships with macOS), which
    /// avoids the AVAudioConverter + ExtAudioFile crash observed on 26.x.
    @discardableResult
    func stop() -> URL {
        if engine.isRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        writeQueue.sync {}
        file = nil
        converter = nil
        onPartial = nil
        onSilenceDetected = nil
        onBuffer = nil

        // afconvert: -d LEI16@16000 = little-endian Int16 @ 16kHz,
        //            -c 1           = mono,
        //            -f WAVE        = WAV container.
        // We overwrite the raw HW file with the resampled one in-place.
        let rawPath = outputURL.path
        let convertedURL = URL(fileURLWithPath: rawPath + ".16k.wav")
        let convert = Process()
        convert.launchPath = "/usr/bin/afconvert"
        convert.arguments = [
            "-d", "LEI16@16000",
            "-c", "1",
            "-f", "WAVE",
            rawPath,
            convertedURL.path,
        ]
        convert.standardOutput = Pipe()
        convert.standardError = Pipe()
        do {
            try convert.run()
            convert.waitUntilExit()
            if convert.terminationStatus == 0 {
                try? FileManager.default.removeItem(at: outputURL)
                try? FileManager.default.moveItem(at: convertedURL, to: outputURL)
            } else {
                NotchLogger.shared.log("warn", "[stream-rec] afconvert exit \(convert.terminationStatus); uploading raw HW file")
            }
        } catch {
            NotchLogger.shared.log("warn", "[stream-rec] afconvert spawn failed: \(error.localizedDescription)")
        }
        return outputURL
    }

    // MARK: - VAD

    /// Forced silence trigger from outside (e.g. Silero VAD in the WebView
    /// reports user speech end). Skips the RMS-based 1.5s silence threshold
    /// for snappier turn-taking. Idempotent — only fires once per session,
    /// matching the contract of processFrameRMS's natural silence detection.
    func flushOnUserSilence() {
        guard hadVoice, !didFireSilence else { return }
        didFireSilence = true
        onSilenceDetected?()
    }

    private func processFrameRMS(_ rms: Float) {
        let now = Date().timeIntervalSince1970

        // Throttle the UI signal to ~10 Hz. The tap fires ~20–40×/s so
        // posting every frame would just burn WebView bridge cycles.
        if now - lastLevelEmitAt >= 0.1 {
            lastLevelEmitAt = now
            onPartial?(rms)
        }

        if rms > silenceThreshold {
            hadVoice = true
            silenceStart = 0
            return
        }

        // Sub-threshold. Only count towards silence once we've actually heard
        // the user say something — otherwise dead-air at hover-start triggers
        // an instant bail.
        guard hadVoice, !didFireSilence else { return }
        if silenceStart == 0 {
            silenceStart = now
            return
        }
        if now - silenceStart >= silenceSeconds {
            didFireSilence = true
            onSilenceDetected?()
        }
    }

    private static func computeRMS(buffer: AVAudioPCMBuffer) -> Float {
        let frameLen = Int(buffer.frameLength)
        guard frameLen > 0 else { return 0 }
        if let fp = buffer.floatChannelData?[0] {
            var sum: Float = 0
            for i in 0..<frameLen {
                let s = fp[i]
                sum += s * s
            }
            return (sum / Float(frameLen)).squareRoot()
        }
        if let ip = buffer.int16ChannelData?[0] {
            var sum: Double = 0
            let scale = 1.0 / 32768.0
            for i in 0..<frameLen {
                let s = Double(ip[i]) * scale
                sum += s * s
            }
            return Float((sum / Double(frameLen)).squareRoot())
        }
        return 0
    }

    private func requestPermissionSync() throws {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        switch status {
        case .authorized:
            return
        case .notDetermined:
            // MUST NOT block the main thread waiting for the TCC prompt —
            // the prompt is drawn by WindowServer and needs the run loop to
            // be spinning. We kick it off asynchronously and fail this call;
            // the next hover fires again and finds `.authorized`.
            AVCaptureDevice.requestAccess(for: .audio) { _ in }
            throw NSError(
                domain: "StreamingRecorder", code: -10,
                userInfo: [NSLocalizedDescriptionKey: "microphone permission requested — accept the prompt and try again"]
            )
        case .denied, .restricted:
            throw NSError(domain: "StreamingRecorder", code: -11, userInfo: [NSLocalizedDescriptionKey: "microphone denied"])
        @unknown default:
            throw NSError(domain: "StreamingRecorder", code: -12, userInfo: [NSLocalizedDescriptionKey: "microphone unknown"])
        }
    }
}
