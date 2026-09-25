const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");
const outdir = path.join(__dirname, "dist");

// Start from an empty dist/ so files from removed entry points (the old
// action popup's popup.html/js/css) can't linger and get loaded by mistake.
// Skipped in watch mode, where Chrome may have the unpacked extension open.
if (!watch) fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });
fs.copyFileSync(
  path.join(__dirname, "manifest.json"),
  path.join(outdir, "manifest.json"),
);
fs.copyFileSync(
  path.join(__dirname, "src/panel/panel.html"),
  path.join(outdir, "panel.html"),
);
fs.copyFileSync(
  path.join(__dirname, "src/panel/panel.css"),
  path.join(outdir, "panel.css"),
);

fs.mkdirSync(path.join(outdir, "icons"), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  fs.copyFileSync(
    path.join(__dirname, `icons/icon${size}.png`),
    path.join(outdir, `icons/icon${size}.png`),
  );
}

const configSrc = fs.existsSync(path.join(__dirname, "config.json"))
  ? "config.json"
  : "config.example.json";
if (configSrc === "config.example.json") {
  console.warn(
    "extension/config.json not found — using config.example.json. " +
      "Copy it to config.json and fill in your Google OAuth client ID (see SETUP.md).",
  );
}
fs.copyFileSync(path.join(__dirname, configSrc), path.join(outdir, "config.json"));

const buildOptions = {
  entryPoints: {
    panel: path.join(__dirname, "src/panel/panel.ts"),
    background: path.join(__dirname, "src/background/background.ts"),
  },
  bundle: true,
  outdir,
  target: "es2020",
  format: "iife",
};

async function run() {
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    await esbuild.build(buildOptions);
    console.log("Built extension to dist/");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
