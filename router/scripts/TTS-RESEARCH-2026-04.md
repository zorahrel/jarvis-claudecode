# TTS State of the Art — aprile 2026

Snapshot della ricerca su quale TTS usare per il notch e i canali voice di Jarvis.
Stato attuale: cascata MLX Voxtral 4B → Kokoro ONNX → macOS `say`.

## TL;DR

**Tieni Voxtral come default**, ma valuta **mlx-audio + Kokoro v1** come
alternativa più snella, e **F5-TTS via MLX** come upgrade qualità quando serve
voice cloning. Lascia perdere Qwen3-TTS su MLX per il notch: la port MLX è
batch-oriented (RTF ~2), non real-time. Sesame CSM è il sogno di prosodia ma
qualità voce ancora dietro F5 sull'open source.

## Modelli valutati

| Modello | Italiano | Latenza streaming | Voice cloning | Stack | Verdetto per notch |
|---|---|---|---|---|---|
| **Kokoro 82M** | ok (multi via v1.x) | sub-300ms su M-series | ❌ | ONNX / MLX | Solido fallback. Tienilo. |
| **Voxtral 4B IT** (attuale default) | nativo | ~3s reply, RTF 1.3 | parziale | MLX | OK ma pesante. Buono per qualità. |
| **F5-TTS** | sì (multilingua) | medio | ✅ ottimo | torch / MLX port | Upgrade per voce custom Attilio. |
| **Qwen3-TTS 0.6B/1.7B** | top WER su IT | 97ms su GPU server, RTF 2 su MLX | ✅ | torch (MLX batch-only) | Skippa per streaming locale. |
| **Sesame CSM 1B** | sì | medio | ✅ (limitato) | torch / MLX in beta | Vinitore prosodia, qualità ancora sotto F5. |
| **Orpheus 3B** | multi | medio | ✅ robusto | torch | Pesante per uso edge. |
| **CosyVoice 2** | sì | 150ms streaming | ✅ | torch | Server-friendly, non MLX-native. |
| **mlx-audio (Blaizzy)** | dipende dal modello | dipende | dipende | MLX nativo | Wrapper utile: ti dà Kokoro/F5/CSM in un solo runtime. |

## Raccomandazione concreta per il notch

### Step 1 — Snellire (basso rischio)
Sostituisci Voxtral 4B con **Kokoro v1 via mlx-audio**. Vantaggi:
- footprint 82M vs 4B → load istantaneo, niente warm-up
- streaming sub-300ms first audio
- runtime MLX-nativo (Blaizzy/mlx-audio) → meno spawn Python overhead
- italiano coperto da v1.x

Trade-off: voce meno espressiva di Voxtral. Per cruscotto status/triage non
serve drama, ma per output lunghi sì.

### Step 2 — Voce personalizzata (qualità top)
Aggiungi **F5-TTS via mlx-audio** come engine "premium" attivabile per output
> 200 caratteri o quando l'utente lo richiede esplicitamente. Clona la voce di
Attilio da 10s di sample → notch parla come lui (o come una voce italiana
naturale a scelta).

### Step 3 — Routing intelligente
Aggiorna `tts.ts` con cascata a tre livelli:
```
short reply (< 80 char)  → Kokoro v1 (latenza)
medium (80-300)          → Kokoro v1 streaming
long / featured          → F5-TTS clone
fallback                 → say
```

### Step 4 — Streaming chunk-progressivo
Oggi `speakToFile` accumula tutto e poi serve il file. Con Kokoro/F5 streaming
puoi emettere chunk audio mentre il modello genera. Richiede modifica
`notch.ts` per servire SSE/WebSocket binary chunks invece di un singolo URL.
Riduzione first-audio percepito: 600ms → 200ms.

## Da non fare

- **Non passare a Qwen3-TTS per il notch** finché la port MLX non ha streaming
  real-time. Su server cloud è competitivo, in locale Apple Silicon no.
- **Non rimuovere Kokoro** anche dopo aver aggiunto mlx-audio: i percorsi ONNX
  attuali sono il fallback più robusto se MLX si rompe per un update Python.
- **Non clonare la voce di Attilio senza il suo consenso esplicito** anche per
  uso interno — è un asset biometrico.

## Sources

- [Qwen3-TTS Technical Report (arXiv 2601.15621)](https://arxiv.org/abs/2601.15621)
- [mlx-audio (Blaizzy)](https://github.com/Blaizzy/mlx-audio)
- [F5-TTS / Kokoro / Sesame CSM comparison — DigitalOcean](https://www.digitalocean.com/community/tutorials/best-text-to-speech-models)
- [Qwen3-TTS performance / hardware guide](https://qwen3-tts.app/blog/qwen3-tts-performance-benchmarks-hardware-guide-2026)
- [BentoML — best open-source TTS 2026](https://www.bentoml.com/blog/exploring-the-world-of-open-source-text-to-speech-models)
- [Murmur — best local TTS 2026](https://www.murmurtts.com/blog/best-local-tts-models-2026)
- [Inferless — 12 best open-source TTS comparison](https://www.inferless.com/learn/comparing-different-text-to-speech---tts--models-part-2)

## Prossimo step suggerito

`pip install mlx-audio` in un venv di test, prova Kokoro v1 vs F5-TTS su una
frase italiana media (es. "Ciao Attilio, oggi hai 3 task in pending e una call
alle 15"), confronta first-audio latency e qualità soggettiva, poi decidi se
swappare il default in `tts.ts`. Mezz'ora di lavoro prima di toccare runtime.
