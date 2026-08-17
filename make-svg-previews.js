const fs = require("fs");
const path = require("path");
const sharp = require("C:/Users/Matt/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.pnpm/sharp@0.34.5/node_modules/sharp");

const inputDir = "C:/Users/Matt/Desktop/Soro Group Source Logo Files/uniqueplanet-attachments";
const outDir = "C:/Users/Matt/Documents/Soro Website/svg-jpeg-previews";

fs.mkdirSync(outDir, { recursive: true });

const files = fs
  .readdirSync(inputDir)
  .filter((file) => file.toLowerCase().endsWith(".svg"))
  .sort((a, b) => a.localeCompare(b));

function safeName(file) {
  return path.basename(file, ".svg").replace(/[<>:"/\\|?*]+/g, "_");
}

function labelSvg(text, width, height) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#f8fafc"/>
      <text x="32" y="60" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700" fill="#0f172a">${escaped}</text>
    </svg>
  `);
}

async function renderIndividual(file) {
  const input = path.join(inputDir, file);
  const output = path.join(outDir, `${safeName(file)}.jpg`);

  await sharp(input, { density: 220 })
    .resize({
      width: 1600,
      height: 1200,
      fit: "inside",
      withoutEnlargement: false,
      background: "#111827",
    })
    .extend({ top: 80, bottom: 80, left: 80, right: 80, background: "#111827" })
    .flatten({ background: "#111827" })
    .jpeg({ quality: 94 })
    .toFile(output);

  return output;
}

async function makeContactSheet(outputs) {
  const cardWidth = 1200;
  const cardHeight = 760;
  const labelHeight = 100;
  const gap = 36;
  const columns = 2;
  const rows = Math.ceil(outputs.length / columns);
  const width = columns * cardWidth + (columns + 1) * gap;
  const height = rows * cardHeight + (rows + 1) * gap;
  const composites = [];

  for (let i = 0; i < outputs.length; i += 1) {
    const row = Math.floor(i / columns);
    const col = i % columns;
    const left = gap + col * (cardWidth + gap);
    const top = gap + row * (cardHeight + gap);
    const title = path.basename(outputs[i].source);

    const preview = await sharp(outputs[i].jpg)
      .resize({
        width: cardWidth,
        height: cardHeight - labelHeight,
        fit: "contain",
        background: "#111827",
      })
      .toBuffer();

    composites.push({ input: labelSvg(title, cardWidth, labelHeight), left, top });
    composites.push({ input: preview, left, top: top + labelHeight });
  }

  const sheet = path.join(outDir, "all-svg-previews-labeled.jpg");
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#e5e7eb",
    },
  })
    .composite(composites)
    .jpeg({ quality: 92 })
    .toFile(sheet);

  return sheet;
}

(async () => {
  const outputs = [];
  for (const file of files) {
    const jpg = await renderIndividual(file);
    outputs.push({ source: file, jpg });
  }

  const sheet = await makeContactSheet(outputs);
  console.log(JSON.stringify({ count: outputs.length, sheet, folder: outDir }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
