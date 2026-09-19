const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");
const outdir = path.join(__dirname, "dist");

fs.mkdirSync(outdir, { recursive: true });
fs.copyFileSync(
  path.join(__dirname, "manifest.json"),
  path.join(outdir, "manifest.json"),
);
fs.copyFileSync(
  path.join(__dirname, "src/popup/popup.html"),
  path.join(outdir, "popup.html"),
);
fs.copyFileSync(
  path.join(__dirname, "src/popup/popup.css"),
  path.join(outdir, "popup.css"),
);

const buildOptions = {
  entryPoints: {
    popup: path.join(__dirname, "src/popup/popup.ts"),
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
