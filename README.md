# freepi-bridge OMP extension

Sambungkan akun **FreePi** ke pi/OMP sebagai provider model `freepi`. Ekstensi memakai ulang daemon [freepi-bridge](https://github.com/ihsan-ramadhan/freepi-bridge) yang sehat, atau menjalankannya sendiri bila tidak ada yang merespons. Proxy lokal menyaring model gratis, jadi tidak perlu API key.

---

## Fitur utama

- Memakai ulang daemon yang benar-benar sehat, lalu menjalankan daemon baru dengan port bebas bila perlu.
- Menyaring model gratis dan mengurutkan fallback tanpa mengubah URL di `models.yml` saat pemulihan terjadi.
- Mengganti endpoint daemon lewat `setEndpoint`, tanpa restart proxy.
- Memulihkan koneksi saat request gagal, dengan retry model yang sama lalu fallback ke model berikutnya.
- Menampilkan status `freepi: bridge offline ...` bila startup gagal, bukan gagal diam-diam.

## Teknologi

- TypeScript, dirakit dengan esbuild menjadi `dist/index.js`.
- Berjalan sebagai ekstensi pi/OMP di runtime Node.js.
- Memakai biner `freepi-bridge` dari `PATH`, lokasi instalasi yang dikenal, atau rilis GitHub `v0.2.1` yang diunduh ke `~/.omp-freepi-bridge/bin/`.
- Berbicara dengan FreePi lewat API `https://api.freepi.ai`.

## Prasyarat

- pi/OMP dengan perintah `omp` yang tersedia.
- Akun FreePi dan token masuk. Cara mendapatkannya ada di bagian 1.
- Akses ke GitHub bila biner `freepi-bridge` belum tersedia lokal dan perlu diunduh.

---

## Install

Dari npm:

```bash
omp plugin install omp-freepi-bridge
```

Dari marketplace OMP:

```bash
omp plugin marketplace add yayayapluto/omp-freepi-bridge
omp plugin install omp-freepi-bridge@omp-freepi-bridge
```

Dari sumber:

```bash
git clone https://github.com/yayayapluto/omp-freepi-bridge.git
npm install && npm run build
omp plugin install ./omp-freepi-bridge
```

Cek hasilnya:

```bash
omp plugin list | grep freepi
```

`npm i -g omp-freepi-bridge` hanya memasang paket ke npm dan tidak mendaftarkannya ke OMP. Gunakan `omp plugin install` supaya runtime memuat ekstensi ini.

> Plugin terdaftar sebagai `omp-freepi-bridge` sesuai `package.json`, sama dengan nama repo.

### Update

```bash
npm view omp-freepi-bridge version          # latest published
omp plugin marketplace update omp-freepi-bridge
omp plugin upgrade omp-freepi-bridge@omp-freepi-bridge
```

---

## 1. Dapatkan token FreePi (sekali per mesin)

```bash
npx free-pi-cli@latest
```

Masuk dengan GitHub, lalu keluar. Token tersimpan di `~/.free-pi/agent/credentials.json`.

Alternatif, menurut prioritas:

| Sumber | Cara |
|---|---|
| Variabel lingkungan `FREEPI_TOKEN` | `set FREEPI_TOKEN=eyJ...` (Windows) / `export FREEPI_TOKEN=eyJ...` |
| Berkas kredensial | `~/.free-pi/agent/credentials.json` dari perintah CLI di atas |
| Konfigurasi daemon | `FREEPI_TOKEN=...` di `~/.freepi-bridge/config.env` |

Cek hasil deteksi: `/freepi token`

---

## 2. Pakai model

```bash
omp launch --model freepi/particle -p "hello"
```

Saat proses refresh latar belakang berjalan, ekstensi:

1. mencari `freepi-bridge` di `PATH`, lalu mengunduh rilis yang cocok ke `~/.omp-freepi-bridge/bin/` bila belum ada;
2. mengirim probe `/health` secara paralel ke `FREEPI_BRIDGE_PORT`, `state.port`, `8787`, dan `8788-8793`;
3. memakai daemon sehat pertama yang menjawab `200`;
4. bila semua kandidat mati, memilih port yang benar-benar bebas dari kandidat itu, menjalankan daemon dengan `--port` pilihan sendiri, lalu menunggu `/health` paling lama 15 detik;
5. menyalakan proxy model gratis dan mendaftarkan provider `freepi` ke URL proxy tersebut.

Daftar model yang tersedia: `/freepi models`

### Hanya model gratis yang didaftarkan

Sebagian model FreePi hanya bisa dipakai dengan kredit premium dan gagal seperti ini:

```
403 At capacity for free users. Available with premium credits: /buy-credits
```

`/v1/models` dari bridge tidak membawa penanda tier. Ekstensi membaca `https://api.freepi.ai/client-version` dengan token Anda, menyimpan hanya entri yang `free === true`, lalu meng-cache hasilnya di `~/.freepi-bridge/free-models.json`.

pi/OMP tetap melakukan discovery dari endpoint provider, jadi menyaring daftar yang didaftarkan saja tidak cukup. Ekstensi memasang proxy lokal antara OMP dan daemon:

- `GET /v1/models` mengembalikan hanya model gratis, menurut urutan prioritas.
- `POST /v1/chat/completions` memakai id yang diminta bila termasuk model gratis. Id premium atau id yang tidak dikenal mulai dari model gratis terbaik.
- `429`, atau teks `concurrent` dan `one request at a time`, memicu retry model yang sama sampai 3 kali dengan jeda 1,2 detik, 2,4 detik, dan 3,6 detik.
- `403`, `408`, `409`, `425`, `429`, `500`, `502`, `503`, dan `504` di luar pola sibuk di atas beralih ke model berikutnya bila rantai masih punya opsi.
- Koneksi ke bridge yang gagal memicu pemulihan otomatis, dijelaskan di bagian [Recovery otomatis](#recovery-otomatis).
- Model yang benar-benar dipakai dikirim kembali lewat header respons `x-freepi-model`.

OMP juga menyimpan konfigurasi provider di `~/.omp/agent/models.yml`, yang dapat menimpa pendaftaran runtime. Saat proxy mulai dan `FREEPI_FREE_ONLY` bukan `0`, ekstensi menyamakan entri `freepi.baseUrl` dengan URL proxy. Jadi discovery lewat `omp models` dan chat lewat jalur yang sama. Pemulihan bridge tidak mengubah URL ini karena alamat proxy tetap sama.

Jalankan `omp models refresh freepi` sekali setelah upgrade dari versi yang mengarah langsung ke daemon, karena OMP meng-cache daftar hasil discovery.

Rantai fallback, dari terbaik ke terakhir, juga dipakai bila pencarian tier tidak tersedia:

1. `particle`
2. `deepseek-v4.1-flash`
3. `glm-5.3-flash`
4. `deepseek-v4-flash`

Bila ingin menampilkan semua model, misalnya setelah membeli kredit, tetapkan `FREEPI_FREE_ONLY=0`.

---

## Recovery otomatis

**Health didahulukan.** Ekstensi tidak mempercayai `state.json` atau `pid` sebagai bukti bahwa daemon hidup. Keduanya hanya menjadi kandidat. Semua kandidat di-probe lewat `/health` secara paralel dengan batas 1,5 detik per permintaan.

**Port bebas dipilih saat spawn.** Bila tidak ada kandidat yang sehat, ekstensi mencoba port kandidat satu per satu dan memilih yang benar-benar bisa dipakai. Daemon dijalankan dengan argumen `start --bg --port <port> --bind 127.0.0.1`. Proses `exit` dan `error` ditangkap, dan isi `stderr` disertakan dalam pesan error. Batas tunggunya 15 detik. Bila semua kandidat sibuk, proses gagal dengan pesan bahwa tidak ada port bebas untuk daemon.

**Endpoint bisa diganti tanpa restart.** Proxy lokal menyediakan `setEndpoint(next)`. Saat daemon baru ditemukan, ekstensi memanggil metode ini dan alamat tujuan proxy berubah langsung. Proses proxy tidak dihentikan, dan URL di `~/.omp/agent/models.yml` tidak perlu disunting ulang.

**Pemulihan bersifat malas dan digabung.** Satu request memanggil `onBridgeFailure()` paling banyak satu kali. Permintaan yang terjadi bersamaan memakai `Promise` heal yang sama. Setelah pemulihan gagal, percobaan berikutnya ditahan selama 5 detik. Model yang sama dicoba ulang sekali sesudah upaya pemulihan. Bila masih gagal, rantai fallback lanjut ke model berikutnya.

**Startup gagal tetap terlihat.** Baik kegagalan refresh saat ekstensi dimuat maupun kegagalan heal memanggil `pi.setStatus` dengan awalan `freepi: bridge offline ...`. Pesan error dari spawn, termasuk `stderr`, ikut tampil sehingga penyebabnya bisa dilacak lewat status dan `/freepi logs`.

Untuk memicu pemeriksaan ulang dari OMP, pakai `/freepi refresh-models` atau `/freepi start`. Menjalankan perintah `freepi-bridge start` secara manual tidak diperlukan untuk pemulihan rutin.

---

## Perintah

| Perintah | Fungsi |
|---|---|
| `/freepi status` | menampilkan status daemon, provider, dan token |
| `/freepi token` | menampilkan sumber token atau panduan masuk |
| `/freepi doctor` | menjalankan pemeriksaan `freepi-bridge doctor` |
| `/freepi models` | mendaftar id model yang tersedia |
| `/freepi refresh-models` | mengambil ulang `/v1/models` dan mendaftarkan provider kembali |
| `/freepi start` | menjalankan daemon |
| `/freepi stop` | menghentikan daemon |
| `/freepi restart` | menghentikan lalu menjalankan daemon |
| `/freepi ads` | menampilkan URL halaman iklan FreePi |
| `/freepi logs` | menampilkan bagian akhir `~/.freepi-bridge/bridge.log` |
| `/freepi install` | memasang atau memverifikasi biner `freepi-bridge` |

---

## Variabel lingkungan

| Variabel | Default | Efek |
|---|---|---|
| `FREEPI_TOKEN` | tidak diatur | JWT FreePi, prioritas tertinggi |
| `FREEPI_BRIDGE_BIN` | tidak diatur | Path eksplisit ke biner `freepi-bridge` |
| `FREEPI_BRIDGE_PORT` | `8787` | Kandidat port daemon untuk probe dan spawn. Bila sibuk, ekstensi memilih kandidat bebas lain. |
| `FREEPI_PROXY_PORT` | port daemon `+ 1` | Port yang diinginkan untuk proxy. Bila sudah dipakai, proxy memakai port bebas sementara. |
| `FREEPI_BASE_URL` | `https://api.freepi.ai` | API FreePi untuk pencarian tier model |
| `FREEPI_FREE_ONLY` | `1` | `1` hanya mendaftarkan model gratis. `0` menampilkan semua model, tidak menyaring di proxy, dan tidak mengubah `models.yml`. |
| `FREEPI_AUTO_AD` | `1` | Opsional, dipakai biner `freepi-bridge`, bukan ekstensi. `0` mematikan pelaporan iklan otomatis. Buka halaman `/ads` bila perlu. |
| `FREEPI_AUTO_UPDATE` | tidak diatur oleh ekstensi | Opsional, dipakai biner `freepi-bridge`, bukan ekstensi. Ekstensi tidak membaca atau memberi nilai default. |

---

## Pemecahan masalah

| Gejala | Penanganan |
|---|---|
| Status `freepi: bridge offline ...` | Baca pesan error lengkapnya, cek `/freepi logs`, verifikasi `/freepi token` dan `/freepi install`, lalu jalankan `/freepi refresh-models`. Ekstensi sudah mencoba spawn dan heal otomatis, jadi tidak perlu `freepi-bridge start` manual. |
| `freepi-bridge binary not found` | Jalankan `/freepi install` atau letakkan biner di `PATH`. |
| `401` atau error login | Jalankan `npx free-pi-cli@latest` atau tetapkan `FREEPI_TOKEN`. |
| Port sudah dipakai | Biasanya tidak perlu tindakan. Ekstensi memilih kandidat port bebas berikutnya. Tetapkan `FREEPI_BRIDGE_PORT` hanya bila ingin memaksa port tertentu. |
| `403 ads_required` | Tetapkan `FREEPI_AUTO_AD=0` dan buka halaman `/ads` yang dicetak bridge. |
| `403 At capacity for free users` | Model itu berbayar. Proxy akan mengalihkannya ke model gratis. `FREEPI_FREE_ONLY=0` mematikan penyaringan ini, jadi pakai id gratis bila opsi itu aktif. |
| Katalog masih menampilkan model berbayar | Jalankan `omp models refresh freepi`, karena OMP meng-cache daftar hasil discovery. |
| Daemon macet | Jalankan `/freepi restart`, lalu lihat log dengan `/freepi logs`. |
| URL di status berubah dari `8788` | Itu hasil pilihan port saat proxy atau daemon tidak bisa memakai port bawaan. Perbarui perintah atau konfigurasi yang menempel pada URL lama. |

---

## Cara kerja

```
pi/OMP ──▶ provider "freepi" (http://127.0.0.1:8788/v1, contoh default)
                 │
                 ▼
          proxy filter model gratis ──▶ freepi-bridge daemon (127.0.0.1:8787, contoh default)
                 │                        │
                 │                        └─ state: ~/.freepi-bridge/state.json
                 └─ daftar model gratis: ~/.freepi-bridge/free-models.json
                    cache model: ~/.freepi-bridge/pi-models.json
                    konfigurasi provider OMP: ~/.omp/agent/models.yml
```

Pemuatan ekstensi tidak menunggu jaringan. Provider didaftarkan lebih dulu dari cache model, lalu `refresh()` berjalan di latar belakang supaya `omp models` tetap cepat.

Ekstensi tidak menulis kredensial sendiri. Ekstensi hanya membaca lokasi token yang tercantum di atas dan menyerahkan proses masuk ke daemon.

---

## Pengembangan

```bash
npm install
npm run build          # esbuild → dist/index.js
omp plugin install .   # link local build
```
