// No bytes at all for this long, once the stream is already open, means the
// connection is genuinely stuck — not "still thinking": a healthy generation
// (reasoning included) keeps producing SSE events well under this. This is
// what actually has to catch a frozen connection now that the connect-phase
// timeout in timeout.ts is cleared as soon as headers arrive and can no
// longer fire mid-body. Resets on every chunk received, unlike the connect
// timeout, so it never punishes a response that's simply long.
const STALL_TIMEOUT_MS = 90_000;

/**
 * Incremental SSE parser. Yields the raw `data:` payload string for each
 * event (multi-line `data:` fields joined per the SSE spec), skipping
 * comments (`:` lines) and blank keepalives. Does not JSON.parse — callers
 * decide, since a "[DONE]" sentinel isn't JSON.
 *
 * Deliberately not a naive `split("\n\n")` — chunks can split mid-line,
 * arrive with "\r\n", or straddle an event boundary.
 */
export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  function flushEvent(): string | null {
    if (dataLines.length === 0) return null;
    const payload = dataLines.join("\n");
    dataLines = [];
    return payload;
  }

  async function readWithStallGuard(): ReturnType<typeof reader.read> {
    let timer: ReturnType<typeof setTimeout>;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DOMException("The operation timed out.", "TimeoutError")), STALL_TIMEOUT_MS);
    });
    try {
      return await Promise.race([reader.read(), stalled]);
    } finally {
      clearTimeout(timer!);
    }
  }

  try {
    while (true) {
      let done: boolean | undefined, value: Uint8Array | undefined;
      try {
        ({ done, value } = await readWithStallGuard());
      } catch (err) {
        await reader.cancel(err).catch(() => {});
        throw err;
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        if (line === "") {
          const payload = flushEvent();
          if (payload !== null) yield payload;
          continue;
        }
        if (line.startsWith(":")) continue; // comment/heartbeat
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
          continue;
        }
        // Other SSE fields (event:, id:, retry:) are irrelevant here.
      }
    }
    // Flush any trailing partial buffer/event at stream end.
    buffer += decoder.decode();
    if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).replace(/^ /, ""));
    const payload = flushEvent();
    if (payload !== null) yield payload;
  } finally {
    reader.releaseLock();
  }
}
