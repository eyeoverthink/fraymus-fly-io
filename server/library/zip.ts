// Minimal streaming ZIP writer (STORE method, data descriptors, UTF-8 names).
// Files are streamed from disk, so memory stays flat regardless of export size.
// Limits: no ZIP64, so total < 4 GiB and < 65535 entries (the export route enforces a lower cap).
import { createReadStream } from 'node:fs'
import { crc32 } from 'node:zlib'

export type ZipEntry = { name: string; path?: string; data?: Buffer; mtime?: number }

function dosTime(ms: number) {
  const d = new Date(ms || Date.now())
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

export async function* zipStream(entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>): AsyncGenerator<Buffer> {
  const central: Buffer[] = []
  let offset = 0
  let count = 0
  for await (const e of entries as any) {
    const name = Buffer.from(e.name.replace(/^\/+/, ''), 'utf8')
    const { time, date } = dosTime(e.mtime || Date.now())
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0808, 6); lh.writeUInt16LE(0, 8)
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28)
    const start = offset
    yield lh; yield name
    offset += 30 + name.length
    let crc = 0
    let size = 0
    if (e.data) {
      crc = crc32(e.data); size = e.data.length
      if (size) yield e.data
    } else if (e.path) {
      for await (const chunk of createReadStream(e.path, { highWaterMark: 1 << 20 })) {
        crc = crc32(chunk as Buffer, crc); size += (chunk as Buffer).length
        yield chunk as Buffer
      }
    }
    offset += size
    const dd = Buffer.alloc(16)
    dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc >>> 0, 4); dd.writeUInt32LE(size, 8); dd.writeUInt32LE(size, 12)
    yield dd
    offset += 16
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0808, 8); ch.writeUInt16LE(0, 10)
    ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(size, 20); ch.writeUInt32LE(size, 24)
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(start, 42)
    central.push(ch, name)
    count++
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  yield cd; yield end
}

// Reads back a STORE zip produced above (used by tests): returns name -> Buffer, verifying CRCs.
export function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error('no EOCD')
  const n = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central header')
    const crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28)
    const xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nl).toString('utf8')
    const ds = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28)
    const data = buf.subarray(ds, ds + size)
    if ((crc32(data) >>> 0) !== crc) throw new Error(`crc mismatch for ${name}`)
    out.set(name, data)
    p += 46 + nl + xl + cl
  }
  return out
}
