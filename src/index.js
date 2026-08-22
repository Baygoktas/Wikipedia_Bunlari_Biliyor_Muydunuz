export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBot(env));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    try {
      const result = await runBot(env);
      return new Response(result || "İşlem başarıyla tamamlandı.", { 
        status: 200, 
        headers: { "Content-Type": "text/plain; charset=utf-8" } 
      });
    } catch (err) {
      console.error("Worker Hatası:", err);
      return new Response(`Hata Detayı:\n${err.message}\n\nStack:\n${err.stack}`, { 
        status: 500, 
        headers: { "Content-Type": "text/plain; charset=utf-8" } 
      });
    }
  }
};

const WIKI_HEADERS = {
  "User-Agent": "WikipediaBiliyorMuydunuzBot/2.0 (https://t.me/baygoktas; contact: telegramherokuhesabi3@gmail.com)",
  "Api-User-Agent": "WikipediaBiliyorMuydunuzBot/2.0 (https://t.me/baygoktas; contact: telegramherokuhesabi3@gmail.com)",
  "Accept": "application/json"
};

async function fetchWithRetry(url, options = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, options);
    if (res.status !== 429 && res.status !== 503) {
      return res;
    }
    // Rate limit durumunda bekle ve tekrar dene
    await new Promise(r => setTimeout(r, (i + 1) * 1500));
  }
  return fetch(url, options);
}

async function runBot(env) {
  const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID || "-1004385291535";

  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN ortam değişkeni bulunamadı!");
  }

  // 1. Rastgele tarih aralığı
  const now = new Date();
  const cutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const start = new Date("2010-01-01T00:00:00Z");

  const randomMs = Math.floor(Math.random() * (cutoff.getTime() - start.getTime()));
  const targetDate = new Date(start.getTime() + randomMs);
  const targetDateStr = targetDate.toISOString().slice(0, 10);

  // 2. Arşiv listesini çek
  const listUrl = new URL("https://tr.wikipedia.org/w/api.php");
  listUrl.search = new URLSearchParams({
    action: "query",
    list: "allpages",
    apnamespace: "4",
    apprefix: "Biliyor_muydunuz?/",
    aplimit: "50",
    format: "json",
    formatversion: "2",
    apfrom: `Biliyor_muydunuz?/${targetDateStr}`
  });

  const listRes = await fetchWithRetry(listUrl, { headers: WIKI_HEADERS });
  
  if (!listRes.ok) {
    throw new Error(`Wikipedia liste API hatası (${listRes.status}): ${listRes.statusText}`);
  }

  const listData = await listRes.json();
  const pages = listData?.query?.allpages || [];

  const candidates = pages
    .map(p => p.title || "")
    .map(title => {
      const m = title.match(/(\d{4})-(\d{2})-(\d{2})$/);
      return m ? { title, date: `${m[1]}-${m[2]}-${m[3]}` } : null;
    })
    .filter(Boolean)
    .filter(x => new Date(x.date).getTime() < cutoff.getTime());

  if (!candidates.length) {
    return "Aday arşiv sayfası bulunamadı, bir sonraki cron çalışmasında tekrar denenecek.";
  }

  // 3. D1 üzerinden mükerrer kontrolü
  const shuffled = candidates.sort(() => 0.5 - Math.random());
  let selected = null;

  for (const item of shuffled) {
    const row = await env.DB.prepare("SELECT page_title FROM sent_facts WHERE page_title = ?")
      .bind(item.title)
      .first();

    if (!row) {
      selected = item;
      break;
    }
  }

  if (!selected) {
    selected = shuffled[0];
  }

  // 4. İçeriği çek
  const parseUrl = new URL("https://tr.wikipedia.org/w/api.php");
  parseUrl.search = new URLSearchParams({
    action: "parse",
    page: selected.title,
    format: "json",
    formatversion: "2",
    prop: "wikitext",
    redirects: "1"
  });

  const parseRes = await fetchWithRetry(parseUrl, { headers: WIKI_HEADERS });
  const parseData = await parseRes.json();
  const rawWikitext = parseData?.parse?.wikitext || "";

  if (!rawWikitext) {
    return `Sayfa içeriği boş geldi: ${selected.title}`;
  }

  // 5. Görsel var mı kontrol et
  const imageMatch = rawWikitext.match(/\[\[(?:Dosya|File|Media):([^|\]]+)/i);
  let imageUrl = null;

  if (imageMatch && imageMatch[1]) {
    imageUrl = await fetchWikipediaImageUrl(imageMatch[1].trim());
  }

  // 6. Metni temizle
  let cleanText = temizleWikitext(rawWikitext);
  cleanText = cleanText.replace(/^(?:Vikipedi|Biliyor muydu(?:nuz)?\??|Arşiv|Ana sayfa)[^.!?]*[.!?]?\s*/i, "").trim();

  if (!cleanText || cleanText.length < 20) {
    return "Metin temizlendikten sonra kullanılabilir uzunlukta kalmadı.";
  }

  const encodedPageTitle = encodeURIComponent(selected.title.replace(/ /g, "_"));
  const dynamicSourceUrl = `https://tr.wikipedia.org/wiki/${encodedPageTitle}`;

  const messageText = 
    `💡 <b>BİLİYOR MUYDUNUZ?</b>\n\n` +
    `👀 ${escapeHtml(cleanText)}\n\n` +
    `🔎 Kaynak: <a href="${dynamicSourceUrl}">Vikipedia</a>`;

  // 7. Telegram'a gönder
  let tgSuccess = false;

  if (imageUrl) {
    const tgPhotoUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
    const res = await fetch(tgPhotoUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        photo: imageUrl,
        caption: messageText,
        parse_mode: "HTML"
      })
    });
    const photoData = await res.json();
    tgSuccess = photoData.ok;
  }

  if (!imageUrl || !tgSuccess) {
    const tgMsgUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(tgMsgUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: messageText,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
    const msgData = await res.json();
    if (!msgData.ok) {
      throw new Error(`Telegram API Hatası: ${msgData.description || JSON.stringify(msgData)}`);
    }
    tgSuccess = true;
  }

  // 8. D1 Veritabanına kaydet
  if (tgSuccess) {
    const factHash = simpleHash(cleanText);
    await env.DB.prepare("INSERT OR IGNORE INTO sent_facts (page_title, fact_hash) VALUES (?, ?)")
      .bind(selected.title, factHash)
      .run();
  }

  return `Başarılı! Mesaj gönderildi: ${selected.title}`;
}

async function fetchWikipediaImageUrl(fileName) {
  try {
    const imgApiUrl = new URL("https://tr.wikipedia.org/w/api.php");
    imgApiUrl.search = new URLSearchParams({
      action: "query",
      titles: `File:${fileName}`,
      prop: "imageinfo",
      iiprop: "url",
      format: "json",
      formatversion: "2"
    });

    const res = await fetchWithRetry(imgApiUrl, { headers: WIKI_HEADERS });
    const data = await res.json();
    const pages = data?.query?.pages;
    if (pages && pages[0]?.imageinfo && pages[0].imageinfo[0]?.url) {
      return pages[0].imageinfo[0].url;
    }
  } catch (e) {
    console.error("Görsel çözümleme hatası:", e);
  }
  return null;
}

function temizleWikitext(s) {
  return String(s || "")
    .replace(/<ref[^>]*\/>/gi, " ")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, " ")
    .replace(/<gallery[\s\S]*?<\/gallery>/gi, " ")
    .replace(/<div[^>]*>/gi, " ")
    .replace(/<\/div>/gi, " ")
    .replace(/<span[^>]*>/gi, " ")
    .replace(/<\/span>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\{\{[^{}]*\}\}/g, " ")
    .replace(/\[\[(?:Dosya|File|Media):[^\]]+\]\]/gi, " ")
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, "$1")
    .replace(/'{2,3}/g, "")
    .replace(/\b\d{2,4}x\d{2,4}px\b/gi, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
}
