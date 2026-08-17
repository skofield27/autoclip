# AUTOCLIP

Tempel link video (YouTube, TikTok, Instagram, X, Facebook, atau 1800+ situs lain yang
didukung [yt-dlp](https://github.com/yt-dlp/yt-dlp)) → potong jadi klip pendek.
Tiga mode: **AI Highlight** (Claude nyari momen paling menarik dari transkrip),
**Fixed Split** (potong rata tiap X detik), **Manual Cut** (lo kasih timestamp sendiri).

## Kenapa bukan Vercel?

Sempat mikir taro semuanya di Vercel karena udah connect, tapi setelah dicek: Vercel
serverless function punya limit 250MB bundle size + ephemeral storage + payload 4.5MB,
dan ffmpeg static binary aja udah makan ~80-100MB dari budget itu. Download+transcode
video beneran gak reliable dijalanin di sana.

Jadi app ini jalan sebagai **satu Node.js process biasa** (bukan serverless) di Render.
Awalnya gw bikin versi Docker (install ffmpeg+yt-dlp lewat `apt`), tapi ternyata Render
MCP tool di sini cuma bisa deploy service **non-Docker**. Jadi gw rombak: `ffmpeg`
didapat dari package npm `ffmpeg-static` (auto-download binary pas `npm install`), dan
`yt-dlp` didapat dari script `postinstall` yang narik binary standalone langsung dari
GitHub Releases — dua-duanya gak butuh Python atau Docker sama sekali, cuma
`npm install` doang. (`Dockerfile.manual-docker-deploy` masih ada di repo buat siapa
aja yang lebih suka self-host pake Docker manual lewat dashboard.)

## Setup lokal

```bash
npm install       # ini juga otomatis narik binary ffmpeg & yt-dlp
cp .env.example .env   # isi API key kalau mau pake mode AI
npm start
```

Buka `http://localhost:3000`.

## Deploy ke Render

1. Push folder ini ke GitHub repo baru (lihat perintah di bawah).
2. Kasih tau Claude repo URL-nya — Claude bisa langsung provision service-nya
   lewat Render MCP connector (`runtime: node`, `buildCommand: npm install`,
   `startCommand: node server.js`).
3. Set environment variables di Render dashboard (atau minta Claude set sekalian):
   - `ANTHROPIC_API_KEY` — **cuma kalau mau pake mode AI Highlight**. Ambil di
     [console.anthropic.com](https://console.anthropic.com).
   - `ASSEMBLYAI_API_KEY` — **cuma kalau mau pake mode AI Highlight**. Ada free
     tier di [assemblyai.com](https://www.assemblyai.com/dashboard).
4. **Mode Fixed Split dan Manual Cut langsung jalan tanpa API key sama sekali.**

### Push ke GitHub (kalau belum ada repo)

```bash
cd autoclip
git init
git add .
git commit -m "initial commit"
gh repo create autoclip --public --source=. --push
# atau manual: bikin repo kosong di github.com, terus
#   git remote add origin https://github.com/USERNAME/autoclip.git
#   git branch -M main
#   git push -u origin main
```

## Yang perlu lo tahu soal reliabilitas per-platform

- **YouTube**: paling stabil, yt-dlp maintain extractor-nya paling rajin.
- **TikTok & Instagram**: kadang lebih rewel — platform ini sering ubah struktur
  situsnya dan bisa bikin yt-dlp gagal extract selama beberapa hari sampai ada
  update upstream. Kalau tiba-tiba error, redeploy service-nya (build ulang narik
  binary yt-dlp terbaru dari GitHub Releases lewat `scripts/install-yt-dlp.js`).
- **Konten private / age-gated**: butuh cookies. Set `YTDLP_COOKIES_FILE` ke
  path file `cookies.txt` format Netscape (export pake extension browser kayak
  "Get cookies.txt LOCALLY").

## Batasan yang disengaja (biar scope-nya masuk akal)

- Crop vertikal itu **center-crop biasa**, bukan face-tracking/subject-tracking.
  Cukup buat kebanyakan kasus, tapi kalau subjek utama gak di tengah frame,
  hasilnya bisa kepotong. Auto-reframe yang beneran tracking wajah adalah
  peningkatan yang masuk akal buat versi berikutnya.
- Job disimpan di memory (bukan database) — kalau server-nya restart, job yang
  lagi jalan ilang. Cukup buat single-instance MVP; kalau nanti butuh scale ke
  banyak instance, ganti ke Redis/queue beneran.
- File klip otomatis kehapus 1 jam setelah selesai diproses (`JOB_TTL_MS` di
  `src/jobs.js`).

## Struktur

```
server.js          Express app + API routes
src/downloader.js   wrapper yt-dlp (info + download)
src/clipper.js       wrapper ffmpeg (cut, vertical crop, extract audio)
src/transcriber.js   wrapper AssemblyAI (transkrip + timestamp)
src/highlighter.js   wrapper Claude API (milih momen terbaik dari transkrip)
src/jobs.js           orkestrasi + in-memory job queue
public/               frontend (vanilla HTML/CSS/JS, no build step)
```
