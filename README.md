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
