/**
 * Async generator that yields SSEFrame objects from a ReadableStream.
 * @param {ReadableStream} readableStream
 * @param {object} [options]
 * @param {string} [options.doneSentinel='[DONE]']
 * @yields {{ event: string, data: string, id: string, parsedData: object|null }}
 */
export async function* parseSSEStream(readableStream, options = {}) {
  const { doneSentinel = '[DONE]' } = options;
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      for (const rawFrame of frames) {
        if (!rawFrame.trim()) continue;
        const frame = parseFrame(rawFrame);
        if (frame.data === doneSentinel) return;
        yield frame;
      }
    }
    if (buffer.trim()) {
      const frame = parseFrame(buffer);
      if (frame.data !== doneSentinel) yield frame;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(raw) {
  let event = '';
  const dataLines = [];
  let id = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue;
    const colonIdx = line.indexOf(':');
    let field, value;
    if (colonIdx === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colonIdx);
      value = line.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    switch (field) {
      case 'event': event = value; break;
      case 'data':  dataLines.push(value); break;
      case 'id':    id = value; break;
    }
  }
  const data = dataLines.join('\n');
  let parsedData = null;
  if (data) { try { parsedData = JSON.parse(data); } catch {} }
  return { event, data, id, parsedData };
}

/**
 * Format data as an SSE event string.
 * @param {string|object} data
 * @param {string} [event]
 * @returns {string}
 */
export function formatSSE(data, event) {
  let out = '';
  if (event) out += `event: ${event}\n`;
  out += `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
  return out;
}
