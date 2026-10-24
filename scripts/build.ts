export {};

const entries = [...new Bun.Glob("src/*/main.ts").scanSync()].sort();
for (const entry of entries) {
  const name = entry.split("/")[1];
  const result = await Bun.build({ entrypoints: [entry], target: "node", format: "esm", outdir: "dist", naming: `${name}.js` });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log(`dist/${name}.js`);
}
