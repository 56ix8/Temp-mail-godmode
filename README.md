# SVARA NETWORK: Ephemeral Mail Infrastructure

Svara Network adalah sistem manajemen email temporer berbasis arsitektur serverless. Proyek ini memanfaatkan ekosistem Cloudflare untuk menangani lalu lintas data secara real-time dengan persistensi data yang dikontrol secara otonom.

## Persyaratan Sistem
- Domain aktif dengan akses penuh ke DNS Management.
- Akun Cloudflare (Free Tier memadai).
- API Key Resend (untuk modul outbound).

---

## PHASE 1: Data Persistence & Object Storage

Tahap awal melibatkan penyediaan infrastruktur penyimpanan untuk metadata email dan aset lampiran. Kita akan menggunakan Cloudflare D1 sebagai database relasional dan R2 untuk penyimpanan objek biner.

### 1.1 Inisialisasi Database (Cloudflare D1)
Database ini berfungsi untuk menyimpan log transmisi masuk dan keluar.

1. Buka Dashboard Cloudflare > Storage & Databases > D1.
2. Buat database baru dengan nama `svara-db`.
3. Masuk ke tab Console dan eksekusi skrip SQL berikut untuk membuat skema tabel utama:

```sql
CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient TEXT,
    sender TEXT,
    subject TEXT,
    body_text TEXT,
    body_html TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT,
    recipient TEXT,
    subject TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 1.2 Konfigurasi Vault (Cloudflare R2)
R2 digunakan untuk menampung file biner (attachment) yang diekstrak dari payload email.

1. Buka Dashboard Cloudflare > Storage & Databases > R2.
2. Buat bucket baru dengan nama `svara-vault`.
3. Buka tab Settings pada bucket tersebut, cari bagian Object Lifecycle Rules.
4. Tambahkan aturan baru: Set agar objek otomatis dihapus (Delete objects) setelah usia 1 hari. Langkah ini krusial untuk menjaga efisiensi ruang penyimpanan dan privasi data.

## PHASE 2: Data Ingestion & Worker Initialization

Tahap ini berfokus pada penangkapan arus data masuk (email mentah) dan meneruskannya ke komputasi edge (Cloudflare Worker) sebelum diekstrak ke database.

### 2.1 Konfigurasi Email Routing (Catch-all)
Fitur ini digunakan untuk menangkap seluruh variasi alamat email di bawah domain utama dan mem-bypass proses ke Worker.

1. Buka Dashboard Cloudflare > Pilih domain yang akan digunakan.
2. Navigasi ke menu Email > Email Routing.
3. Klik Get Started dan ikuti proses injeksi DNS Records (TXT dan MX) secara otomatis.
4. Setelah status domain aktif, masuk ke tab Routing Rules.
5. Aktifkan fitur Catch-all address.
6. Pada kolom Action, atur ke Send to a Worker (Pilih Worker yang akan dibuat pada langkah 2.2).

### 2.2 Deployment Serverless Worker
Worker berfungsi sebagai otak parser utama untuk membedah payload email mentah menjadi objek terstruktur.

1. Buka Dashboard Cloudflare > Workers & Pages.
2. Klik Create application > Pilih tab Workers > Klik Create Worker.
3. Beri nama `svara-worker`, lalu klik Deploy.
4. Masuk ke menu Edit code, hapus seluruh kode bawaan sistem (biarkan kosong sementara), lalu Save. Kita akan menyuntikkan skrip utama di fase berikutnya.

### 2.3 Konfigurasi Environment Bindings
Agar Worker memiliki hak akses untuk membaca dan menulis ke infrastruktur storage, kita harus mengonfigurasi environment bindings.

1. Buka halaman Settings dari `svara-worker` yang baru dibuat.
2. Navigasi ke tab Bindings (atau Variables/Integrations tergantung pembaruan UI Cloudflare).
3. Tambahkan koneksi D1 Database:
   - Variable name: `DB` (wajib uppercase)
   - D1 database: Pilih `svara-db`
4. Tambahkan koneksi R2 Bucket:
   - Variable name: `BUCKET` (wajib uppercase)
   - R2 bucket: Pilih `svara-vault`
5. Simpan konfigurasi.

Kembali ke menu Email Routing pada domain Anda (Langkah 2.1), dan pastikan opsi Catch-all sudah terhubung ke `svara-worker`.

## PHASE 3: Outbound Transmission & Core Logic Engine

Tahap ini mengaktifkan kapabilitas pengiriman email keluar (Tx) melalui protokol API untuk mem-bypass batasan SMTP konvensional, serta menginjeksi logika utama ke dalam Cloudflare Worker.

### 3.1 Konfigurasi Resend API
Resend bertindak sebagai engine pengiriman untuk outbound traffic.

1. Buat akun di Resend.com.
2. Navigasi ke menu Domains > Add Domain. Masukkan domain utama Anda.
3. Resend akan memberikan sekumpulan DNS Records (TXT/MX/CNAME). Masukkan seluruh record tersebut ke menu DNS Management di Cloudflare.
4. Buka menu API Keys di Resend > Create API Key dengan akses "Full Access" atau spesifik untuk domain terkait.
5. Simpan API Key tersebut (format `re_...`) untuk digunakan pada tahap injeksi environment.

### 3.2 Implementasi DMARC (Domain Security)
Untuk memastikan email outbound tidak masuk ke folder Spam/Junk (terutama pada Gmail), protokol DMARC wajib diaktifkan.

1. Buka DNS Management di Cloudflare.
2. Tambahkan record baru:
   - Type: `TXT`
   - Name: `_dmarc`
   - Content: `v=DMARC1; p=none;`
3. Simpan konfigurasi. Propagasi DNS mungkin membutuhkan waktu beberapa jam.

### 3.3 Injeksi Kode Utama (Worker Script)
Skrip ini merupakan inti komputasi yang menangani ekstraksi payload masuk, pengiriman via API, dan dasbor telemetri admin. 

Pada repositori publik, kredensial tidak boleh ditulis langsung (*hardcoded*). Kita akan memanggilnya melalui `env`.

1. Buka halaman Worker `svara-worker` > klik Edit Code.
2. Timpa seluruh isi dengan kode JavaScript berikut, lalu klik Deploy:

```javascript
// --- SVARA NETWORK CORE ENGINE ---

function extractPart(raw, type) {
    let idx = raw.indexOf(`Content-Type: ${type}`);
    if (idx === -1) return null;
    let sliced = raw.substring(idx);
    let headerEnd = sliced.indexOf("\r\n\r\n");
    if (headerEnd === -1) headerEnd = sliced.indexOf("\n\n");
    if (headerEnd === -1) return null;
    let body = sliced.substring(headerEnd).trim();
    let nextBound = body.indexOf("\r\n--");
    if (nextBound === -1) nextBound = body.indexOf("\n--");
    if (nextBound !== -1) body = body.substring(0, nextBound);
    
    body = body.replace(/=\r\n/g, "").replace(/=\n/g, "");
    body = body.replace(/=([0-9A-F]{2})/gi, (match, hex) => {
        try { return decodeURIComponent('%' + hex); } catch(e) { 
            try { return String.fromCharCode(parseInt(hex, 16)); } catch(e) { return match; }
        }
    });
    return body;
}

export default {
  async email(message, env, ctx) {
    const recipient = message.to;
    const sender = message.headers.get("from") || message.from;
    const subject = message.headers.get("subject") || "(Tanpa Subjek)";
    const rawEmail = await new Response(message.raw).text();
    
    let cleanText = "Pesan teks tidak tersedia."; let cleanHtml = ""; let attachmentsHtml = ""; 

    try {
        if (rawEmail.includes("multipart/")) {
            cleanText = extractPart(rawEmail, "text/plain") || cleanText; cleanHtml = extractPart(rawEmail, "text/html") || "";
            const boundaryMatch = rawEmail.match(/boundary="?([^"\r\n]+)"?/i);
            if (boundaryMatch) {
                const parts = rawEmail.split("--" + boundaryMatch[1]);
                for (let part of parts) {
                    if (part.includes("Content-Disposition: attachment") || part.includes("Content-Disposition: inline; filename")) {
                        let fnameMatch = part.match(/filename="?([^"\r\n]+)"?/i); let fname = fnameMatch ? fnameMatch[1] : "file.bin";
                        let headerEnd = part.indexOf("\r\n\r\n"); if (headerEnd === -1) headerEnd = part.indexOf("\n\n");
                        if (headerEnd !== -1) {
                            let b64 = part.substring(headerEnd).replace(/\s+/g, "");
                            try {
                                let binString = atob(b64); let bytes = new Uint8Array(binString.length);
                                for (let i = 0; i < binString.length; i++) bytes[i] = binString.charCodeAt(i);
                                let fileKey = Date.now() + "_" + fname; await env.BUCKET.put(fileKey, bytes.buffer);
                                attachmentsHtml += `<div style="margin-top:20px; padding:15px; border:1px solid #334155; border-radius:12px; background:#0f172a; color:#f8fafc; font-family:monospace;"><p>📎 <b>${fname}</b></p><a href="https://${env.WORKER_HOST}/api/download/${fileKey}?key=${env.ADMIN_KEY}" target="_blank" style="display:inline-block; padding:8px 16px; background:#06b6d4; color:#030712; text-decoration:none; border-radius:6px; font-weight:bold;">⬇ Download File</a></div>`;
                            } catch(err) {}
                        }
                    }
                }
            }
        } else { let headerEndIdx = rawEmail.indexOf("\r\n\r\n"); cleanText = headerEndIdx !== -1 ? rawEmail.substring(headerEndIdx).trim() : rawEmail; }
        cleanHtml += attachmentsHtml;
    } catch (e) { console.error(e); }

    await env.DB.prepare("INSERT INTO emails (recipient, sender, subject, body_text, body_html) VALUES (?, ?, ?, ?, ?)").bind(recipient, sender, subject, cleanText, cleanHtml).run();
    await env.DB.prepare("DELETE FROM emails WHERE created_at <= datetime('now', '-1 day')").run();
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Secret-Key" } });

    const userKey = request.headers.get("X-Secret-Key") || url.searchParams.get("key");
    const validCodes = env.VALID_CLASS_CODES ? env.VALID_CLASS_CODES.split(',') : ["TESTING123"];
    const isMember = validCodes.includes(userKey); 
    const isAdmin = userKey === env.ADMIN_KEY;
    
    if (!isMember && !isAdmin) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });

    if (url.pathname === "/api/send" && request.method === "POST") {
        try {
            const body = await request.json();
            const resendReq = new Request("[https://api.resend.com/emails](https://api.resend.com/emails)", {
                method: "POST", headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ from: `Svara Member <${body.from}>`, to: [body.to], subject: body.subject, html: body.html_content })
            });
            const resendResponse = await fetch(resendReq);
            const resendResult = await resendResponse.json();
            if (!resendResponse.ok) return new Response(JSON.stringify({ error: "Gagal mengirim", detail: JSON.stringify(resendResult) }), { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });

            await env.DB.prepare("INSERT INTO outbox (sender, recipient, subject) VALUES (?, ?, ?)").bind(body.from, body.to, body.subject).run();
            await env.DB.prepare("DELETE FROM outbox WHERE created_at <= datetime('now', '-1 day')").run();
            return new Response(JSON.stringify({ success: true, message: "Terkirim" }), { headers: { "Access-Control-Allow-Origin": "*" } });
        } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }); }
    }

    if (url.pathname === "/api/admin" && request.method === "GET") {
        if (!isAdmin) return new Response("Akses Ditolak", { status: 403 });
        const { results: inbox } = await env.DB.prepare("SELECT recipient, sender, subject, created_at FROM emails ORDER BY created_at DESC LIMIT 50").all();
        const { results: outbox } = await env.DB.prepare("SELECT sender, recipient, subject, created_at FROM outbox ORDER BY created_at DESC LIMIT 50").all();

        let inboxRows = inbox.map(row => `<tr><td style="padding:10px; border-bottom:1px solid #334155;">${new Date(row.created_at).toLocaleString('id-ID')}</td><td style="padding:10px; border-bottom:1px solid #334155; color:#a78bfa;">${row.sender.replace(/[<>]/g, '')}</td><td style="padding:10px; border-bottom:1px solid #334155; color:#34d399;">${row.recipient}</td><td style="padding:10px; border-bottom:1px solid #334155;">${row.subject}</td></tr>`).join('');
        let outboxRows = outbox.map(row => `<tr><td style="padding:10px; border-bottom:1px solid #334155;">${new Date(row.created_at).toLocaleString('id-ID')}</td><td style="padding:10px; border-bottom:1px solid #334155; color:#34d399;">${row.sender}</td><td style="padding:10px; border-bottom:1px solid #334155; color:#f87171;">${row.recipient}</td><td style="padding:10px; border-bottom:1px solid #334155;">${row.subject}</td></tr>`).join('');

        const adminHtml = `<!DOCTYPE html><html><head><title>Svara Telemetry</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{background-color:#030712; color:#cbd5e1; font-family:monospace; padding:20px;} h1, h2{color:#38bdf8;} table{width:100%; border-collapse:collapse; margin-bottom:40px; background:#0f172a; border-radius:8px; overflow:hidden;} th{background:#1e293b; padding:12px; text-align:left; color:#f8fafc; font-size:14px;} td{font-size:12px; word-break:break-all;}</style></head><body><h1 style="text-align:center; font-size:2em; text-transform:uppercase; letter-spacing:2px; margin-bottom:5px;">OMNISCIENT TELEMETRY</h1><p style="text-align:center; color:#64748b; margin-bottom:40px;">Real-time Ingress & Egress Monitoring</p><h2>⬇️ INGRESS (Incoming)</h2><table><thead><tr><th>Waktu (UTC)</th><th>Pengirim</th><th>Penerima</th><th>Subjek</th></tr></thead><tbody>${inboxRows || '<tr><td colspan="4" style="text-align:center;">N/A</td></tr>'}</tbody></table><h2>⬆️ EGRESS (Outgoing)</h2><table><thead><tr><th>Waktu (UTC)</th><th>Pengirim</th><th>Tujuan</th><th>Subjek</th></tr></thead><tbody>${outboxRows || '<tr><td colspan="4" style="text-align:center;">N/A</td></tr>'}</tbody></table></body></html>`;
        return new Response(adminHtml, { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname.startsWith("/api/download/") && request.method === "GET") {
        const fileKey = url.pathname.replace("/api/download/", ""); const object = await env.BUCKET.get(fileKey); 
        if (!object) return new Response("File expired.", { status: 404 });
        const headers = new Headers(); object.writeHttpMetadata(headers); headers.set("etag", object.httpEtag); headers.set("Access-Control-Allow-Origin", "*"); headers.set("Content-Disposition", `attachment; filename="${fileKey.substring(14)}"`);
        return new Response(object.body, { headers });
    }

    if (url.pathname === "/api/emails" && request.method === "GET") {
      const address = url.searchParams.get("address"); if (!address) return new Response("Missing address", { status: 400 });
      const { results } = await env.DB.prepare("SELECT * FROM emails WHERE recipient = ? ORDER BY created_at DESC").bind(address).all();
      return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }
    
    return new Response("System Online", { status: 200 });
  }
};
```

### 3.4 Konfigurasi Variables & Secrets
Untuk keamanan tingkat tinggi, seluruh kredensial dan parameter penting dikelola melalui sistem Secrets.

1. Buka halaman Worker `svara-worker` > Settings > Variables and Secrets.
2. Tambahkan variabel dengan mengklik Add pada bagian Secrets:
   - Variable name: `RESEND_API_KEY` | Value: Isi dengan API key dari tahap 3.1.
   - Variable name: `ADMIN_KEY` | Value: Buat sandi kuat (contoh: `SVARABOS-99`) untuk akses dasbor.
   - Variable name: `VALID_CLASS_CODES` | Value: `KELAS-A1,KELAS-B2` (String dipisahkan koma untuk autorisasi login antarmuka).
   - Variable name: `WORKER_HOST` | Value: Isi dengan URL worker tanpa awalan HTTPS (contoh: `svara-worker.username.workers.dev`).
3. Deploy ulang Worker untuk menerapkan konfigurasi terbaru.

## PHASE 4: Antarmuka Pengguna (Frontend UI) & Deployment

Tahap akhir ini berfokus pada penyajian antarmuka (UI) statis yang akan berinteraksi dengan Cloudflare Worker (sebagai API backend). Kita akan melakukan hosting antarmuka tersebut menggunakan infrastruktur Cloudflare Pages.

### 4.1 Persiapan Berkas Antarmuka
File HTML tunggal ini memuat seluruh antarmuka klien, logika state-management memori, dan fungsi request asinkron ke backend.

1. Buat berkas baru pada penyimpanan lokal Anda dengan nama `index.html`.
2. Masukkan kode sumber UI final (God Mode build) ke dalam berkas tersebut.
3. Sebelum melanjutkan ke tahap deployment, Anda wajib memodifikasi dua variabel konstan pada blok `<script>` di dalam file `index.html`:
   - `const WORKER_URL = 'https://[URL_WORKER_ANDA].workers.dev';` (Ganti dengan URL Worker dari tahap 2.2).
   - `const DOMAIN = 'domainkamu.com';` (Ganti dengan domain utama yang terdaftar pada Resend).
4. Simpan perubahan pada berkas `index.html`.

### 4.2 Deployment via Cloudflare Pages
Cloudflare Pages akan menyajikan file statis Anda secara global dengan tingkat latensi rendah melalui jaringan CDN Edge.

1. Buka Dashboard Cloudflare > navigasi ke menu Workers & Pages.
2. Klik Create application > pilih tab Pages.
3. Pilih opsi Upload assets.
4. Tentukan nama proyek (contoh: `svara-mail-ui`), lalu klik Create project.
5. Unggah (drag and drop) berkas `index.html` yang telah dikonfigurasi ke dalam area upload.
6. Klik Deploy site.
7. Sistem akan memberikan URL publik (berakhiran `.pages.dev`). Distribusikan tautan ini kepada entitas atau anggota yang memiliki Access Code valid.

### 4.3 Akses Dasbor Telemetri (Administrator)
Sistem memiliki endpoint tersembunyi yang difungsikan sebagai dasbor pemantauan jaringan tingkat dewa (Omniscient View).

Untuk memantau seluruh lalu lintas ingress (masuk) dan egress (keluar), akses format URL berikut pada peramban web Anda:
`https://[URL_WORKER_ANDA]/api/admin?key=[ADMIN_KEY_ANDA]`

---

**Sistem Status: Terotorisasi & Operasional.** Infrastruktur Svara Network Ephemeral Mail kini telah beroperasi penuh secara serverless. Seluruh siklus hidup data (data lifecycle) dikontrol secara independen oleh komputasi edge.

## Panduan Operasional Klien (Client Usage)

Setelah antarmuka berhasil di-deploy, klien atau anggota dapat mengakses sistem melalui URL Pages yang telah didistribusikan. Berikut adalah alur operasional standar:

### 1. Autentikasi Jaringan
Saat antarmuka dimuat, sistem akan melakukan penguncian layar dan meminta Access Code. Klien harus memasukkan string yang valid (terdaftar pada variabel `VALID_CLASS_CODES` di server) untuk menginisiasi antarmuka pengguna. Jika gagal, API akan mengembalikan status HTTP 401 Unauthorized.

### 2. Manajemen Alias Email
Klien memiliki fleksibilitas dalam menentukan alamat penerima:
- Algoritma Acak: Klien dapat menekan fungsi "Randomize" untuk menghasilkan string alfanumerik acak sebagai alamat email temporer.
- Alias Kustom: Klien dapat menginjeksi nama spesifik pada parameter input yang tersedia untuk kebutuhan identifikasi yang lebih mudah.

### 3. Ingress (Transmisi Masuk)
Sistem akan secara otomatis melakukan sinkronisasi data (polling) ke Worker secara berkala.
- Payload teks dan HTML akan dipilah secara otomatis.
- Objek biner (lampiran) akan dipisahkan dan disajikan sebagai tautan unduhan aman yang terhubung langsung ke R2 Vault.

### 4. Egress (Transmisi Keluar)
Klien dapat membuka modul "Compose" untuk memulai sesi pengiriman pesan baru atau membalas transmisi masuk. Parameter antarmuka memungkinkan klien untuk secara dinamis memodifikasi header "Sender" selama format domain sesuai dengan regulasi server.

---

## Arsitektur Keamanan (Security Posture)

Infrastruktur Svara Network dirancang dengan mengutamakan prinsip Zero-Trust dan sanitasi data yang ketat:

- Pembatasan Akses: Modul pengiriman pesan dan pembacaan database dilindungi oleh protokol validasi kunci.
- Pencegahan Eksekusi Skrip (XSS): Seluruh muatan HTML dari email masuk dirender di dalam entitas `iframe` terisolasi dengan atribut `sandbox` untuk memblokir eksekusi skrip berbahaya.
- Manajemen Siklus Hidup Data (Data Lifecycle): Rutinitas pembersihan otonom memastikan tidak ada residu data atau lampiran yang tersimpan di dalam database maupun storage melampaui batas waktu 24 jam.

## Lisensi & Batasan Tanggung Jawab

Sistem ini didesain secara eksklusif untuk kebutuhan edukasi, pengujian sistem, dan lingkungan tertutup. Administrator jaringan (pemegang akses God View) memiliki visibilitas penuh terhadap telemetri ingress dan egress. 

Penggunaan infrastruktur ini untuk distribusi spam, rekayasa sosial, phising, atau segala bentuk transmisi data ilegal sangat dilarang dan dapat mengakibatkan pemutusan layanan secara sepihak oleh penyedia infrastruktur (Cloudflare dan Resend).

## Pemecahan Masalah (Troubleshooting)

Mengingat kompleksitas integrasi antara layanan DNS, komputasi edge, dan API eksternal, beberapa kendala mungkin terjadi selama fase inisialisasi. Berikut adalah panduan mitigasi untuk anomali yang paling sering muncul:

### 1. Kegagalan Ingress (Email Tidak Masuk)
- **Gejala:** Klien tidak menerima email masuk setelah menekan tombol sinkronisasi.
- **Investigasi:**
  1. Verifikasi menu Email Routing di Cloudflare. Pastikan status Catch-all aktif dan mengarah ke Worker yang tepat.
  2. Periksa menu Logs pada Cloudflare Worker. Jika terdapat error SQL, pastikan skema tabel D1 telah dieksekusi dengan benar dan Binding variabel `DB` sudah sesuai.

### 2. Kegagalan Egress (Email Keluar Ditolak atau Masuk Spam)
- **Gejala:** Antarmuka mengembalikan pesan "Gagal mengirim" atau email target menerima pesan di folder Spam.
- **Investigasi:**
  1. Jika muncul error sistem, pastikan variabel rahasia `RESEND_API_KEY` telah diinjeksi dengan benar di pengaturan Worker.
  2. Jika masuk Spam, periksa kembali propagasi DNS. Pastikan record TXT, SPF, DKIM dari Resend, serta record DMARC telah berstatus "Pass" atau "Verified" di alat pengujian DNS global. Domain baru (Cold Domain) membutuhkan pemanasan reputasi (warming up).

### 3. Autentikasi Klien Ditolak (Error 401)
- **Gejala:** Klien memasukkan Access Code namun antarmuka menolak inisialisasi.
- **Investigasi:** Pastikan input dari klien sama persis (case-sensitive) dengan string yang dikonfigurasi pada variabel rahasia `VALID_CLASS_CODES`. Hindari penggunaan spasi ekstra saat menyalin parameter di pengaturan Cloudflare.

---

## Riwayat Versi (Changelog)

- **v5.0 (Omnipotence Protocol)** - Rilis saat ini. Implementasi mesin egress dua arah via Resend API, masking alias pengirim dinamis, dan dasbor telemetri terpusat untuk administrator.
- **v4.0 (Fortification)** - Penambahan sistem gerbang keamanan terenkripsi (Zero-Trust) dan rutinitas pembersihan memori otomatis 24 jam.
- **v3.0 (Asset Acquisition)** - Integrasi Cloudflare R2 untuk ekstraksi, penyimpanan persisten, dan penyajian aman berkas biner (lampiran email).
- **v2.0 & v1.0 (Genesis)** - Inisialisasi engine Rx, manajemen memori state lokal klien, dan pemilahan metadata mentah jaringan.

---

## Kontribusi & Pemeliharaan

Repositori ini bersifat terbuka untuk pengembangan lebih lanjut. Permintaan penarikan (Pull Requests) yang berfokus pada efisiensi komputasi Worker, optimasi ukuran antarmuka klien, atau penguatan sistem kriptografi akan ditinjau secara berkala.

Untuk melaporkan celah keamanan (Vulnerability Report), hindari penggunaan panel Issues publik. Hubungi administrator jaringan secara langsung melalui saluran komunikasi terenkripsi.

---
**Svara Network // God Mode Build**
*Deployed on Cloudflare Edge Infrastructure.*
