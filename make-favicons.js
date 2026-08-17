const path = require("path");
const sharp = require("C:/Users/Matt/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp");

const root = __dirname;
const source = path.join(root, "assets", "soro-logo-final-transparent.png");
const destinations = [path.join(root, "assets"), path.join(root, "netlify-upload", "assets")];

async function tile(size) {
  const padding = Math.max(1, Math.round(size * 0.02));

  return sharp(source)
    .extract({ left: 0, top: 0, width: 759, height: 1023 })
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .resize(size - padding * 2, size - padding * 2, { fit: "contain" })
    .extend({
      top: padding,
      bottom: padding,
      left: padding,
      right: padding,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function main() {
  const [large, small, apple] = await Promise.all([tile(512), tile(32), tile(180)]);

  for (const destination of destinations) {
    await Promise.all([
      sharp(large).toFile(path.join(destination, "favicon.png")),
      sharp(small).toFile(path.join(destination, "favicon-32x32.png")),
      sharp(apple).toFile(path.join(destination, "apple-touch-icon.png")),
    ]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
