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
