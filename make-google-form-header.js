const path = require("path");
const sharp = require("C:/Users/Matt/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.pnpm/sharp@0.34.5/node_modules/sharp");

const root = __dirname;
const logo = path.join(root, "assets", "soro-logo-horizontal.svg");
const output = path.join(root, "soro-google-form-header.jpg");

async function main() {
  const width = 1600;
  const height = 400;
  const background = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#ffffff"/>
    </svg>
  `);

  const logoBuffer = await sharp(logo, { density: 240 })
    .resize({
      width: 680,
      height: 320,
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toBuffer();

  await sharp(background)
    .composite([{ input: logoBuffer, gravity: "center" }])
    .jpeg({ quality: 94, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toFile(output);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
