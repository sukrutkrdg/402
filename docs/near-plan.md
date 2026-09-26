# NEAR ekosistemi iş planı

> Durum: Faz 0 ve Faz 1 kodda (bayrak kapalı) · Faz 2 doğrulama bekliyor · 2026-09-26 · sahibi: sukrutkrdg
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

**Durum: uygulandı, `ENABLE_NEAR_CREDITS=false` ile kapalı.** `src/lib/near-intents.ts`, `src/app/api/credits/near/{quote,status}`, `test/near-intents.test.ts` (10 test). Kayıp yanıt sorununu çözmek için basılan token, sipariş gizli anahtarından türetilen bir anahtarla şifrelenip saklanıyor; aynı gizli anahtarla tekrar sorgulayan aynı token'ı geri alıyor. Sayaçlar `/api/usage` içinde `nearCredits` alanında. Canlıya almadan önce: 7. bölümdeki 1Click kontrolleri ve $0.25'lik gerçek bir deneme.

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

### Faz 2 — NEAR AI Agent Market çalışanı (≈2–3 hafta, önce dry-run)

**Durum: başlanmadı.** Pazarın API'si (`market.near.ai/skill.md`) bu geliştirme ortamından okunamadı. Doğrulanmamış uç noktalara kod yazılmadı.

**Amaç:** market.near.ai'deki ilanlara teklif vermek ve işi kendi servislerimizle yapıp
NEAR kazanmak. Pazar 2026 Eylül itibarıyla servis kataloğundan **ajan kiralama modeline**
geçmiş durumda (ilan, teklif, teslim, ödeme), bu yüzden katalog kaydı yetmiyor; teklif
veren bir ajan gerekiyor.

**Akış (cron, örneğin 10 dakikada bir):**

1. Açık ilanları etiketlere göre listele: `token-safety`, `wallet-screening`, `ofac`,
   `base`, `due-diligence`.
2. Claude ile her ilanı sınıflandır: **tamamen** bizim servislerimizle otomatik
   yapılabilir mi? Hangi servisler gerekir, maliyeti ne olur? İnsan emeği gerektiren,
   belirsiz ya da Base dışı ilanlar elenir.
3. Uygun ilana teklif ver. Fiyat = iç servis maliyeti + Claude maliyeti + marj. Teslim
   süresi (ETA) gerçekçi tutulur.
4. İş verilince servisler **içeriden** çağrılır (x402 ödemesi yapılmaz, ek maliyet
   sıfıra yakın). Rapor `402.com.tr/r/<id>` adresinde yayınlanır ve SHA-256 hash'iyle
   teslim edilir. Karar makbuzundaki `inputHash` ve `policyVersion` alanları
   (`docs/decision-receipt.md`) teslimin doğrulanabilirliğini zaten sağlıyor.
5. Kazanç NEAR olarak gelir, periyodik olarak çekilir ve Intents ile Base USDC'ye
   çevrilir.

**Koruma önlemleri:**

- `NEAR_MARKET_MODE=dry-run`: ilk 2 hafta teklif **verilmez**, sadece "verseydik ne
  teklif ederdik" günlüğe yazılır. Bu günlük gözden geçirilmeden canlıya geçilmez.
- Aynı anda en fazla N aktif iş, günlük teklif tavanı.
- Anlaşmazlığa (dispute) düşen her iş için bildirim (`src/lib/alert-owner.ts`).
- Yeni dosyalar: `src/lib/near-market.ts`, `src/app/api/cron/near-market/route.ts`,
  `test/near-market.test.ts`. Env: `ENABLE_NEAR_MARKET`, `NEAR_MARKET_MODE`,
  `AGENT_MARKET_API_KEY`.

**Bitti sayılır:** Dry-run günlüğü incelenmiş, canlıda en az bir iş kazanılıp teslim
edilmiş, ödeme alınmış ve anlaşmazlık çıkmamış.

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

- [ ] `https://market.near.ai/skill.md`: güncel API, kayıt, teklif, teslim, çekim
      uç noktaları ve pazar ücreti.
- [x] Base USDC 1Click listesinde var: `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near`, 6 ondalık (2026-09-26, kullanıcı doğruladı).
- [ ] 1Click API: anahtar gerekiyor mu, minimum tutar, ücret, Base USDC
      (`0x833589fC…2913`) hedef olarak destekleniyor mu (`GET /v0/tokens`).
- [ ] x402 spesifikasyonundaki NEAR Intents önerilerinin durumu
      ([#2102](https://github.com/x402-foundation/x402/pull/2102),
      [#3370](https://github.com/x402-foundation/x402/pull/3370)). Birleştirilmişse Faz 1
      kendi yazdığımız akış yerine standart şemaya taşınabilir; birleştirilmediyse
      bekleme yok, Faz 1 kendi akışıyla ilerler.

## 8. Claude ile geliştirme sırası

Her oturum bu dosyayı okuyarak başlar ve bir fazın bir parçasını bitirir:

1. `Faz 0'ı uygula` → llms, agent-card, /agents, SKILL.md ve `ref=near` sayacı.
2. `Faz 1 için 1Click API'yi doğrula` → 7. bölümdeki kontrol listesi.
3. `Faz 1'i uygula` → `near-intents.ts`, iki rota, testler, kayıt sayaçları.
4. `Faz 2'yi dry-run modunda uygula` → market istemcisi, sınıflandırıcı, cron.
5. Ölçütler (6. bölüm) karşılandıkça bir sonraki faz.

Her adımda `npm run typecheck`, `npm test` ve `npm run build` temiz olmadan push yok.
