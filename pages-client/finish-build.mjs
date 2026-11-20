import { mkdir, readFile, writeFile } from "node:fs/promises";

const index = await readFile("dist-pages/index.html", "utf8");
await mkdir("dist-pages/account", { recursive: true });
const favicon = (process.env.CHATHUB_BASE ?? "/") + "favicon.svg";
await writeFile("dist-pages/account/index.html", index.replace('./favicon.svg', favicon));
await writeFile("dist-pages/.nojekyll", "");
if (process.env.CHATHUB_FRONTEND_HOST) {
  await writeFile("dist-pages/CNAME", process.env.CHATHUB_FRONTEND_HOST + "\n");
}
