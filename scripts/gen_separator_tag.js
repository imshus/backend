// Generates the pipe-separator regression tag: DW. 0.64|PDUUU
const sharp = require('sharp');
const path = require('path');

const svg = `
<svg width="2200" height="1400" xmlns="http://www.w3.org/2000/svg">
  <rect width="2200" height="1400" fill="#c9b8a8"/>
  <g transform="rotate(-7 1100 700)">
    <rect x="350" y="320" width="1500" height="760" rx="50" fill="#f5f4f0" stroke="#dddddd" stroke-width="5"/>
    <g font-family="Arial" font-size="120" font-weight="700" fill="#222222">
      <text x="470" y="520">G.W. 3.320</text>
      <text x="470" y="680">N.W. 3.192</text>
      <text x="470" y="840">DW. 0.64|PDUUU</text>
    </g>
  </g>
</svg>`;

const out = path.join(__dirname, 'separator_test_tag.jpg');
const outHard = path.join(__dirname, 'separator_test_tag_hard.jpg');

Promise.all([
  sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(out),
  // Degraded variant approximating a real handheld photo: blur + reduced
  // contrast + slight downscale, which makes the "|" glyph ambiguous.
  sharp(Buffer.from(svg))
    .resize({ width: 1400 })
    .blur(1.6)
    .modulate({ brightness: 1.05, saturation: 0.9 })
    .linear(0.82, 18)
    .jpeg({ quality: 72 })
    .toFile(outHard),
]).then(() => {
  console.log(`tag generated: ${out}`);
  console.log(`hard tag generated: ${outHard}`);
});
