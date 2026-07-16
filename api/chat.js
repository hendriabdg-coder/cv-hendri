const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");

// Batas harian per IP dan panjang pesan — sama seperti EnTe AI di
// endrichtech.com, menjaga budget API tetap aman dari penyalahgunaan.
const DAILY_LIMIT = 20;
const MAX_MESSAGE_LENGTH = 500;
const MAX_HISTORY = 6;

const SYSTEM_PROMPT = `Kamu bernama "EnTe AI", asisten AI di landing page CV pribadi Hendri Abd Ganing (bukan website bisnis Endrich Tech). Tugasmu menjawab pertanyaan pengunjung (calon klien freelance atau perekrut) tentang Hendri berdasarkan data berikut — jangan mengarang di luar ini.

PROFIL:
- Nama: Hendri Abd Ganing. Full-stack engineer otodidak dari Samarinda, Kalimantan Timur, Indonesia (GMT+8).
- Belajar coding otodidak sejak 2025, kurang dari setahun sudah merilis sistem yang jalan di production.
- Founder PT Endrich Teknologi Digital (disahkan Juli 2026).
- Pendidikan formal: SMAN 5 Watampone, jurusan IPA, lulus 2009 (bukan lulusan CS/bootcamp — full otodidak).
- Bahasa: Indonesia (native), Inggris (nyaman membaca/menulis teknis, speaking masih terus berkembang).
- KETERSEDIAAN: freelance, 12–15 jam per minggu — bukan full-time/kontrak karyawan, karena tetap menjalankan Endrich Tech.

PROYEK:
1. CoffeeShopHub (LIVE, 2025–2026) — SaaS multi-tenant berbasis WhatsApp untuk coffee shop di Indonesia: pesanan, resep, cost-of-goods, pembayaran lintas banyak tenant dalam satu codebase. Dibangun sendirian dari desain skema sampai deploy production. 273 test lolos, 100+ API endpoint, 29 tabel database, 12 modul. Stack: NestJS, TypeScript, PostgreSQL, Prisma, Next.js, Redis, Docker, Nginx, CI/CD, WhatsApp Cloud API, QRIS/Xendit. Saat ini ditawarkan untuk akuisisi seharga $3.500. Demo: https://coffeeshophub.endrichtech.com
2. HADir (dalam pengembangan, 2026) — HRIS PWA offline-first untuk kru tambang & kontraktor Indonesia. Absensi radius GPS + verifikasi wajah direkam di perangkat, sinkron otomatis saat jaringan kembali. Stack: NestJS, PWA, offline sync, face recognition, geofencing, PostgreSQL.
3. wa-bot-ai (dalam pengembangan, 2026) — layanan auto-reply WhatsApp bertenaga LLM, pesan masuk lewat webhook → antrian → dibalas asynchronous. Dua bahasa (EN/ID), admin panel. Stack: NestJS, BullMQ, Redis, Claude API, Webhooks, i18n.

STACK TEKNIS LENGKAP:
- Backend: NestJS, TypeScript, Node.js, REST, JWT/RBAC, BullMQ
- Data: PostgreSQL, Prisma, Redis, schema design, multi-tenancy
- Frontend: Next.js, React, PWA, responsive UI, HTML/CSS
- Deploy & Operasional: Docker, Nginx, CI/CD, Linux VPS, SSL, Git
- Testing: Jest, Supertest, E2E, Integration
- Integrasi: WhatsApp Cloud API, Claude API (Anthropic), Xendit/QRIS, Webhooks

KONTAK: email hendri@endrichtech.com, WhatsApp +62 823-4946-2700, Upwork (https://www.upwork.com/freelancers/~014796df4987bb4f77), GitHub @hendriabdg-coder.

TUGASMU:
- Jawab pertanyaan tentang skill, proyek, pengalaman, ketersediaan, dan cara kontak Hendri.
- Kalau pengunjung menceritakan kebutuhan proyeknya, jelaskan relevansi pengalaman Hendri secara jujur dan singkat, lalu arahkan untuk lanjut ke WhatsApp/email untuk diskusi konkret.
- Jawab dalam bahasa yang sama dengan pertanyaan pengunjung (Indonesia atau Inggris), singkat (maksimal 3-4 kalimat kecuali diminta detail).
- JANGAN menjawab pertanyaan di luar topik CV/profil Hendri ini — arahkan kembali dengan sopan.
- Jangan pernah mengarang angka, tanggal, atau klaim yang tidak ada di data di atas. Kalau ditanya harga freelance, arahkan untuk diskusi langsung via WhatsApp/email karena tergantung scope.`;

// Sama seperti di endrich-tech-app: bersihkan karakter tak kasat mata yang
// kadang kebawa saat copy-paste API key ke Environment Variables.
function sanitizeApiKey(key) {
  return key.replace(/[^\x21-\x7E]/g, "").trim();
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.headers["x-real-ip"] || "unknown";
}

async function checkAndIncrementRateLimit(supabase, ip) {
  const today = new Date().toISOString().slice(0, 10);

  const { data: existing } = await supabase
    .from("cv_chat_usage")
    .select("count")
    .eq("ip", ip)
    .eq("day", today)
    .maybeSingle();

  const currentCount = existing?.count ?? 0;
  if (currentCount >= DAILY_LIMIT) return false;

  await supabase.from("cv_chat_usage").upsert(
    { ip, day: today, count: currentCount + 1, updated_at: new Date().toISOString() },
    { onConflict: "ip,day" }
  );

  return true;
}

function isValidChatMessage(value) {
  if (!value || typeof value !== "object") return false;
  return (
    (value.role === "user" || value.role === "assistant") &&
    typeof value.content === "string" &&
    value.content.length <= MAX_MESSAGE_LENGTH
  );
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body = req.body || {};
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const rawHistory = Array.isArray(body.history) ? body.history : [];

    if (!message) {
      res.status(400).json({ error: "Pesan tidak boleh kosong." });
      return;
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({ error: "Pesan terlalu panjang, coba lebih singkat ya." });
      return;
    }

    const history = rawHistory.filter(isValidChatMessage).slice(-MAX_HISTORY);

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      res.status(503).json({ error: "Fitur chat AI belum dikonfigurasi di server." });
      return;
    }
    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

    const ip = getClientIp(req);
    const allowed = await checkAndIncrementRateLimit(supabase, ip);
    if (!allowed) {
      res.status(429).json({
        error: "Kamu sudah mencapai batas tanya AI untuk hari ini. Silakan hubungi Hendri langsung via WhatsApp ya!",
      });
      return;
    }

    const rawApiKey = process.env.ANTHROPIC_API_KEY;
    if (!rawApiKey) {
      res.status(503).json({ error: "Fitur chat AI belum dikonfigurasi di server." });
      return;
    }
    const apiKey = sanitizeApiKey(rawApiKey);

    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [...history, { role: "user", content: message }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    const reply = textBlock && textBlock.type === "text" ? textBlock.text : "Maaf, coba tanya lagi ya.";

    res.status(200).json({ reply });
  } catch (err) {
    console.error("CV chat API error:", err);
    res.status(500).json({
      error: "Maaf, EnTe AI sedang ada gangguan. Coba lagi sebentar atau hubungi Hendri via WhatsApp.",
    });
  }
};
