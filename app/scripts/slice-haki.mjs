/* Haki sprite sheet 切帧脚本
 * 输入:AI 生成的 2x2 网格绿幕 sheet(JPG/PNG)
 * 处理:切格 → 抠绿(色键+去绿边) → 四帧统一包围盒裁剪(保持帧间相对位移) →
 *       nearest 缩放 → 底对齐拼横向 strip → 对齐质检
 * 输出:app/src/assets/haki/{push,switch,code,sleep}.png
 *
 * 用法:node scripts/slice-haki.mjs <raw目录>
 *   raw目录结构:<raw>/push/xxx.jpg <raw>/switch/xxx.jpg ...
 */
import sharp from "sharp";
import { readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src/assets/haki");
// 每套动作:strip 帧画布(2x 于挂件显示尺寸 40/64 x 40)
const SHEETS = {
  push: { fw: 80, fh: 80 },
  switch: { fw: 80, fh: 80 },
  code: { fw: 128, fh: 80 },
  sleep: { fw: 80, fh: 80 },
};

const rawRoot = process.argv[2];
if (!rawRoot) {
  console.error("用法: node scripts/slice-haki.mjs <raw目录>");
  process.exit(1);
}

/** 绿幕判定:绿显著高于红蓝 */
const isGreen = (r, g, b) => g > 90 && g > r * 1.35 && g > b * 1.35;

async function processSheet(name, spec) {
  const dir = join(rawRoot, name);
  const file = readdirSync(dir).find((f) => /\.(png|jpe?g|webp)$/i.test(f));
  if (!file) throw new Error(`${dir} 里没有图片`);
  const img = sharp(join(dir, file));
  const { width: W, height: H } = await img.metadata();
  const cw = Math.floor(W / 2), ch = Math.floor(H / 2);

  // 2x2 切格 → RGBA 原始像素
  const cells = [];
  for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const { data } = await sharp(join(dir, file))
      .extract({ left: cx * cw, top: cy * ch, width: cw, height: ch })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // 抠绿 + 去绿边(残余绿色压到红蓝上限)
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (isGreen(r, g, b)) data[i + 3] = 0;
      else if (g > Math.max(r, b)) data[i + 1] = Math.max(r, b);
    }
    cells.push(data);
  }

  // 四帧统一包围盒(union):裁同一矩形,保留帧间相对位移(动画不跳)
  let minX = cw, minY = ch, maxX = 0, maxY = 0;
  const bboxes = [];
  for (const data of cells) {
    let x0 = cw, y0 = ch, x1 = 0, y1 = 0;
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++)
        if (data[(y * cw + x) * 4 + 3] > 30) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    bboxes.push({ x0, y0, x1, y1 });
    minX = Math.min(minX, x0); minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1);
  }
  const uw = maxX - minX + 1, uh = maxY - minY + 1;

  // 质检:各帧内容中心水平偏移 / 脚底基线漂移(>8% 单元格宽即警告,翻转会横跳)
  const centers = bboxes.map((b) => (b.x0 + b.x1) / 2);
  const bottoms = bboxes.map((b) => b.y1);
  const cSpread = Math.max(...centers) - Math.min(...centers);
  const bSpread = Math.max(...bottoms) - Math.min(...bottoms);
  const warn = [];
  if (cSpread > cw * 0.08) warn.push(`水平中心漂移 ${cSpread}px`);
  if (bSpread > ch * 0.05) warn.push(`脚底基线漂移 ${bSpread}px`);

  // 各帧:union 裁剪 → contain 缩放进帧画布(底对齐水平居中) → 拼 strip
  const scale = Math.min(spec.fw / uw, spec.fh / uh);
  const sw = Math.max(1, Math.round(uw * scale)), sh = Math.max(1, Math.round(uh * scale));
  const frames = [];
  for (const data of cells) {
    const buf = await sharp(data, { raw: { width: cw, height: ch, channels: 4 } })
      .extract({ left: minX, top: minY, width: uw, height: uh })
      .resize(sw, sh, { kernel: "nearest" })
      .png()
      .toBuffer();
    frames.push(buf);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  await sharp({
    create: { width: spec.fw * 4, height: spec.fh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(frames.map((input, i) => ({
      input,
      left: i * spec.fw + Math.round((spec.fw - sw) / 2),
      top: spec.fh - sh, // 底对齐:脚站在帧画布底边
    })))
    .png()
    .toFile(join(OUT_DIR, `${name}.png`));

  console.log(
    `${name}: ${W}x${H} → strip ${spec.fw * 4}x${spec.fh} (content ${sw}x${sh})` +
      (warn.length ? `  ⚠ ${warn.join(" / ")}` : "  ✓ 对齐正常")
  );
}

for (const [name, spec] of Object.entries(SHEETS)) {
  await processSheet(name, spec);
}
console.log(`输出目录: ${OUT_DIR}`);
