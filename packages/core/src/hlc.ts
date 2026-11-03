/**
 * Hybrid logical clock (HLC).
 *
 * A stamp is "wall-counter-device", for example "0lq3k9z2a-0000-k7x2m4pq".
 * - wall: milliseconds (base 36, 9 chars)
 * - counter: goes up when two events share the same wall time (base 36, 4 chars)
 * - device: random id of the device that made the change (tie-break)
 *
 * Stamps sort as plain strings. A clock never goes backwards, even if the
 * computer clock does, and it jumps forward when it sees a newer stamp from
 * another device. So "newer" means "happened after, as far as we can know",
 * not "the clock said a later time".
 */

export type Hlc = string

const WALL_LEN = 9
const COUNTER_LEN = 4
const MAX_COUNTER = 36 ** COUNTER_LEN - 1
/** Ignore remote stamps that are more than this far in the future. */
export const MAX_DRIFT_MS = 24 * 60 * 60 * 1000

export interface HlcParts {
  wall: number
  counter: number
  device: string
}

export function formatHlc(p: HlcParts): Hlc {
  return `${p.wall.toString(36).padStart(WALL_LEN, '0')}-${p.counter.toString(36).padStart(COUNTER_LEN, '0')}-${p.device}`
}

export function parseHlc(h: Hlc): HlcParts {
  const [w, c, ...d] = h.split('-')
  return { wall: parseInt(w, 36), counter: parseInt(c, 36), device: d.join('-') }
}

export function maxHlc(a: Hlc | undefined, b: Hlc | undefined): Hlc | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a > b ? a : b
}

/** A stamp just after `h` that every device computes the same way (used for merged text). */
export function bumpHlc(h: Hlc): Hlc {
  const p = parseHlc(h)
  if (p.counter >= MAX_COUNTER) return formatHlc({ wall: p.wall + 1, counter: 0, device: p.device })
  return formatHlc({ ...p, counter: p.counter + 1 })
}

export class Clock {
  private wall = 0
  private counter = 0

  constructor(
    readonly device: string,
    last?: Hlc,
    private now: () => number = Date.now
  ) {
    if (last) this.observe(last)
  }

  /** Stamp for a new local change. */
  tick(): Hlc {
    const now = this.now()
    if (now > this.wall) {
      this.wall = now
      this.counter = 0
    } else if (this.counter >= MAX_COUNTER) {
      this.wall += 1
      this.counter = 0
    } else {
      this.counter += 1
    }
    return formatHlc({ wall: this.wall, counter: this.counter, device: this.device })
  }

  /** Move forward after seeing a stamp from another device. */
  observe(h: Hlc): void {
    const p = parseHlc(h)
    if (!Number.isFinite(p.wall) || !Number.isFinite(p.counter)) return
    // A device with a badly wrong clock should not drag us far into the future.
    if (p.wall > this.now() + MAX_DRIFT_MS) return
    if (p.wall > this.wall || (p.wall === this.wall && p.counter > this.counter)) {
      this.wall = p.wall
      this.counter = p.counter
    }
  }

  /** Last stamp this clock knows about (save it to resume later). */
  last(): Hlc {
    return formatHlc({ wall: this.wall, counter: this.counter, device: this.device })
  }
}
