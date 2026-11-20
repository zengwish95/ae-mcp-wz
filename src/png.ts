// Minimal PNG decode/encode with node:zlib, enough for frames from CompItem.saveFrameToPng:
// AE writes transparent RGBA (16-bit in a 16 bpc project), without the comp background (SPIKE.md Q5).
// capture_frame flattens that onto the background colour and downscales it before sending it to the agent.
import { crc32, deflateSync, inflateSync } from "node:zlib";

export interface Image {
  width: number;
  height: number;
  channels: 3 | 4;
  data: Float32Array; // 0..1, row-major, `channels` per pixel
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buf: Buffer): Image {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNGs are not supported");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (colorType !== 2 && colorType !== 6) throw new Error(`PNG color type ${colorType} is not supported`);
  if (depth !== 8 && depth !== 16) throw new Error(`PNG bit depth ${depth} is not supported`);
  const channels = colorType === 6 ? 4 : 3;
  const bytesPerSample = depth / 8;
  const bpp = channels * bytesPerSample;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
    prev = cur;
  }
  const data = new Float32Array(width * height * channels);
  const max = depth === 16 ? 65535 : 255;
  for (let i = 0; i < data.length; i++) data[i] = (depth === 16 ? pixels.readUInt16BE(i * 2) : pixels[i]) / max;
  return { width, height, channels, data };
}

// Composites onto an opaque background (the comp's bgColor), straight alpha "over".
export function flatten(img: Image, bg: [number, number, number]): Image {
  if (img.channels === 3) return img;
  const n = img.width * img.height;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = img.data[i * 4 + 3];
    for (let c = 0; c < 3; c++) out[i * 3 + c] = img.data[i * 4 + c] * a + bg[c] * (1 - a);
  }
  return { width: img.width, height: img.height, channels: 3, data: out };
}

// Box filter by an integer factor (1 = unchanged).
export function downscale(img: Image, factor: number): Image {
  if (factor <= 1) return img;
  const w = Math.max(1, Math.floor(img.width / factor));
  const h = Math.max(1, Math.floor(img.height / factor));
  const ch = img.channels;
  const out = new Float32Array(w * h * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) sum += img.data[((y * factor + dy) * img.width + (x * factor + dx)) * ch + c];
        out[(y * w + x) * ch + c] = sum / (factor * factor);
      }
    }
  }
  return { width: w, height: h, channels: ch, data: out };
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// 8-bit PNG (RGB or RGBA), filter type 0 on every row.
export function encodePng(img: Image): Buffer {
  const ch = img.channels;
  const stride = img.width * ch;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = Math.round(Math.min(1, Math.max(0, img.data[y * stride + x])) * 255);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = ch === 4 ? 6 : 2;
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
