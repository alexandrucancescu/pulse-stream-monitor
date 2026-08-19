// An "audio clock" reads a live audio byte stream and reports how many
// SECONDS OF AUDIO have been delivered — regardless of bitrate. Comparing
// that to wall-clock time gives a true "is it keeping up with realtime?"
// measure that works for VBR (Opus) exactly as well as CBR (MP3/AAC).
//
// Each format parses its container/frames just enough to sum durations:
//   MP3  → MPEG-audio frames  (samples/frame ÷ sample-rate)
//   AAC  → ADTS frames        (1024 samples ÷ sample-rate)
//   Opus → Ogg page granule   (48 kHz sample counter, VBR-proof)

export interface AudioClock {
  feed(chunk: Buffer): void
  /** Cumulative seconds of audio seen so far (deltas are what matter). */
  audioSeconds(): number
}

export function createAudioClock(contentType: string | null, path: string): AudioClock | null {
  const ct = (contentType ?? '').toLowerCase()
  const p = path.toLowerCase()
  if (ct.includes('ogg') || ct.includes('opus') || p.endsWith('.opus') || p.endsWith('.ogg')) {
    return new OggOpusClock()
  }
  if (ct.includes('aac') || ct.includes('adts') || p.endsWith('.aac')) return new AdtsClock()
  if (ct.includes('mpeg') || ct.includes('mp3') || p.endsWith('.mp3')) return new Mp3Clock()
  return null // unknown format → caller falls back to stall/down only
}

type ParseResult =
  | { kind: 'frame'; len: number; dur: number }
  | { kind: 'incomplete' }
  | { kind: 'invalid' }

const INCOMPLETE: ParseResult = { kind: 'incomplete' }
const INVALID: ParseResult = { kind: 'invalid' }

// Shared streaming loop: keep a leftover buffer, consume whole frames,
// resync on garbage, and never let the buffer grow without bound.
abstract class FrameClock implements AudioClock {
  protected seconds = 0
  private buf: Buffer = Buffer.alloc(0)
  protected abstract cap: number
  protected abstract parse(buf: Buffer, i: number): ParseResult

  feed(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    let i = 0
    while (i < this.buf.length) {
      const r = this.parse(this.buf, i)
      if (r.kind === 'frame') {
        this.seconds += r.dur
        i += r.len
      } else if (r.kind === 'incomplete') {
        break
      } else {
        i++ // garbage — scan for the next sync word
      }
    }
    this.buf = this.buf.subarray(i)
    // Bound memory if we're fed a long run of unparseable bytes
    if (this.buf.length > this.cap) this.buf = this.buf.subarray(this.buf.length - 4096)
  }

  audioSeconds(): number {
    return this.seconds
  }
}

// ── MP3 (MPEG-1/2/2.5 Layer III) ─────────────────────────────────────
const MP3_SR: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000], // MPEG2.5
}
const MP3_BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MP3_BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]

class Mp3Clock extends FrameClock {
  protected cap = 8192
  protected parse(buf: Buffer, i: number): ParseResult {
    if (i + 4 > buf.length) return INCOMPLETE
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return INVALID
    const ver = (buf[i + 1] >> 3) & 0x03 // 0=2.5, 2=MPEG2, 3=MPEG1 (1 reserved)
    const layer = (buf[i + 1] >> 1) & 0x03 // 1 = Layer III
    if (ver === 1 || layer !== 1) return INVALID
    const brIdx = (buf[i + 2] >> 4) & 0x0f
    const srIdx = (buf[i + 2] >> 2) & 0x03
    const pad = (buf[i + 2] >> 1) & 0x01
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) return INVALID
    const mpeg1 = ver === 3
    const bitrate = (mpeg1 ? MP3_BR_V1 : MP3_BR_V2)[brIdx] * 1000
    const sampleRate = MP3_SR[ver]?.[srIdx]
    if (!bitrate || !sampleRate) return INVALID
    const samples = mpeg1 ? 1152 : 576
    const len = Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sampleRate) + pad
    if (len < 4) return INVALID
    if (i + len > buf.length) return INCOMPLETE
    return { kind: 'frame', len, dur: samples / sampleRate }
  }
}

// ── AAC (ADTS) ───────────────────────────────────────────────────────
const ADTS_SR = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
]

class AdtsClock extends FrameClock {
  protected cap = 16384
  protected parse(buf: Buffer, i: number): ParseResult {
    if (i + 7 > buf.length) return INCOMPLETE
    // Sync 1111 1111 1111, layer bits (00) must be zero
    if (buf[i] !== 0xff || (buf[i + 1] & 0xf6) !== 0xf0) return INVALID
    const srIdx = (buf[i + 2] >> 2) & 0x0f
    const sampleRate = ADTS_SR[srIdx]
    if (!sampleRate) return INVALID
    const len = ((buf[i + 3] & 0x03) << 11) | (buf[i + 4] << 3) | ((buf[i + 5] >> 5) & 0x07)
    const blocks = (buf[i + 6] & 0x03) + 1 // number_of_raw_data_blocks_in_frame + 1
    if (len < 7) return INVALID
    if (i + len > buf.length) return INCOMPLETE
    return { kind: 'frame', len, dur: (1024 * blocks) / sampleRate }
  }
}

// ── Opus in Ogg ──────────────────────────────────────────────────────
// Opus granule positions are always at 48 kHz. We don't decode packets —
// the Ogg page header's granule counter is the exact sample count.
class OggOpusClock implements AudioClock {
  private buf: Buffer = Buffer.alloc(0)
  private latest = -1n

  feed(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    let i = 0
    while (i + 27 <= this.buf.length) {
      if (
        this.buf[i] !== 0x4f || // 'O'
        this.buf[i + 1] !== 0x67 || // 'g'
        this.buf[i + 2] !== 0x67 || // 'g'
        this.buf[i + 3] !== 0x53 // 'S'
      ) {
        i++
        continue
      }
      const numSegs = this.buf[i + 26]
      if (i + 27 + numSegs > this.buf.length) break // header incomplete
      let body = 0
      for (let s = 0; s < numSegs; s++) body += this.buf[i + 27 + s]
      const pageLen = 27 + numSegs + body
      if (i + pageLen > this.buf.length) break // body incomplete
      const granule = this.buf.readBigInt64LE(i + 6)
      if (granule >= 0n) this.latest = granule // -1 = no packet completed here
      i += pageLen
    }
    this.buf = this.buf.subarray(i)
    if (this.buf.length > 65536) this.buf = this.buf.subarray(this.buf.length - 4096)
  }

  audioSeconds(): number {
    return this.latest < 0n ? 0 : Number(this.latest) / 48000
  }
}
