# NEAR ekosistemi iş planı

> Durum: Faz 0 ve Faz 1 **canlıda**, ilk NEAR satışı 2026-09-26 · Faz 2: yeni pazarın API'si bulundu, tasarım bekliyor · sahibi: sukrutkrdg
> Bu belge hem iş planı hem geliştirme yol haritasıdır. Claude ile yapılan her
> geliştirme oturumu buradan başlar; bir faz bittiğinde "Durum" satırı güncellenir.

## 1. Hedef

NEAR ekosistemindeki ajanların x402 Bazaar'ı **bulmasını**, **en az sürtünmeyle satın
almasını** ve bundan **gelir** elde etmeyi sağlamak. Bunu yaparken bugün Base'de çalışan
sisteme dokunmamak.

## 2. Değişmez kurallar (çalışan sistemi korumak için)

1. **`accepts[]` listesine NEAR girmez.** `src/lib/config.ts` içindeki `NETWORK`,
   `EXTRA_NETWORKS` ve `src/lib/x402-server.ts` değişmez. Polygon deneyi (bkz.
   `config.ts:15-37`) ikinci bir ağın hiç ödeme getirmediğini ve en az bir ajan
   istemcisinin bu yüzden servislerimizi atladığını gösterdi.
2. **Para her zaman Base'de USDC olarak `PAY_TO_ADDRESS` adresine gelir.** NEAR yalnızca
   ödemenin *geldiği* yer olur; *alındığı* yer olmaz.
3. **Her yeni parça ayrı dosyada durur ve bir env bayrağıyla kapatılabilir**
   (`ENABLE_NEAR_CREDITS`, `ENABLE_NEAR_MARKET`). Bayrak kapalıyken davranış bugünküyle
   birebir aynı olmalı ve bunu bir test doğrulamalı.
4. **Kredi basmanın tek yolu `mintCredits` fonksiyonudur** (`src/lib/credits.ts`). Yeni
   ödeme yolları bu fonksiyona bağlanır; kendi bakiye mantıklarını yazmazlar.
5. **Her kanalın kendi sayacı olur.** Hangi kanalın para getirdiğini ölçemediğimiz bir
   şeyi büyütmeyiz.

## 3. NEAR ajanları bize hangi yoldan gelir?

| Kanal | Ajan nerede? | Bize nasıl ödüyor? | Bizim işimiz |
|---|---|---|---|
| **A. Chain Signatures** | NEAR hesabı olan, EVM adresi yöneten ajan (Shade Agents vb.) | Base'de doğrudan x402 ile ödüyor | Sadece belgelendirme |
| **B. NEAR Intents** | NEAR'da ya da başka bir zincirde varlığı olan ajan | Herhangi bir tokenla ödüyor, 1Click takası sonucunda Base USDC'ye çevriliyor | Kredi paketi satan yeni bir satın alma yolu |
| **C. NEAR AI Agent Market** ([market.near.ai](https://market.near.ai)) | İş ilanı veren kullanıcılar ve ajanlar | İşi yaptığımızda NEAR ile ödüyorlar | İşlere teklif veren bir çalışan ajan |

Konumlandırma: **"NEAR ajanları için Base güvenlik ve veri katmanı"**. NEAR Intents ile
Base'de token alan bir ajan, almadan önce tam da bizim sattığımız kontrollere ihtiyaç duyar
(`pre-trade-gate`, `token-risk`, `b20-safety`, `sanctions`). NEAR zincirine özel veri
servisleri yazmak bu planın kapsamında değil (bkz. Faz 3).

## 4. Fazlar

### Faz 0 — Görünürlük (1–2 gün, risk yok)

**Durum: uygulandı.** `src/lib/near-funding.ts` tek kaynak; llms.txt, agent-card (`fundingOptions.near`), `/agents` (2c) ve `skill/SKILL.md` buradan besleniyor. Link bazlı `ref=near` sayacı eklenmedi: bunun için ücretli ana rotaya dokunmak gerekirdi. Ölçüm onun yerine Faz 1 sayaçlarından yapılıyor (teklif → satılan paket).

**Amaç:** NEAR ajanlarının bizi bulması ve Base'de nasıl ödeyeceklerini anlaması.

- `/llms.txt` (`src/app/api/llms/route.ts`): "NEAR ajanları için" paragrafı. Chain
  Signatures ile Base'de x402 ödemesi nasıl yapılır, Faz 1 açıldığında da Intents ile
  kredi nasıl alınır.
- `/.well-known/agent.json` (`src/app/api/agent-card/route.ts`): `capabilities.payments`
  **aynen kalır**. Yanına ayrı bir `fundingOptions` alanı eklenir (Faz 1 açılana kadar
  sadece Chain Signatures açıklaması içerir). Ödeme isteği değişmez, yalnızca belge
  genişler.
- `/agents` sayfası ve `skill/SKILL.md`: NEAR bölümü.
- **Ölçüm:** gelen isteklerde `?ref=near` parametresi ve NEAR kaynaklı `User-Agent`
  değerleri ayrı sayılır. Faz 0 belgelerindeki bütün linkler `?ref=near` taşır.

**Bitti sayılır:** 4 yüzeyde NEAR bölümü yayında, `ref=near` sayacı çalışıyor, mevcut
testler geçiyor.

### Faz 1 — NEAR Intents ile kredi satın alma (≈1 hafta)

**Durum: canlıda (`ENABLE_NEAR_CREDITS=true`).** `src/lib/near-intents.ts`, `src/app/api/credits/near/{quote,status}`, `test/near-intents.test.ts`. Kayıp yanıt sorununu çözmek için basılan token, sipariş gizli anahtarından türetilen bir anahtarla şifrelenip saklanıyor; aynı gizli anahtarla tekrar sorgulayan aynı token'ı geri alıyor. Sayaçlar `/api/usage` içinde `nearCredits` alanında. İnsanlar için `/credits` sayfasında "Pay from NEAR" bölümü (`NearCreditsClient.tsx`).

**İlk canlı satış (2026-09-26):** $0.25 paket, NEAR üzerindeki USDC ile (0.255004 USDC gönderildi), 1Click takası Base'de `0x6c66b2df…0089704` ile `PAY_TO_ADDRESS`'e ulaştı, token basıldı, para cüzdanda ve `/stats`'ta görüldü.

**Canlıya alırken öğrenilenler:**
- 64 karakterlik NEAR implicit hesabı `.near` eki olmadan yazılır; ekli hali başka (genelde var olmayan) bir hesaptır ve iade oraya giderdi. Sunucu artık bu biçimi reddedip doğrusunu öneriyor, arayüz de uyarıyor.
- Upstash ücretsiz planı aşılmıştı ve Upstash bunu **HTTP 200 + `error` gövdesi** ile bildiriyordu; KV istemcisi bunu başarı sanıyordu. Artık hata sayılıyor ve loglanıyor (`[kv] Upstash refused a command`). Plan Pay-as-you-go'ya alındı; istek başına komut sayısı yaklaşık %30 azaltıldı.
- Yazmayı hemen geri okuyarak doğrulamak güvenilir değil (Upstash okumayı kopyadan yapabilir); doğrulama SET'in kendi `OK` yanıtıyla yapılıyor (`kvSetChecked`).
- 1Click, 1 saat istediğimiz halde yaklaşık 3 günlük bir `deadline` döndürdü; ajana 1Click'in değeri gösteriliyor.

**Amaç:** Base'de USDC'si olmayan bir ajanın, NEAR'daki (ya da başka bir zincirdeki)
varlığıyla kredi paketi alabilmesi.

**Akış:**

1. `POST /api/credits/near/quote?tier=5` → 1Click API'den `dry: false` ve
   `EXACT_OUTPUT` ile teklif alınır. Hedef Base USDC, alıcı `PAY_TO_ADDRESS`, tutar paket
   fiyatı. Yanıt olarak `depositAddress`, son geçerlilik zamanı ve bir `orderId` ile
   `orderSecret` döner. KV'de yalnızca `orderSecret`'ın hash'i tutulur.
2. Ajan kendi zincirinden `depositAddress` adresine gönderim yapar (isteğe bağlı olarak
   tx hash'ini bildirir).
3. `GET /api/credits/near/status?orderId=…` (başlıkta `x-order-secret`) → 1Click'e durum
   sorulur. `SUCCESS` gelirse `mintCredits` **tam bir kez** çağrılır (koruma anahtarı
   `kvIncrByOnce` ile `near:order:<id>`), `ck_…` token'ı sadece bu yanıtta verilir.
   `REFUNDED`, `FAILED` ve `EXPIRED` durumları olduğu gibi raporlanır; bu durumda para
   ajana 1Click tarafından iade edilir.

**Tasarım notları:**

- `EXACT_OUTPUT` seçilmesinin sebebi: takas ücreti alıcıya yansır, biz paketin tam
  fiyatını alırız.
- `orderSecret` olmadan durum sorgusu token döndürmez. Aksi halde `orderId`'yi gören biri
  token'ı ele geçirebilir.
- Kayıp token kurtarma: `/api/credits/recover` bugün EVM cüzdan imzası istiyor. NEAR'dan
  gelen alıcının böyle bir cüzdanı olmayabilir, bu yüzden bu yol için kurtarma anahtarı
  `orderSecret` olur.
- Kayıt: `credits:rail:near:packs` ve `credits:rail:near:paidCents` sayaçları ayrıca
  tutulur. `creditsLedger` ve `/api/revenue` bu kanalı ayrı gösterir.
- Builder Code: Intents'ten gelen transfer düz bir USDC transferidir ve ERC-8021 eki
  taşımaz. Bu gelir Base Builder panosunda **görünmez**; bu bilinçli bir takastır.
- Yeni dosyalar: `src/lib/near-intents.ts`, `src/app/api/credits/near/quote/route.ts`,
  `src/app/api/credits/near/status/route.ts`, `test/near-intents.test.ts` (1Click
  yanıtları taklit edilir; `SUCCESS` iki kez gelse de tek kredi basıldığı test edilir).
- Env: `ENABLE_NEAR_CREDITS`, `NEAR_INTENTS_JWT` (1Click anahtar istiyorsa).

**Bitti sayılır:** Gerçek bir 1Click takasıyla $0.25'lik paket alınmış, `ck_` token bir
servis çağrısında harcanmış, `creditsLedger` bunu NEAR kanalında göstermiş.

### Faz 2 — NEAR AI Agent Market'te satıcı olmak (tasarım aşaması)

**Durum: B seçildi, pazarın bağlayıcı kataloğuna başvuru yapılacak (aşağıda).**

**2026-09-26'da öğrenilenler:**

- `market.near.ai` = **yeni** pazar ("agent.market", JavaScript'le çalışan bir site). API'si `/v1/*`
  altında ve giriş istiyor (`GET /v1/jobs?...` → `unauthorized`). `market.near.ai/skill.md`
  diye bir belge **yok**, site sayfası dönüyor.
- `market-legacy.near.ai` = **eski** pazar, arşivleniyor. `skill.md` belgesi (v0.3.0) orada duruyor:
  kayıt, ilan, teklif, emanet (escrow), teslim, çekim, hizmet kaydı (`/v1/services`, `invoke`,
  `match`). **Bunun üzerine kod yazma.**
- Yeni pazarın OpenAPI tanımı: `https://market.near.ai/openapi.json` (giriş istemiyor). Uç nokta
  listesi `docs/near-market/paths.txt` dosyasında. Tam dosya, sahibinin bilgisayarından
  `docs/near-market/openapi.json` olarak eklenecek (bu geliştirme ortamı market.near.ai'ye
  erişemiyor).
- **Yeni pazarda `/.well-known/x402` var**, yani x402 kullanıyor, bizimle aynı protokol. Ajanlar için
  **fiyat planları** (`/v1/agents/{id}/pricing-plans`, `/v1/pricing-plans/{id}`), hesap altında
  **listelenmiş ajanlar ve beceriler** (`/v1/accounts/{id}/listed-agents`, `/skills`), iş panosu,
  teklif ve teslim (`/v1/jobs/board`, `/v1/jobs/{id}/bids`, `/v1/assignments/{id}/submit`) ve USD
  ödeme (`/v1/wallet/fiat/payout/*`) var.

**Yeni hedef (tasarımı doğrulanacak):** Teklif yarışı yerine x402 Bazaar'ı yeni pazarda **sabit
fiyatlı bir satıcı ajan** olarak listelemek. Fiyat planları bizim servis fiyatlarımızdan üretilir,
iş geldiğinde servisler içeriden çağrılır. Pazar x402 destekliyorsa, ödemenin doğrudan mevcut
`/api/x402/*` uçlarımıza gelmesi mümkün olabilir; en az kodla en çok kazanç bu olur.

**İlk oturumda yapılacaklar (sırayla):**

1. `docs/near-market/openapi.json` dosyasını oku. Şunların şemalarını çıkar:
   `POST /v1/agents/register`, pricing-plans uçları, `listed-agents`, `skills`, `jobs/board`,
   `assignments/{id}/submit`, `/.well-known/x402`, `/v1/platform/config`.
2. Pazarın x402'yi nasıl kullandığını belirle: pazar **alıcı** olarak mı ödüyor (bize x402
   ödemesi yapar), yoksa sadece kendi ücretini mi alıyor?
3. Kayıt akışını belirle: hesap (`/v1/auth/signup`) mı gerekiyor, ajan kaydı yeterli mi,
   builder agreement (`/v1/legal/builder-agreement`) kabulü mü gerekiyor?
4. Sonucu bu bölüme yaz, sahibine sade dille özetle, onay almadan kod yazma.

**Spesifikasyondan çıkanlar (2026-09-26, `docs/near-market/market.json`, "agents-market API 2.0.0"):**

- **Pazar ne:** ajan *kiralama* platformu. Alıcı (insan ya da ajan) bir ajanı kiralar, pazar parayı
  emanete alır, ajan işi teslim eder, alıcı onaylar, para ajanın pazar cüzdanına geçer.
- **Alıcı pazara x402 ile ödüyor.** `/.well-known/x402` → `near:mainnet`, NEAR üzerindeki USDC,
  `payTo` pazarın kendi hesabı. Şema `eip155:8453` (Base) ağını da tanıyor, ama şu an listede sadece
  NEAR var. Yani x402 **pazarın tahsilatı** için; pazar bizim `/api/x402/*` uçlarımıza ödeme yapmıyor.
- **Komisyon:** `GET /v1/platform/config` → `platform_fee_bps: 500` (%5).
- **Kayıt:** `POST /v1/agents/register` giriş istemiyor: `handle` (3–30, `[a-z][a-z0-9-]*`, sonradan
  değişmez), `name`, `category` (`finance`, `data`, `research`, `legal_compliance`, …), isteğe bağlı
  `email`, `sla_seconds`. Yanıtta `accountId`, `agentId` ve **bir kez gösterilen** `apiToken` gelir.
- **Çalışma şekli:** `runtime: http` (kendimiz barındırırız; pazar HMAC-SHA256 imzalı `hire.created`
  olayını `webhook_url`'imize POST eder) ya da `managed` (pazar kendi LLM döngüsünü + becerileri çalıştırır).
  `PATCH /v1/agents/{id}` ile `webhook_url`, `webhook_secret`, `description`, `input_schema`,
  `output_schema`, `tags`, `listing_status` (`draft|live|paused|archived`) ayarlanır.
  `POST /v1/agents/{id}/webhook/test` sahte bir ping gönderir. Webhook gövdesinin şeması
  spesifikasyonda **yok**; ilk ping ile görülecek.
- **Fiyat:** `POST /v1/agents/{id}/pricing-plans`, v1'de sadece `model: per_call`, `price_token` USD ya da USDC.
- **Teslim:** `POST /v1/assignments/{id}/submit` → `{deliverableUrl, deliverableHash}`, isteğe bağlı
  `/v1/assignments/{id}/start`.
- **Parayı çekme — engel:** Yeni pazarda para çekme **sadece Stripe Connect ile USD olarak**
  yapılıyor (`/v1/wallet/fiat/payout/*`). Kripto çekme uç noktası yok, sadece kripto *yatırma*
  (`deposit-intents`) var. Stripe Connect'in Türkiye'de açılıp açılamadığı doğrulanmalı; açılamıyorsa
  pazarda kazanılan para çekilemez.
- **Beceri kataloğu:** `POST /v1/accounts/{id}/skills` (başlık, açıklama, ≤8 MiB dosya ya da https
  linki). Pazarın barındırdığı (`managed`) ajanlar bu becerileri kullanıyor. Bizim `skill/SKILL.md`
  dosyamız buraya konabilir; o zaman pazardaki ajanlar bizi doğrudan çağırıp **mevcut
  yollarımızdan** (x402 Base ya da kredi) öder. Stripe gerekmez.

**İki yol:**

| | A. Satıcı ajan (`runtime: http`) | B. Beceri / araç olarak listelenmek |
|---|---|---|
| Para nereye gelir | Pazar cüzdanına (USD), %5 komisyon | Doğrudan bize: Base USDC ya da kredi |
| Çekme | Sadece Stripe Connect (Türkiye'de olmayabilir) | Sorun yok, mevcut sistem |
| Kod | Webhook alıcısı + iş yürütücü + teslim | Neredeyse yok: beceri dosyası + kayıt |
| Risk | Teslim anlaşmazlıkları, SLA | Düşük |

**Düzeltme (aynı gün):** B'nin "beceri kataloğu" yolu işe yaramıyor. Beceri uçlarının hepsi
"Not a member of this account" kontrolü yapıyor; bir hesabın becerisini başka hesabın ajanları göremiyor.
Pazarda dışarıdan araç sağlamanın yolu **connector kataloğu**. Ajanlar `required_slots` →
`connector_slugs` ile pazarın bağlayıcılarını kullanıyor, bağlayıcılar HTTP taşımalı olmalı ve katalogu
pazar yöneticileri (`/v1/admin/mcp/*`) yönetiyor.

**B (güncel):** Barındırılan MCP sunucumuz `https://402.com.tr/api/mcp` (Streamable HTTP, `x-credit-token`
başlığı ya da `?creditToken=`) pazarın bağlayıcı kataloğuna eklensin diye NEAR AI ekibine başvurulur.
Pazardaki ajanlar araçlarımızı bağlayıcı olarak kullanır, kredi token'ını NEAR Intents ile alır ve para
doğrudan bize gelir. Kod gerekmiyor; MCP'nin tanıtım metnine NEAR ile kredi alma notu eklendi.
**Sahibi B'yi seçti (2026-09-26).** Başvuru metni sahibine verildi. Kanal: Telegram
https://t.me/nearaimarket ya da https://github.com/nearai/market/issues (repo özel olabilir).

**Koruma önlemleri (değişmedi):** `ENABLE_NEAR_MARKET` bayrağı; ilk 2 hafta
`NEAR_MARKET_MODE=dry-run` (hiçbir teklif ya da listeleme canlıya gitmez, sadece günlüğe yazılır);
aynı anda en fazla N aktif iş; anlaşmazlıkta `alert-owner` bildirimi. Pazarda hesap, ajan ya da
listeleme oluşturan her komut **önceden sahibine söylenir**.

**Eski pazarda kazara açılan hesaplar:** Boş bir kayıt denemesi (`POST /v1/agents/register -d "{}"`)
market-legacy'de iki isimsiz ajan açtı (`036f54c9-…`, `0b14c779-…`). İçlerinde para yok, API
anahtarları sohbette açığa çıktı. **Kullanılmayacaklar.**

### Faz 3 — Koşullu: NEAR'a özel servisler ya da NEAR ödeme ağı

Bu faz ancak Faz 1 ve Faz 2'nin sayıları gerçek talep gösterirse açılır. Olası adımlar:
NEAR zincirindeki tokenlar (NEP-141) için güvenlik servisleri, ya da ayrı bir uç noktada
(asla mevcut `accepts[]` içinde değil) NEAR üzerinde doğrudan ödeme alma.

## 5. Gelir modeli

| Kanal | Gelir | Maliyet | Not |
|---|---|---|---|
| A. Chain Signatures | Normal x402 fiyatı | Yok | Mevcut sistemle birebir aynı |
| B. Intents kredileri | Paket fiyatı ($0.25 / $1 / $5 / $20) | Takas ücreti alıcıda (`EXACT_OUTPUT`) | Kayıttaki "outstanding" bakiye bir borçtur |
| C. Agent Market | İş başına teklif (NEAR) | Claude + pazar ücreti + NEAR→USDC takası | NEAR fiyat riski: kazanç düzenli olarak USDC'ye çevrilir |

Bu belgede gelir tahmini **bilinçli olarak yok**. Elimizde NEAR kaynaklı talep verisi yok ve
Polygon deneyi beklentinin talep demek olmadığını gösterdi. Rakamlar Faz 0 ve Faz 1
sayaçlarından çıkacak.

## 6. Devam / durdurma ölçütleri (öneri, sahibi karar verir)

| Faz | Süre | Devam | Durdur |
|---|---|---|---|
| 0 | 30 gün | `ref=near` trafiği var ve büyüyor | Sıfır trafik → Faz 1 yine yapılır (ucuz) ama öncelik düşer |
| 1 | 60 gün | ≥ 10 paket ya da ≥ $50 | Hiç paket satılmazsa rota kapatılır, bayrak `false` olur |
| 2 | 30 gün canlı | Kazanma oranı ≥ %10, net kâr > 0, çözülmemiş anlaşmazlık yok | Zarar ya da anlaşmazlık → dry-run'a dön |

## 7. Kod yazmadan önce doğrulanacaklar

Bu geliştirme ortamından `market.near.ai`, `near.ai` ve `1click.chaindefuser.com`
adreslerine erişilemedi (ağ politikası engelliyor). Aşağıdakiler ilk oturumda
doğrulanmalı; gerekirse ortamın ağ izinlerine bu adresler eklenmeli:

- [x] Pazar API'si: `market.near.ai/skill.md` yok. Yeni pazarın tanımı `market.near.ai/openapi.json`,
      eski pazarın belgesi `market-legacy.near.ai/skill.md` (bkz. Faz 2).
- [ ] Yeni pazarın ücreti ve kuralları: `GET https://market.near.ai/v1/platform/config`.
- [x] Base USDC 1Click listesinde var: `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near`, 6 ondalık (2026-09-26, kullanıcı doğruladı).
- [ ] 1Click API: anahtar gerekiyor mu, minimum tutar ve ücret ne (ilk gerçek $0.25'lik teklifte görülür).
- [ ] x402 spesifikasyonundaki NEAR Intents önerilerinin durumu
      ([#2102](https://github.com/x402-foundation/x402/pull/2102),
      [#3370](https://github.com/x402-foundation/x402/pull/3370)). Birleştirilmişse Faz 1
      kendi yazdığımız akış yerine standart şemaya taşınabilir; birleştirilmediyse
      bekleme yok, Faz 1 kendi akışıyla ilerler.

## 8. Claude ile geliştirme sırası

Her oturum bu dosyayı okuyarak başlar ve bir fazın bir parçasını bitirir:

1. ~~Faz 0~~ ve ~~Faz 1~~: bitti, canlıda.
2. **Sıradaki:** "docs/near-plan.md'yi oku, Faz 2'nin 'İlk oturumda yapılacaklar' listesini yap."
3. Faz 2 tasarımı sahibi tarafından onaylanınca dry-run modunda uygula.
4. Ölçütler (6. bölüm) karşılandıkça bir sonraki faz.

Her adımda `npm run typecheck`, `npm test` ve `npm run build` temiz olmadan push yok.

## 9. Oturum geçmişi (2026-09-26, Claude Code web oturumu)

Birleştirilen PR'lar (hepsi `main`'de, Vercel'de canlı):

| PR | Ne |
|---|---|
| #3 | Faz 0 (NEAR keşif yüzeyleri) + Faz 1 (NEAR Intents kredi yolu) |
| #4 | Sipariş yazımını geri okumak yerine SET'in `OK` yanıtıyla doğrulama |
| #5 | KV yazma hatasının nedenini yanıtta gösterme |
| #6 | Upstash'in HTTP 200 + `error` yanıtını hata sayma; istek başına KV komutlarını azaltma |
| #7 | `/credits` sayfasında "Pay from NEAR", katalog, OpenAPI, README; `.near` ek koruması |

Ortam ve işletme:

- Vercel: `ENABLE_NEAR_CREDITS=true`. `NEAR_INTENTS_JWT` boş (1Click ek ücret alıyor olabilir).
- Upstash: ücretsiz plan aşılmıştı ("temporarily rate-limited"), **Pay as You Go**'ya geçildi.
  Komut sayısını ve faturayı birkaç gün sonra kontrol et. Yüksekse sıradaki kaldıraç: bot kaynaklı
  402 kayıtlarını hafifletmek (dönüşüm istatistiklerini etkiler, sahibinin kararı).
- İlk NEAR satışı: bkz. Faz 1 durumu. Para cüzdana ve `/stats`'a ulaştı.
- Bu web oturumu 402.com.tr, market.near.ai, near.ai ve 1click.chaindefuser.com adreslerine
  erişemiyordu; canlı testleri sahibi kendi bilgisayarından yaptı. Terminaldeki Claude bu
  adreslere erişebilir.
- Test takımında `counterparty.test.ts` (5) ve `domain-check.test.ts` (4) canlı internet testleri;
  ağı kısıtlı ortamda başarısız olmaları normal.
