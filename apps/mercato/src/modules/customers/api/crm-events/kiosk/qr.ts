// Minimal dependency-free QR code generator (byte mode, error correction
// level L, versions 1-6 = up to 134 bytes; version 7+ would need the
// version-info blocks this trimmed encoder does not draw). Algorithm
// structure follows the reference implementation by Project Nayuki (MIT
// licensed), trimmed to the single mode/ECC level this app needs. Used
// server-side by the kiosk page and client-side by the events admin UI, so
// keep this module pure TS with no imports. Round-trip verified against a
// full reverse-decoder (format BCH, unmask, zigzag, de-interleave, RS
// syndrome) for versions 1-6.

const ECC_L_FORMAT_BITS = 1 // level L

// Per-version tables for ECC level L, versions 1..9.
const ECC_CODEWORDS_PER_BLOCK = [7, 10, 15, 20, 26, 18, 20, 24, 30]
const NUM_ERROR_CORRECTION_BLOCKS = [1, 1, 1, 1, 1, 2, 2, 2, 2]

function getNumRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

function getNumDataCodewords(ver: number): number {
  return Math.floor(getNumRawDataModules(ver) / 8)
    - ECC_CODEWORDS_PER_BLOCK[ver - 1] * NUM_ERROR_CORRECTION_BLOCKS[ver - 1]
}

// ── GF(256) Reed-Solomon ──

function reedSolomonMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

function reedSolomonComputeDivisor(degree: number): number[] {
  const result: number[] = []
  for (let i = 0; i < degree - 1; i++) result.push(0)
  result.push(1)
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = reedSolomonMultiply(result[j], root)
      if (j + 1 < result.length) result[j] ^= result[j + 1]
    }
    root = reedSolomonMultiply(root, 0x02)
  }
  return result
}

function reedSolomonComputeRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ (result.shift() as number)
    result.push(0)
    divisor.forEach((coef, i) => { result[i] ^= reedSolomonMultiply(coef, factor) })
  }
  return result
}

// ── Codeword assembly ──

function addEccAndInterleave(ver: number, data: number[]): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ver - 1]
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ver - 1]
  const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)

  const blocks: number[][] = []
  const rsDiv = reedSolomonComputeDivisor(blockEccLen)
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1))
    k += dat.length
    const ecc = reedSolomonComputeRemainder(dat, rsDiv)
    if (i < numShortBlocks) dat.push(0)
    blocks.push(dat.concat(ecc))
  }

  const result: number[] = []
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i])
    })
  }
  return result
}

// ── Matrix ──

type Matrix = { size: number; modules: boolean[][]; isFunction: boolean[][] }

function getAlignmentPatternPositions(ver: number, size: number): number[] {
  if (ver === 1) return []
  const numAlign = Math.floor(ver / 7) + 2
  const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2
  const result = [6]
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

function setFunctionModule(m: Matrix, x: number, y: number, isDark: boolean): void {
  m.modules[y][x] = isDark
  m.isFunction[y][x] = true
}

function drawFinderPattern(m: Matrix, x: number, y: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      const xx = x + dx; const yy = y + dy
      if (xx >= 0 && xx < m.size && yy >= 0 && yy < m.size) {
        setFunctionModule(m, xx, yy, dist !== 2 && dist !== 4)
      }
    }
  }
}

function drawAlignmentPattern(m: Matrix, x: number, y: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFunctionModule(m, x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }
}

function getBit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0
}

function drawFormatBits(m: Matrix, mask: number): void {
  const data = (ECC_L_FORMAT_BITS << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = ((data << 10) | rem) ^ 0x5412

  // First copy (around top-left finder)
  for (let i = 0; i <= 5; i++) setFunctionModule(m, 8, i, getBit(bits, i))
  setFunctionModule(m, 8, 7, getBit(bits, 6))
  setFunctionModule(m, 8, 8, getBit(bits, 7))
  setFunctionModule(m, 7, 8, getBit(bits, 8))
  for (let i = 9; i < 15; i++) setFunctionModule(m, 14 - i, 8, getBit(bits, i))

  // Second copy (split between the other two finders)
  for (let i = 0; i < 8; i++) setFunctionModule(m, m.size - 1 - i, 8, getBit(bits, i))
  for (let i = 8; i < 15; i++) setFunctionModule(m, 8, m.size - 15 + i, getBit(bits, i))
  setFunctionModule(m, 8, m.size - 8, true) // dark module
}

function drawFunctionPatterns(m: Matrix, ver: number): void {
  // Timing patterns
  for (let i = 0; i < m.size; i++) {
    setFunctionModule(m, 6, i, i % 2 === 0)
    setFunctionModule(m, i, 6, i % 2 === 0)
  }
  // Finder patterns (overwrite timing at corners)
  drawFinderPattern(m, 3, 3)
  drawFinderPattern(m, m.size - 4, 3)
  drawFinderPattern(m, 3, m.size - 4)
  // Alignment patterns
  const alignPos = getAlignmentPatternPositions(ver, m.size)
  const numAlign = alignPos.length
  for (let i = 0; i < numAlign; i++) {
    for (let j = 0; j < numAlign; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0)) continue
      drawAlignmentPattern(m, alignPos[i], alignPos[j])
    }
  }
  // Reserve format info areas (actual bits drawn per-mask later)
  drawFormatBits(m, 0)
}

function drawCodewords(m: Matrix, data: number[]): void {
  let i = 0
  for (let right = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < m.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? m.size - 1 - vert : vert
        if (!m.isFunction[y][x] && i < data.length * 8) {
          m.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7))
          i++
        }
      }
    }
  }
}

function applyMask(m: Matrix, mask: number): void {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (m.isFunction[y][x]) continue
      let invert: boolean
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break
        case 1: invert = y % 2 === 0; break
        case 2: invert = x % 3 === 0; break
        case 3: invert = (x + y) % 3 === 0; break
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break
        default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break
      }
      if (invert) m.modules[y][x] = !m.modules[y][x]
    }
  }
}

// Simplified penalty (run-length + block rules + dark balance). Enough to
// avoid pathological masks; any chosen mask still decodes per the spec.
function getPenaltyScore(m: Matrix): number {
  let result = 0
  const size = m.size
  // Adjacent same-color runs, rows and columns
  for (let y = 0; y < size; y++) {
    let runColor = false; let runX = 0
    for (let x = 0; x < size; x++) {
      if (m.modules[y][x] === runColor) {
        runX++
        if (runX === 5) result += 3
        else if (runX > 5) result++
      } else { runColor = m.modules[y][x]; runX = 1 }
    }
  }
  for (let x = 0; x < size; x++) {
    let runColor = false; let runY = 0
    for (let y = 0; y < size; y++) {
      if (m.modules[y][x] === runColor) {
        runY++
        if (runY === 5) result += 3
        else if (runY > 5) result++
      } else { runColor = m.modules[y][x]; runY = 1 }
    }
  }
  // 2x2 blocks of same color
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m.modules[y][x]
      if (c === m.modules[y][x + 1] && c === m.modules[y + 1][x] && c === m.modules[y + 1][x + 1]) result += 3
    }
  }
  // Dark module balance
  let dark = 0
  for (const row of m.modules) for (const cell of row) if (cell) dark++
  const total = size * size
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
  result += k * 10
  return result
}

function textToUtf8Bytes(text: string): number[] {
  // encodeURIComponent trick keeps this module runtime-agnostic.
  const encoded = encodeURIComponent(text)
  const bytes: number[] = []
  for (let i = 0; i < encoded.length; i++) {
    const c = encoded.charAt(i)
    if (c === '%') {
      bytes.push(parseInt(encoded.substring(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(c.charCodeAt(0))
    }
  }
  return bytes
}

// Encode text into a QR module matrix, or null if it does not fit
// (version 6, ECC L caps out at 134 bytes).
export function encodeQr(text: string): { size: number; modules: boolean[][] } | null {
  const bytes = textToUtf8Bytes(text)

  // Pick the smallest version that fits (byte mode header = 4 + 8 bits).
  // Capped at version 6: version 7+ requires version-info blocks that this
  // trimmed encoder does not emit.
  let version = -1
  for (let v = 1; v <= 6; v++) {
    const capacityBits = getNumDataCodewords(v) * 8
    if (4 + 8 + bytes.length * 8 <= capacityBits) { version = v; break }
  }
  if (version === -1) return null

  // Build the bit stream: mode, count, data, terminator, padding
  const bits: number[] = []
  const appendBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  appendBits(4, 4) // byte mode
  appendBits(bytes.length, 8)
  for (const b of bytes) appendBits(b, 8)

  const dataCapacityBits = getNumDataCodewords(version) * 8
  appendBits(0, Math.min(4, dataCapacityBits - bits.length)) // terminator
  appendBits(0, (8 - (bits.length % 8)) % 8) // byte align
  for (let padByte = 0xec; bits.length < dataCapacityBits; padByte ^= 0xec ^ 0x11) {
    appendBits(padByte, 8)
  }

  const dataCodewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]
    dataCodewords.push(b)
  }

  const allCodewords = addEccAndInterleave(version, dataCodewords)

  const size = version * 4 + 17
  const m: Matrix = {
    size,
    modules: Array.from({ length: size }, () => Array.from({ length: size }, () => false)),
    isFunction: Array.from({ length: size }, () => Array.from({ length: size }, () => false)),
  }
  drawFunctionPatterns(m, version)
  drawCodewords(m, allCodewords)

  // Choose the mask with the lowest penalty
  let bestMask = 0
  let bestPenalty = Infinity
  for (let mask = 0; mask < 8; mask++) {
    applyMask(m, mask)
    drawFormatBits(m, mask)
    const penalty = getPenaltyScore(m)
    if (penalty < bestPenalty) { bestPenalty = penalty; bestMask = mask }
    applyMask(m, mask) // undo (XOR is self-inverse)
  }
  applyMask(m, bestMask)
  drawFormatBits(m, bestMask)

  return { size, modules: m.modules }
}

// Render text as a self-contained SVG string (quiet zone included), or null
// if the text is too long to encode.
export function qrSvg(text: string, opts?: { moduleSize?: number; margin?: number; dark?: string; light?: string }): string | null {
  const qr = encodeQr(text)
  if (!qr) return null
  const moduleSize = opts?.moduleSize ?? 6
  const margin = opts?.margin ?? 4
  const dark = opts?.dark ?? '#111111'
  const light = opts?.light ?? '#ffffff'
  const dim = (qr.size + margin * 2) * moduleSize
  let rects = ''
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) {
        rects += `<rect x="${(x + margin) * moduleSize}" y="${(y + margin) * moduleSize}" width="${moduleSize}" height="${moduleSize}"/>`
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="${light}"/><g fill="${dark}">${rects}</g></svg>`
}
