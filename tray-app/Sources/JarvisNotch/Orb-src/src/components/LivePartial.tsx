/**
 * Transient bubble showing the user's live STT partial transcript.
 * Disappears when the recording session finalizes (text is moved into a
 * proper user bubble) or when audio.play arrives (turn moved on).
 */
export function LivePartial({ text }: { text: string }) {
  return (
    <div className="bubble-row user">
      <div className="bubble user live-transcript">{text}</div>
    </div>
  );
}
