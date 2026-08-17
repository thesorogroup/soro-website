const fs = require("fs");
const path = require("path");
const sharp = require(
  "C:/Users/Matt/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.pnpm/sharp@0.34.5/node_modules/sharp"
);

const root = "C:/Users/Matt/Documents/Soro Website";
const outputDir = path.join(root, "linkedin-assets");
const logoDir =
  "C:/Users/Matt/Desktop/Soro Group Source Logo Files/uniqueplanet-attachments";

const profileSize = 400;
const bannerWidth = 4200;
const bannerHeight = 700;

function xmlEscape(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function profileBackground() {
  return Buffer.from(`
    <svg width="${profileSize}" height="${profileSize}" viewBox="0 0 ${profileSize} ${profileSize}"
      xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="profile-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#061b3d"/>
          <stop offset="0.58" stop-color="#082d5c"/>
          <stop offset="1" stop-color="#0d3d76"/>
        </linearGradient>
        <radialGradient id="profile-glow" cx="76%" cy="16%" r="64%">
          <stop offset="0" stop-color="#fda702" stop-opacity=".42"/>
          <stop offset=".38" stop-color="#fd4a04" stop-opacity=".15"/>
          <stop offset="1" stop-color="#fd4a04" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="profile-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#fda702"/>
          <stop offset=".55" stop-color="#fd7b07"/>
          <stop offset="1" stop-color="#fd4a04"/>
        </linearGradient>
      </defs>

      <rect width="400" height="400" rx="30" fill="url(#profile-bg)"/>
      <rect width="400" height="400" rx="30" fill="url(#profile-glow)"/>

      <circle cx="200" cy="204" r="158" fill="#03152d" opacity=".34"/>
      <circle cx="200" cy="198" r="154" fill="none" stroke="#ffffff" stroke-opacity=".12" stroke-width="2"/>
      <circle cx="200" cy="198" r="149" fill="#fffaf4"/>
      <circle cx="200" cy="198" r="149" fill="none" stroke="url(#profile-ring)" stroke-width="6"/>
      <circle cx="200" cy="198" r="138" fill="none" stroke="#082d5c" stroke-opacity=".10" stroke-width="2"/>

      <path d="M70 52l4.2 10.8L85 67l-10.8 4.2L70 82l-4.2-10.8L55 67l10.8-4.2L70 52z"
        fill="#ffffff" opacity=".68"/>
      <circle cx="334" cy="307" r="5" fill="#fda702" opacity=".9"/>
      <circle cx="324" cy="322" r="2.5" fill="#ffffff" opacity=".55"/>
    </svg>
  `);
}

function bannerBackground() {
  const taglineOne = xmlEscape("Where businesses grow");
  const taglineTwo = xmlEscape("and talent thrives.");

  return Buffer.from(`
    <svg width="${bannerWidth}" height="${bannerHeight}" viewBox="0 0 ${bannerWidth} ${bannerHeight}"
      xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="banner-bg" x1="0" y1="0" x2="1" y2=".12">
          <stop offset="0" stop-color="#061831"/>
          <stop offset=".44" stop-color="#082d5c"/>
          <stop offset="1" stop-color="#0c3b71"/>
        </linearGradient>
        <radialGradient id="left-glow" cx="0" cy=".5" r=".72">
          <stop offset="0" stop-color="#fd4a04" stop-opacity=".28"/>
          <stop offset=".48" stop-color="#fd4a04" stop-opacity=".08"/>
          <stop offset="1" stop-color="#fd4a04" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="right-glow" cx="1" cy=".18" r=".72">
          <stop offset="0" stop-color="#fda702" stop-opacity=".20"/>
          <stop offset=".42" stop-color="#fda702" stop-opacity=".06"/>
          <stop offset="1" stop-color="#fda702" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#fda702"/>
          <stop offset=".55" stop-color="#fd7b07"/>
          <stop offset="1" stop-color="#fd4a04"/>
        </linearGradient>
        <pattern id="dot-field" width="38" height="38" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="2" fill="#ffffff" opacity=".18"/>
        </pattern>
      </defs>

      <rect width="4200" height="700" fill="url(#banner-bg)"/>
      <rect width="4200" height="700" fill="url(#left-glow)"/>
      <rect width="4200" height="700" fill="url(#right-glow)"/>

      <circle cx="105" cy="350" r="450" fill="none" stroke="#fda702" stroke-opacity=".13" stroke-width="3"/>
      <circle cx="105" cy="350" r="370" fill="none" stroke="#ffffff" stroke-opacity=".07" stroke-width="3"/>
      <circle cx="4090" cy="70" r="310" fill="none" stroke="#ffffff" stroke-opacity=".09" stroke-width="3"/>
      <circle cx="4090" cy="70" r="245" fill="none" stroke="#fda702" stroke-opacity=".16" stroke-width="3"/>
      <rect x="3540" y="50" width="520" height="300" fill="url(#dot-field)" opacity=".40"/>

      <path d="M0 617 C 620 534 1015 660 1600 595 C 2330 514 2800 655 3500 573 C 3770 541 4000 547 4200 571 L4200 700 L0 700Z"
        fill="#fffaf4" opacity=".045"/>
      <path d="M0 622 C 620 539 1015 665 1600 600 C 2330 519 2800 660 3500 578 C 3770 546 4000 552 4200 576"
        fill="none" stroke="url(#accent)" stroke-width="5" stroke-opacity=".86"/>

      <rect x="1834" y="166" width="5" height="368" rx="2.5" fill="#ffffff" opacity=".26"/>
      <rect x="1834" y="269" width="5" height="94" rx="2.5" fill="url(#accent)"/>

      <text x="2020" y="306" fill="#fffaf4" font-family="Georgia, 'Times New Roman', serif"
        font-size="86" font-weight="400" letter-spacing="-1">${taglineOne}</text>
      <text x="2020" y="421" fill="#fffaf4" font-family="Georgia, 'Times New Roman', serif"
        font-size="86" font-weight="400" letter-spacing="-1">${taglineTwo}</text>

      <rect x="2023" y="474" width="315" height="7" rx="3.5" fill="url(#accent)"/>
      <path d="M2374 461l5.5 14.5 14.5 5.5-14.5 5.5-5.5 14.5-5.5-14.5-14.5-5.5 14.5-5.5 5.5-14.5z"
        fill="#fda702"/>
    </svg>
  `);
}

async function renderTrimmedLogo(fileName, options) {
  const inputPath = path.join(logoDir, fileName);
  return sharp(inputPath, { density: 500 })
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .resize({
      ...options,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

async function makeProfile() {
  const icon = await renderTrimmedLogo("solo_icon.svg", {
    height: 276,
    width: 205,
    fit: "contain",
  });
  const metadata = await sharp(icon).metadata();
  const left = Math.round((profileSize - metadata.width) / 2);
  const top = Math.round((profileSize - metadata.height) / 2) - 1;

  return sharp(profileBackground())
    .composite([{ input: icon, left, top }])
    .png({ compressionLevel: 9, effort: 10 })
    .toFile(path.join(outputDir, "soro-linkedin-profile.png"));
}

async function makeBanner() {
  const horizontalLogo = await renderTrimmedLogo("solo_horizontal white.svg", {
    height: 370,
    width: 590,
    fit: "contain",
  });
  const metadata = await sharp(horizontalLogo).metadata();
  const left = 1120 + Math.round((600 - metadata.width) / 2);
  const top = Math.round((bannerHeight - metadata.height) / 2) - 5;

  return sharp(bannerBackground())
    .composite([{ input: horizontalLogo, left, top }])
    .png({ compressionLevel: 9, effort: 10 })
    .toFile(path.join(outputDir, "soro-linkedin-banner.png"));
}

async function makePreview() {
  const previewWidth = 1400;
  const previewHeight = 575;
  const banner = await sharp(path.join(outputDir, "soro-linkedin-banner.png"))
    .resize({ width: previewWidth, height: 233, fit: "fill" })
    .toBuffer();
  const profile = await sharp(path.join(outputDir, "soro-linkedin-profile.png"))
    .resize({ width: 250, height: 250 })
    .extend({ top: 8, bottom: 8, left: 8, right: 8, background: "#ffffff" })
    .png()
    .toBuffer();

  const lowerPanel = Buffer.from(`
    <svg width="${previewWidth}" height="${previewHeight}" viewBox="0 0 ${previewWidth} ${previewHeight}"
      xmlns="http://www.w3.org/2000/svg">
      <rect width="1400" height="575" fill="#eef1f5"/>
      <rect y="229" width="1400" height="346" fill="#ffffff"/>
      <text x="372" y="348" font-family="Arial, Helvetica, sans-serif" font-size="50" font-weight="700" fill="#172033">Soro Group</text>
      <text x="374" y="403" font-family="Arial, Helvetica, sans-serif" font-size="28" fill="#667085">Where businesses grow and talent thrives.</text>
      <rect x="374" y="450" width="195" height="9" rx="4.5" fill="#f45a1f"/>
    </svg>
  `);

  await sharp(lowerPanel)
    .composite([
      { input: banner, left: 0, top: 0 },
      { input: profile, left: 72, top: 155 },
    ])
    .png({ compressionLevel: 9, effort: 10 })
    .toFile(path.join(outputDir, "soro-linkedin-preview.png"));
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  await Promise.all([makeProfile(), makeBanner()]);
  await makePreview();

  const files = [
    "soro-linkedin-profile.png",
    "soro-linkedin-banner.png",
    "soro-linkedin-preview.png",
  ];
  const results = [];
  for (const file of files) {
    const filePath = path.join(outputDir, file);
    const metadata = await sharp(filePath).metadata();
    results.push({
      file,
      width: metadata.width,
      height: metadata.height,
      bytes: fs.statSync(filePath).size,
    });
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
