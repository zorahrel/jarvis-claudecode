import Foundation

// MARK: - Agent state model

/// High-level state machine the assistant exposes to the notch UI.
/// Mirrored from the router via SSE `state.change` events.
enum NotchAgentState: String {
    case idle
    case thinking
    case responding
}

/// Domain events the SSE bus emits to the controller. Models a (small)
/// subset of router events relevant to the notch UI.
enum NotchEvent {
    case stateChange(NotchAgentState)
    case messageIn(String)
    case messageOut(String, String)
    case messageChunk(String)
    case toolRunning(String)
    case agentMeta(String)
    case ttsSpeak(String, String?)  // text, voice identifier (optional)
    case ttsStop
}
