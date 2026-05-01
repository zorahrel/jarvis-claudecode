/**
 * Activity pane — channel activity bars (Telegram, WhatsApp, Discord).
 * Same DOM/classes as legacy. The bars + counts are populated by the
 * legacy bundle / SSE in the original — for now they stay at 0 in the
 * React port (driving them via store state would require the connector
 * to emit per-channel counts which it doesn't currently).
 *
 * Visibility is controlled by the html[data-notch-focus="activity"]
 * attribute the legacy CSS already toggles. We render the panel always;
 * CSS hides it in chat-focus mode.
 */
const CHANNELS = [
  { id: "telegram", label: "Telegram" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "discord", label: "Discord" },
];

export function ActivityPane() {
  return (
    <div className="activity-pane">
      <h4>Canali</h4>
      <div className="channel-list" id="channel-list">
        {CHANNELS.map((c) => (
          <div key={c.id} className="channel-row" data-channel={c.id}>
            <span className="name">{c.label}</span>
            <div className="bar"><span id={`bar-${c.id}`} style={{ width: "0%" }}></span></div>
            <span className="count" id={`count-${c.id}`}>0</span>
          </div>
        ))}
      </div>
    </div>
  );
}
