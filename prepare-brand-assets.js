const fs = require("fs");
const path = require("path");
const sharp = require("C:/Users/Matt/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.pnpm/sharp@0.34.5/node_modules/sharp");

const root = "C:/Users/Matt/Documents/Soro Website";
const assets = path.join(root, "assets");
const sources = path.join(assets, "source-photos");
const suppliedLogo =
  "C:/Users/Matt/Desktop/Soro Group Source Logo Files/uniqueplanet-attachments/solo_horizontal.svg";

function featherMask(width, height, feather) {
  const inset = feather;
  const innerWidth = Math.max(1, width - inset * 2);
  const innerHeight = Math.max(1, height - inset * 2);

  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="soft-edge" x="-25%" y="-25%" width="150%" height="150%">
          <feGaussianBlur stdDeviation="${Math.max(1, feather / 2)}"/>
        </filter>
      </defs>
      <rect x="${inset}" y="${inset}" width="${innerWidth}" height="${innerHeight}"
        rx="${feather}" fill="#fff" filter="url(#soft-edge)"/>
    </svg>
  `);
}

async function makePatch(editPath, patch) {
  const crop = await sharp(editPath)
    .extract({
      left: patch.left,
      top: patch.top,
      width: patch.width,
      height: patch.height,
    })
    .ensureAlpha()
    .png()
    .toBuffer();

  return sharp(crop)
    .composite([
      {
        input: featherMask(patch.width, patch.height, patch.feather),
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();
}

async function mergeLogoEdits(originalName, editName, outputName, patches) {
  const originalPath = path.join(sources, originalName);
  const editPath = path.join(sources, editName);
  const originalMeta = await sharp(originalPath).metadata();
  const editMeta = await sharp(editPath).metadata();

  if (originalMeta.width !== editMeta.width || originalMeta.height !== editMeta.height) {
    throw new Error(`Dimension mismatch for ${outputName}`);
  }

  const composites = [];
  for (const patch of patches) {
    composites.push({
      input: await makePatch(editPath, patch),
      left: patch.left,
      top: patch.top,
    });
  }

  await sharp(originalPath)
    .composite(composites)
    .webp({ quality: 96, effort: 6, smartSubsample: true })
    .toFile(path.join(assets, outputName));
}

async function optimizeOriginal(originalName, outputName) {
  await sharp(path.join(sources, originalName))
    .webp({ quality: 96, effort: 6, smartSubsample: true })
    .toFile(path.join(assets, outputName));
}

async function installLogo() {
  const svg = fs.readFileSync(suppliedLogo, "utf8");
  const cropped = svg.replace(
    /viewBox="0 0 2000 2000"/,
    'viewBox="325 465 1350 860"'
  );

  if (cropped === svg) {
    throw new Error("Could not crop the supplied logo viewBox");
  }

  fs.writeFileSync(path.join(assets, "soro-logo-horizontal.svg"), cropped);
}

async function main() {
  await installLogo();

  await Promise.all([
    mergeLogoEdits(
      "home-hero-original.png",
      "home-hero-logo-edit.png",
      "soro-home-hero.webp",
      [
        { left: 1280, top: 145, width: 270, height: 190, feather: 14 },
        { left: 600, top: 750, width: 125, height: 100, feather: 9 },
      ]
    ),
    mergeLogoEdits(
      "soro-group-image-2-original.png",
      "soro-group-image-2-logo-edit.png",
      "soro-group-image-2.webp",
      [
        { left: 880, top: 25, width: 430, height: 255, feather: 16 },
        { left: 735, top: 580, width: 160, height: 125, feather: 10 },
        { left: 785, top: 915, width: 200, height: 155, feather: 11 },
      ]
    ),
    mergeLogoEdits(
      "soro-group-image-1-original.png",
      "soro-group-image-1-logo-edit.png",
      "soro-group-image-1.webp",
      [
        { left: 740, top: 30, width: 500, height: 280, feather: 18 },
        { left: 150, top: 770, width: 250, height: 200, feather: 12 },
      ]
    ),
    optimizeOriginal("soro-group-image-4-original.png", "soro-group-image-4.webp"),
    optimizeOriginal("soro-group-image-5-original.png", "soro-group-image-5.webp"),
  ]);

  const outputNames = [
    "soro-logo-horizontal.svg",
    "soro-home-hero.webp",
    "soro-group-image-1.webp",
    "soro-group-image-2.webp",
    "soro-group-image-4.webp",
    "soro-group-image-5.webp",
  ];
  const output = [];

  for (const name of outputNames) {
    const filePath = path.join(assets, name);
    const stats = fs.statSync(filePath);
    if (name.endsWith(".svg")) {
      output.push({ name, bytes: stats.size });
      continue;
    }

    const metadata = await sharp(filePath).metadata();
    output.push({
      name,
      width: metadata.width,
      height: metadata.height,
      bytes: stats.size,
    });
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
