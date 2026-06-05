import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync("c:\\Users\\EswarSaiBandi\\Desktop\\DE_CRM\\Digital Edify Agentic CRM (standalone).html", "utf8");

function extract(typeAttr) {
  const open = `<script type="${typeAttr}">`;
  const close = "</script>";
  const i = src.indexOf(open);
  if (i < 0) throw new Error("no " + typeAttr);
  const start = i + open.length;
  const j = src.indexOf(close, start);
  return src.slice(start, j);
}

const templateJson = extract("__bundler/template");
const template = JSON.parse(templateJson);

writeFileSync("c:\\Users\\EswarSaiBandi\\Desktop\\DE_CRM\\extracted.html", template, "utf8");
console.log("template length:", template.length);
console.log("first 600 chars:");
console.log(template.slice(0, 600));
