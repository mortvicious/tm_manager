/** Fixed-capacity byte ring buffer for terminal scrollback. */
export class RingBuffer {
  private buf: Buffer;
  private start = 0;
  private len = 0;

  constructor(private capacity: number) {
    this.buf = Buffer.alloc(capacity);
  }

  append(chunk: Buffer): void {
    if (chunk.length >= this.capacity) {
      chunk.copy(this.buf, 0, chunk.length - this.capacity);
      this.start = 0;
      this.len = this.capacity;
      return;
    }
    const end = (this.start + this.len) % this.capacity;
    const tail = Math.min(chunk.length, this.capacity - end);
    chunk.copy(this.buf, end, 0, tail);
    if (tail < chunk.length) chunk.copy(this.buf, 0, tail);
    if (this.len + chunk.length <= this.capacity) {
      this.len += chunk.length;
    } else {
      this.start = (this.start + (this.len + chunk.length - this.capacity)) % this.capacity;
      this.len = this.capacity;
    }
  }

  snapshot(): Buffer {
    const out = Buffer.alloc(this.len);
    const tail = Math.min(this.len, this.capacity - this.start);
    this.buf.copy(out, 0, this.start, this.start + tail);
    if (tail < this.len) this.buf.copy(out, tail, 0, this.len - tail);
    return out;
  }
}
