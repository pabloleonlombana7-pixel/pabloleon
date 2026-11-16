// Bundles run.ts together with the plugin's trading code into dist/run.mjs.
// Live-only modules (wallet keys, Twitter, elizaOS core) are replaced by stubs,
// so this build physically cannot sign transactions or post tweets.
import * as esbuild from "esbuild";
import * as path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));

const stubs = {
  "@elizaos/core": "export {};",
  "agent-twitter-client":
    'export class Scraper { constructor() { throw new Error("Tweets are disabled in the paper trader."); } }',
  keypairUtils:
    'export async function getWalletKey() { throw new Error("Wallet access is disabled in the paper trader."); }',
};

const stubPlugin = {
  name: "live-stubs",
  setup(build) {
    build.onResolve({ filter: /^@elizaos\/core$|^agent-twitter-client$|keypairUtils(\.ts)?$/ }, (args) => ({
      path: args.path.includes("keypairUtils") ? "keypairUtils" : args.path,
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
  },
};

await esbuild.build({
  entryPoints: [path.join(here, "run.ts")],
  outfile: path.join(here, "dist", "run.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  nodePaths: [path.join(here, "node_modules")],
  plugins: [stubPlugin],
  banner: {
    js:
      "import { createRequire } from 'module'; import { fileURLToPath as __fup } from 'url'; import { dirname as __dn } from 'path';" +
      " const require = createRequire(import.meta.url); const __filename = __fup(import.meta.url); const __dirname = __dn(__filename);",
  },
  logLevel: "warning",
});
