import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { decodePng, downscale, encodePng, flatten, type Image } from "../src/png.ts";
import { scaleFactor } from "../src/tools/capture.ts";

// A 16-bit RGBA PNG like AE's saveFrameToPng output, with a Paeth-filtered row to exercise unfiltering.
function png16(width: number, height: number, px: (x: number, y: number) => [number, number, number, number]): Buffer {
  const stride = width * 8;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const line = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) px(x, y).forEach((v, c) => line.writeUInt16BE(Math.round(v * 65535), x * 8 + c * 2));
    const filter = y % 2 ? 4 : 1;
    const out = Buffer.alloc(stride + 1);
    out[0] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= 8 ? line[i - 8] : 0;
      const b = prev[i];
      const c = i >= 8 ? prev[i - 8] : 0;
      let pred = a;
      if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i + 1] = (line[i] - pred) & 0xff;
    }
    rows.push(out);
    prev = line;
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 16;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

test("decodes 16-bit RGBA with Sub and Paeth filters", () => {
  const img = decodePng(png16(5, 4, (x, y) => [x / 4, y / 3, 0.5, x === 0 ? 0 : 1]));
  assert.equal(img.width, 5);
  assert.equal(img.channels, 4);
  const at = (x: number, y: number, c: number) => img.data[(y * 5 + x) * 4 + c];
  assert.ok(Math.abs(at(4, 3, 0) - 1) < 1e-4);
  assert.ok(Math.abs(at(2, 3, 1) - 1) < 1e-4);
  assert.ok(Math.abs(at(1, 1, 2) - 0.5) < 1e-4);
  assert.equal(at(0, 2, 3), 0);
});

test("flatten puts transparent pixels on the background color", () => {
  const img = decodePng(png16(2, 1, (x) => (x === 0 ? [1, 1, 1, 0] : [1, 0, 0, 0.5])));
  const flat = flatten(img, [0, 0, 1]);
  assert.equal(flat.channels, 3);
  assert.deepEqual([...flat.data].map((v) => Math.round(v * 100) / 100), [0, 0, 1, 0.5, 0, 0.5]);
});

test("downscale averages blocks and encode/decode round-trips 8-bit RGB", () => {
  const img: Image = { width: 4, height: 2, channels: 3, data: new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1].map(Number)) };
  const small = downscale(img, 2);
  assert.equal(small.width, 2);
  assert.equal(small.height, 1);
  const back = decodePng(encodePng(small));
  assert.equal(back.channels, 3);
  assert.equal(back.width, 2);
  assert.ok(Math.abs(back.data[0] - 0.5) < 0.01);
});

test("auto resolution keeps the long side at most 1280 px", () => {
  assert.equal(scaleFactor("auto", 1920, 1080), 2);
  assert.equal(scaleFactor("auto", 3840, 2160), 3);
  assert.equal(scaleFactor("auto", 1080, 1920), 2);
  assert.equal(scaleFactor("auto", 1280, 720), 1);
  assert.equal(scaleFactor("quarter", 1920, 1080), 4);
});
