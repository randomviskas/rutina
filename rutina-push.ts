// Supabase Edge Function „rutina-push“ – siunčia pranešimus į telefonus (Web Push).
// Kviečia: DB trigeris (pakeitus planą), pg_cron (kas 5 min priminimams) ir rutina_test_push.
// Paslaptys (Edge Functions → Secrets): VAPID_PUBLIC, VAPID_PRIVATE, RUTINA_SECRET.
// JWT tikrinimas išjungtas – apsauga per x-rutina-secret antraštę.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
webpush.setVapidDetails("https://randomviskas.github.io/rutina/", Deno.env.get("VAPID_PUBLIC")!, Deno.env.get("VAPID_PRIVATE")!);

type Any = Record<string, any>;
const DAYS = ["Sk", "Pr", "An", "Tr", "Kt", "Pn", "Št"];
const hm = (m: number) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const dayLt = (d: string) => { const [y, mo, da] = d.split("-").map(Number); return DAYS[new Date(Date.UTC(y, mo - 1, da)).getUTCDay()] + " " + da + " d."; };
const other = (id: string) => (id === "a" ? ["b"] : ["a"]);
const name = (s: Any, id: string) => s?.people?.find((p: Any) => p.id === id)?.name ?? "";
const itemName = (s: Any, i: Any) => {
  if (i.kind === "event") return `${i.emoji ?? "📌"} ${i.title ?? "Įvykis"}`;
  const a = s?.acts?.find((x: Any) => x.id === i.actId);
  return a ? `${a.emoji} ${a.name}` : "Veikla";
};

async function push(room: string, to: string[], payload: Any) {
  const { data: subs } = await sb.from("rutina_subs").select("id, sub").eq("room", room).in("person", to);
  let n = 0;
  for (const s of subs ?? []) {
    try { await webpush.sendNotification(s.sub, JSON.stringify(payload), { TTL: 3600 }); n++; }
    catch (e) {
      const code = (e as Any)?.statusCode;
      if (code === 404 || code === 410) await sb.from("rutina_subs").delete().eq("id", s.id);
      else console.log("push klaida", code, String((e as Any)?.body ?? e).slice(0, 200));
    }
  }
  return n;
}

async function onChange(room: string, o: Any, n: Any) {
  let sent = 0;
  const msgIds = new Set((o?.messages ?? []).map((m: Any) => m.id));
  for (const m of (n?.messages ?? []).filter((m: Any) => !msgIds.has(m.id))) {
    sent += await push(room, other(m.by), { title: `💬 ${name(n, m.by)}`, body: m.text, tag: "msg", url: "./#msgs" });
  }
  const cIds = new Set((o?.comments ?? []).map((c: Any) => c.id));
  for (const c of (n?.comments ?? []).filter((c: Any) => !cIds.has(c.id))) {
    const it = (n?.items ?? []).find((i: Any) => i.id === c.itemId);
    sent += await push(room, other(c.by), { title: `💬 ${name(n, c.by)}${it ? " · " + itemName(n, it) : ""}`, body: c.text, tag: "cmt-" + c.itemId });
  }
  const by = n?.lastBy;
  if (by === "a" || by === "b") {
    const O = new Map((o?.items ?? []).map((i: Any) => [i.id, i]));
    const ch: string[] = [];
    for (const i of n?.items ?? []) {
      const p = O.get(i.id) as Any | undefined, nm = itemName(n, i);
      if (!p) { if (i.kind === "event" || i.pinned) ch.push(`＋ ${nm} · ${dayLt(i.date)} ${hm(i.start)}`); }
      else if (p.date !== i.date || p.start !== i.start) ch.push(`↪︎ ${nm} → ${dayLt(i.date)} ${hm(i.start)}`);
      else if (p.status !== "done" && i.status === "done") ch.push(`✓ ${nm} atlikta`);
    }
    const N = new Set((n?.items ?? []).map((i: Any) => i.id));
    for (const p of o?.items ?? []) if (!N.has(p.id) && (p.kind === "event" || p.pinned)) ch.push(`✕ ${itemName(o, p)} atšaukta`);
    if (ch.length && ch.length <= 6) sent += await push(room, other(by), { title: `🗓️ ${name(n, by)} pakeitė planą`, body: ch.join("\n"), tag: "plan" });
  }
  return sent;
}

function localNow(tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}

async function remind() {
  const { data: subs } = await sb.from("rutina_subs").select("room");
  const rooms = [...new Set((subs ?? []).map((s: Any) => s.room))];
  let sent = 0;
  for (const room of rooms) {
    const { data: row } = await sb.from("rutina_rooms").select("data").eq("room", room).single();
    const d = row?.data; if (!d) continue;
    let now; try { now = localNow(d.tz || "UTC"); } catch { now = localNow("UTC"); }
    for (const i of d.items ?? []) {
      if (i.date !== now.date || i.status === "done") continue;
      const left = i.start - now.min;
      if (left < 1 || left > 15) continue;
      const key = `${room}|${i.id}|${i.date}|${i.start}`;
      const { error } = await sb.from("rutina_reminded").insert({ key });
      if (error) continue; // jau priminta
      sent += await push(room, i.who, { title: `⏰ ${itemName(d, i)} po ${left} min`, body: `${hm(i.start)}–${hm(i.start + i.dur)}${i.who.length === 2 ? " · abu" : ""}`, tag: "rem-" + i.id });
    }
  }
  await sb.from("rutina_reminded").delete().lt("at", new Date(Date.now() - 3 * 864e5).toISOString());
  return sent;
}

// 📅 Apple kalendoriaus prenumerata (webcal): ?ics=<plano kodas>&p=a|b
const icsEsc = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\n/g, "\\n");
async function ics(room: string, p: string | null) {
  const { data: al } = await sb.from("rutina_alias").select("target").eq("room", room).maybeSingle();
  const { data: row } = await sb.from("rutina_rooms").select("data").eq("room", al?.target ?? room).maybeSingle();
  const d = row?.data;
  if (!d) return new Response("not found", { status: 404 });
  const dt = (date: string, m: number) => date.replace(/-/g, "") + "T" + hm(Math.min(m, 1439)).replace(":", "") + "00";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const from = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Musu rutina//LT", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:" + icsEsc(p ? "Rutina · " + name(d, p) : "Mūsų rutina"), "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M"];
  for (const i of d.items ?? []) {
    if (i.date < from || (p && !i.who?.includes(p))) continue;
    const who = i.who?.length === 2 ? "abu" : name(d, i.who?.[0]);
    const cm = (d.comments ?? []).filter((c: Any) => c.itemId === i.id).map((c: Any) => `${name(d, c.by)}: ${c.text}`).join("\n");
    L.push("BEGIN:VEVENT", "UID:" + i.id + "@rutina", "DTSTAMP:" + stamp, "DTSTART:" + dt(i.date, i.start), "DTEND:" + dt(i.date, i.start + i.dur),
      "SUMMARY:" + icsEsc(itemName(d, i) + (i.status === "done" ? " ✓" : "") + " (" + who + ")"));
    if (cm) L.push("DESCRIPTION:" + icsEsc(cm));
    L.push("END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return new Response(L.join("\r\n") + "\r\n", { headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-cache" } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url), k = url.searchParams.get("ics");
  if (req.method === "GET" && k && k.length >= 18) return ics(k, url.searchParams.get("p"));
  if (req.headers.get("x-rutina-secret") !== Deno.env.get("RUTINA_SECRET")) return new Response("no", { status: 401 });
  const b = await req.json().catch(() => ({}));
  let sent = 0;
  if (b.mode === "change") sent = await onChange(b.room, b.old, b.new);
  else if (b.mode === "remind") sent = await remind();
  else if (b.mode === "test") sent = await push(b.room, [b.to], { title: "🔔 Rutina", body: "Pranešimai veikia! ❤️", tag: "test" });
  return Response.json({ ok: true, sent });
});
