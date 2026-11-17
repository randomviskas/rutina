// Supabase Edge Function „rutina-stt“ – balso atpažinimas lietuviškai (ElevenLabs Scribe).
// Programa siunčia multipart formą: room (plano kodas) + file (trumpas garso įrašas iš 🎤).
// Funkcija patikrina plano kodą, persiunčia garsą į ElevenLabs ir grąžina { text }.
// Paslaptys (įveda vartotojas): ELEVENLABS_API_KEY. Neprivaloma: RUTINA_STT_MODEL (numatytas scribe_v2).
// JWT tikrinimas išjungtas – prieiga tik žinant plano kodą.
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const MODEL = Deno.env.get("RUTINA_STT_MODEL") || "scribe_v2";
const MAX_BYTES = 4 * 1024 * 1024; // ~1 min įrašo – daugiau nei pakanka komandai
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, apikey, authorization", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });

async function transcribe(key: string, file: File, model: string) {
  const fd = new FormData();
  fd.append("model_id", model);
  fd.append("language_code", "lt");
  fd.append("tag_audio_events", "false");
  fd.append("file", file, file.name || "balsas");
  return await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key }, body: fd });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "bad_request" }, 405);
  try {
    const form = await req.formData();
    const room = String(form.get("room") ?? "");
    const file = form.get("file");
    if (room.length < 18 || !(file instanceof File) || file.size < 200) return json({ error: "bad_request" }, 400);
    if (file.size > MAX_BYTES) return json({ error: "too_long" }, 413);
    const key = Deno.env.get("ELEVENLABS_API_KEY") || Deno.env.get("elewenlabs") || Deno.env.get("elevenlabs"); // raktas Supabase išsaugotas pavadinimu „elewenlabs“
    if (!key) return json({ error: "no_key" });
    // apsauga: veikia tik su tikru plano kodu
    const { data: al } = await sb.from("rutina_alias").select("target").eq("room", room).maybeSingle();
    const { data: row } = await sb.from("rutina_rooms").select("room").eq("room", al?.target ?? room).maybeSingle();
    if (!row) return json({ error: "no_room" }, 404);

    let r = await transcribe(key, file, MODEL);
    // jei modelio pavadinimas netinka – bandom senesnį
    if ((r.status === 400 || r.status === 422) && MODEL !== "scribe_v1") r = await transcribe(key, file, "scribe_v1");
    if (r.status === 401) return json({ error: "bad_key" });
    if (r.status === 429) return json({ error: "rate_limit" });
    if (!r.ok) return json({ error: "api_" + r.status, message: (await r.text()).slice(0, 300) });
    const out = await r.json();
    return json({ text: String(out.text ?? "").trim(), lang: out.language_code ?? null });
  } catch (e) {
    return json({ error: "server", message: String(e) }, 500);
  }
});
