// Supabase Edge Function „rutina-ai“ – išmanusis asistentas (Claude).
// Programa siunčia: plano kodą, kas rašo ir tekstą. Funkcija pati pasiima planą iš DB,
// paklausia Claude ir grąžina { reply, actions } – programa veiksmus parodo patvirtinimui.
// Paslaptys (įveda vartotojas): ANTHROPIC_API_KEY. Neprivaloma: RUTINA_AI_MODEL (numatytas claude-haiku-5-5).
// JWT tikrinimas išjungtas – prieiga tik žinant plano kodą.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
// Vartotojo pasirinkimas (2026-11-16): pigesnis Haiku 5.5. Protingesnis – RUTINA_AI_MODEL = claude-opus-5-5.
const MODEL = Deno.env.get("RUTINA_AI_MODEL") || "claude-haiku-5-5";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, apikey, authorization", "Access-Control-Allow-Methods": "POST, OPTIONS" };
type Any = Record<string, any>;

const SYSTEM = `You are the planning assistant inside "Mūsų rutina", a shared daily-planner app for a couple: Paulius (id "a") and Milda (id "b"), currently travelling (Lombok, later Kuala Lumpur).
The user writes in Lithuanian (sometimes with typos, slang, English words or am/pm times). Understand intent and turn it into app actions by calling the \`plan\` tool exactly once. Always call the tool.

Rules:
- "reply": short, warm Lithuanian (max 2 sentences, emojis welcome). Say what you prepared. The app shows each action as a card the user confirms, so phrase it as a proposal ("Paruošiau…").
- Dates: use the provided "now" and resolve relative dates (šiandien, rytoj/ryt, poryt, weekdays like "penktadienį" = the next such day, "kitą pirmadienį" = next week's, "27 d.", "lapkričio 27"). Output YYYY-MM-DD.
- Times: 24h "HH:MM". "9 am" = 09:00, "7 pm" = 19:00. If no time is given, set start to null and the app will pick a free slot at a sensible time of day.
- duration_min: use the stated duration; otherwise a sensible typical one (meeting 60, call 30, dinner 120, flight 180, doctor 60).
- who: first-person PLURAL verbs ("-am/-ame/-im/-ime/-sim/-sime": nedirbam, dirbsim, einam, eisim, valgom, valgysim, darom, važiuojam, ilsimės) always mean "both" – also for work changes. Dinners/meals/outings with friends that the writer mentions without "aš" are usually "both".
- who: "a", "b" or "both". The writer is "me". Personal things default to the writer; "mes/abu/kartu/dirbam/su Milda/su Pauliumi" and couple activities mean "both"; a named person alone means that person.
- Existing planned activities (activity ids from "activities") go through add_activity with act_id; anything else is add_event with a clear Lithuanian title (no dates/times in the title) and one fitting emoji.
- Travel / flights / trips without a time: add_event with all_day=true. With a time: normal add_event.
- Recurring work schedule ("darbo dienomis", "kasdien", "pirmadieniais", "savaitgaliais nedirbu"): set_work_weekly with weekdays (Mon=0 … Sun=6) and ranges like "09:00-11:00" or "09:00-13:00, 14:00-17:00"; "" means not working. A single day: set_work_day. IMPORTANT: a singular weekday ("šeštadienį", "penktadienį", "rytoj", "27 d.") is ONE date → set_work_day for the next such date. Only plural weekday forms ("šeštadieniais", "pirmadieniais"), "kiekvieną …", "kasdien", "darbo dienomis", "visada", "paprastai" are recurring → set_work_weekly.
- Changing existing items: use their exact item_id from "items". move_item (new date and/or start), mark_done, skip_item (did not happen / cancel today), delete_item. Never invent item ids.
- "perdėlioti savaitę" / re-plan: regenerate_week.
- Questions about the plan ("kas rytoj?", "kada laisvi?"): answer in reply from the context, with actions [].
- If something is genuinely ambiguous, ask one short question in reply with actions []. Prefer acting with sensible defaults over asking.
- Several requests in one message → several actions.
- Messages are often dictated by voice: no punctuation, numbers as words ("vienuoliktos", "pusę dvylikos" = 11:30, "be penkiolikos trys" = 14:45 in the afternoon context), filler words. Interpret generously.
- Work: "dirbu/dirbsiu/dirbam/dirbsim" with a date = set_work_day for that date (e.g. "rytoj dirbsiu nuo 11 iki 12" → set_work_day, ranges "11:00-12:00"). "dirbsiu su Milda/Pauliumi" or "dirbam" → who "both". "nedirbu" → ranges "".
- Wake-up / bedtime ("keliuosi 8:25", "kėlimasis 7:30", "einu miegoti 23", "Milda keliasi 8") → set_sleep with wake and/or sleep for that person (people[].wake/sleep in context). You CAN change these – never say you can't.
- Anything the app stores (work, wake/sleep, events, activities) can be changed through actions; only say something is impossible if no action fits, and then also save_feedback.
- Bug reports or improvement ideas about the app itself ("neveikia…", "būtų gerai, kad programa…") → save_feedback with the text in title.
- Follow-ups refer to the conversation: "po to / poto / paskui" = right after the item just discussed or added (same date, start = its end time). "po darbo" = right when that person's work ends that day (see work_weekly / work_overrides). "ten pat", "tą pačią dieną" = same date as before. Previous cards appear in history as "[kortelė: …]".
- Never refuse because the day looks full: pick the most sensible time anyway (the app moves flexible auto activities). Meals: "valgyt/pavalgyt/valgom" → title "Pavalgyti" 🍽️, ~45–60 min (lunch 12–14, dinner 18–21) unless a duration is given.
- If it is late evening (after ~21:00 in "now") and no date is given for a new plan, assume tomorrow.
- Use 24h times between 06:00 and 23:59 unless clearly night; "2 val dieną" = 14:00, "8 vakaro" = 20:00.`;

const TOOL = {
  name: "plan",
  description: "Return the reply to show and the list of app actions to propose to the user.",
  input_schema: {
    type: "object",
    properties: {
      reply: { type: "string", description: "Short Lithuanian reply" },
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["add_event", "add_activity", "move_item", "mark_done", "skip_item", "delete_item", "set_work_weekly", "set_work_day", "set_sleep", "regenerate_week", "save_feedback"] },
            wake: { type: ["string", "null"], description: "set_sleep: new wake-up time HH:MM (null = unchanged)" },
            sleep: { type: ["string", "null"], description: "set_sleep: new bedtime HH:MM (null = unchanged)" },
            item_id: { type: ["string", "null"] },
            act_id: { type: ["string", "null"] },
            title: { type: ["string", "null"] },
            emoji: { type: ["string", "null"] },
            date: { type: ["string", "null"], description: "YYYY-MM-DD" },
            start: { type: ["string", "null"], description: "HH:MM 24h, or null to let the app choose" },
            duration_min: { type: ["integer", "null"] },
            who: { type: ["string", "null"], enum: ["a", "b", "both", null] },
            all_day: { type: ["boolean", "null"] },
            repeat_weeks: { type: ["integer", "null"], description: "Extra weekly repeats (0-12)" },
            weekdays: { type: ["array", "null"], items: { type: "integer" }, description: "Mon=0 … Sun=6" },
            ranges: { type: ["string", "null"], description: 'Work ranges "09:00-11:00, 14:00-17:00", "" = not working' },
          },
          required: ["type"],
        },
      },
    },
    required: ["reply", "actions"],
  },
};

const DAYKEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const LT = ["Pirmadienis", "Antradienis", "Trečiadienis", "Ketvirtadienis", "Penktadienis", "Šeštadienis", "Sekmadienis"];
const hm = (m: number) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
function localNow(tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const addDays = (s: string, n: number) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const wd = (s: string) => (new Date(s + "T00:00:00Z").getUTCDay() + 6) % 7;

function context(d: Any, me: string) {
  let now; try { now = localNow(d.tz || "Asia/Makassar"); } catch { now = localNow("UTC"); }
  const until = addDays(now.date, 14);
  const actName = (id: string) => d.acts?.find((a: Any) => a.id === id);
  const items = (d.items ?? []).filter((i: Any) => i.date >= now.date && i.date <= until).sort((x: Any, y: Any) => (x.date + hm(x.start)).localeCompare(y.date + hm(y.start)))
    .map((i: Any) => { const a = i.kind === "auto" ? actName(i.actId) : null;
      return { id: i.id, date: i.date, start: i.allDay ? null : hm(i.start), end: i.allDay ? null : hm(i.start + i.dur), title: a ? a.name : i.title, act_id: i.actId ?? null, who: i.who.length === 2 ? "both" : i.who[0], status: i.status, all_day: !!i.allDay }; });
  const ov: Any = {};
  for (const [k, v] of Object.entries(d.workOverride ?? {})) { const [p, dt] = k.split("|"); if (dt >= now.date && dt <= until) ov[k] = v; }
  return {
    now: `${now.date} ${LT[wd(now.date)]} ${now.time}`, timezone: d.tz, me,
    people: (d.people ?? []).map((p: Any) => ({ id: p.id, name: p.name, wake: p.wake, sleep: p.sleep })),
    activities: (d.acts ?? []).filter((a: Any) => a.on).map((a: Any) => ({ id: a.id, name: a.name, emoji: a.emoji, who: a.who, per_week: a.perWeek, duration_min: a.dur, window: `${a.from}-${a.to}` })),
    work_weekly: d.work, work_overrides: ov, items,
    next_14_days: [...Array(14)].map((_, i) => { const x = addDays(now.date, i); return `${x} ${LT[wd(x)]}`; }),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { room, me, text, history, ctx } = await req.json();
    if (!room || String(room).length < 18 || !text || String(text).length > 800) return Response.json({ error: "bad_request" }, { status: 400, headers: cors });
    if (!Deno.env.get("ANTHROPIC_API_KEY")) return Response.json({ error: "no_key" }, { status: 200, headers: cors });
    // apsauga: veikia tik su tikru plano kodu
    const { data: al } = await sb.from("rutina_alias").select("target").eq("room", room).maybeSingle();
    const ctxOk = ctx && typeof ctx === "object" && JSON.stringify(ctx).length < 60000;
    const { data: row } = await sb.from("rutina_rooms").select(ctxOk ? "room" : "data").eq("room", al?.target ?? room).maybeSingle();
    if (!row) return Response.json({ error: "no_room" }, { status: 404, headers: cors });
    const who = me === "b" ? "b" : "a";
    const context_ = ctxOk ? ctx : context((row as Any).data, who);

    const client = new Anthropic();
    const msgs: Anthropic.MessageParam[] = [];
    for (const h of (Array.isArray(history) ? history.slice(-6) : [])) {
      if (!h?.role || !h?.text) continue;
      const role = h.role === "me" ? "user" : "assistant", content = String(h.text).slice(0, 600);
      const last = msgs[msgs.length - 1];
      if (last && last.role === role) last.content = String(last.content) + "\n" + content; else msgs.push({ role, content });
    }
    while (msgs.length && msgs[0].role !== "user") msgs.shift();
    const cur = `CONTEXT (JSON):\n${JSON.stringify(context_)}\n\nMESSAGE FROM ${who === "b" ? "Milda" : "Paulius"}:\n${text}`;
    if (msgs.length && msgs[msgs.length - 1].role === "user") msgs.push({ role: "assistant", content: "(gerai)" });
    msgs.push({ role: "user", content: cur });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: [TOOL as Anthropic.Tool],
      output_config: { effort: "low" },
      messages: msgs,
    } as Anthropic.MessageCreateParams);

    if (response.stop_reason === "refusal") return Response.json({ error: "refusal" }, { headers: cors });
    const tool = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "plan");
    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    const out = tool ? (tool.input as Any) : { reply: textBlock?.text ?? "", actions: [] };
    return Response.json({ reply: String(out.reply ?? ""), actions: Array.isArray(out.actions) ? out.actions : [], model: response.model, usage: response.usage }, { headers: cors });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return Response.json({ error: "bad_key" }, { headers: cors });
    if (e instanceof Anthropic.RateLimitError) return Response.json({ error: "rate_limit" }, { headers: cors });
    if (e instanceof Anthropic.APIError) return Response.json({ error: "api_" + e.status, message: e.message }, { headers: cors });
    return Response.json({ error: "server", message: String(e) }, { status: 500, headers: cors });
  }
});
