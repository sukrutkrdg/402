/**
 * IndexNow push — tell Bing (and Yandex/Seznam/Naver) a page changed instead of
 * waiting to be crawled. The key lives at /5a7ee235d1aaa57249cd8792910d66d9.txt
 * and must stay served, or every submission comes back 403.
 *
 * Submits whatever /sitemap.xml currently lists, so adding a page to
 * src/app/sitemap.ts is the only place a URL has to be registered:
 * `node scripts/indexnow.mjs`
 */

const KEY = "5a7ee235d1aaa57249cd8792910d66d9";
const SITE = "https://402.com.tr";
const HOST = new URL(SITE).host;

async function sitemapUrls() {
  const xml = await (await fetch(`${SITE}/sitemap.xml`)).text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

const urlList = await sitemapUrls();
if (!urlList.length) {
  console.error("sitemap.xml listed no URLs — nothing to submit");
  process.exit(1);
}

const res = await fetch("https://api.indexnow.org/IndexNow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `${SITE}/${KEY}.txt`, urlList }),
});

// 200 and 202 both mean accepted; 403 means the key file stopped being served.
console.log(`${res.status} ${res.statusText} — submitted ${urlList.length} URLs`);
for (const u of urlList) console.log(`  ${u}`);
process.exit(res.ok ? 0 : 1);
