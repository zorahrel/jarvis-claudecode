// Redazione dei segreti prima che un log arrivi su disco.
// Il caso reale: grammy mette l'URL completo di api.telegram.org nel messaggio
// e nello stack di HttpError/FetchError, quindi il token del bot finiva in
// chiaro in router.log e in router*.jsonl. I redact path di pino non bastano:
// guardano chiavi note, non il testo dentro message/stack.

const TELEGRAM_BOT_TOKEN_RE = /(bot\d+):[A-Za-z0-9_-]+/g;

/** Sostituisce la parte segreta dei token Telegram (`bot<id>:<secret>` → `bot<id>:***`). */
export function redactString(input: string): string {
  return input.replace(TELEGRAM_BOT_TOKEN_RE, "$1:***");
}

/**
 * Copia redatta di un valore da loggare. Stringhe, array, oggetti semplici ed
 * Error (anche annidati, anche con cicli) vengono ripuliti; le altre istanze
 * (Buffer, Date, Map, socket…) passano intatte perché non portano URL.
 */
export function redactSecrets<T>(value: T): T {
  return walk(value, new WeakMap()) as T;
}

function walk(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(walk(item, seen));
    return out;
  }

  if (value instanceof Error) {
    // Stesso prototipo (pino continua a scrivere type=HttpError), ma message e
    // stack vanno copiati a mano: non sono enumerabili e resterebbero in chiaro.
    const out = Object.create(Object.getPrototypeOf(value)) as Error & Record<string, unknown>;
    seen.set(value, out);
    out.message = redactString(value.message);
    if (value.stack) out.stack = redactString(value.stack);
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, seen);
    if ("cause" in value && value.cause !== undefined) out.cause = walk(value.cause, seen);
    return out;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value)) out[k] = walk(v, seen);
  return out;
}
