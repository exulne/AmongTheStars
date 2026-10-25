# Vela: the GPT assistant

A speech-to-speech and text assistant for the whole app. It answers questions about what is on screen and about this future from the simulation's own data, and it can drive the app. Code: `src/assistant/`, dev-server routes in `scripts/openaiDev.ts`.

Docs checked on 2026-10-25 (developers.openai.com): Realtime WebRTC guide, Realtime conversations guide, `POST /v1/realtime/client_secrets` reference. The key's model list was read with `GET /v1/models` to confirm `gpt-realtime-2.1` and `gpt-5.4-mini` are available.

## Architecture

```
 browser (src/assistant)                         dev server (scripts/openaiDev.ts)         OpenAI
 ───────────────────────                         ─────────────────────────────────         ──────
 Ask panel / Starship console
   │ click, key or Talk (a user gesture)
   ├─ getUserMedia (mic) ─┐
   └─ POST /openai/session ──────────────────►  reads OPENAI_API_KEY (loadEnv, server only)
                          │                     POST /v1/realtime/client_secrets ──────────►  ek_… (2 min)
                          │◄──────────────── { value: ek_…, expires_at, model, voice }
   RTCPeerConnection: mic track + "oai-events" data channel
   POST https://api.openai.com/v1/realtime/calls  (Bearer ek_…, SDP offer) ──────────────────►  SDP answer
   ◄═══════════ audio both ways (Opus over WebRTC), events on the data channel ═══════════════►
   session.update: instructions (persona + live context), tools, turn detection
   response.function_call_arguments.done → run the tool in the page (tools.ts)
   response.done → function_call_output items → response.create → spoken answer

 typed question, voice line closed:
   POST /openai/responses ───────────────────►  pins model gpt-5.4-mini, caps tokens,
                                                adds the key ────────────────────────────►  /v1/responses
   tool loop runs in the page: function_call → run → function_call_output (previous_response_id)
```

- **Models.** Voice: `gpt-realtime-2.1` (Realtime API, WebRTC). Input transcription for the on-screen transcript: `gpt-4o-mini-transcribe`. Text fallback: `gpt-5.4-mini` on the Responses API, reasoning effort low.
- **Voice.** `marin`, at speed 1.05. Of the voices the Realtime API offers today (alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar) OpenAI recommends `marin` and `cedar` for quality; `marin` is the warm, confident, feminine one. The persona (`prompt.ts`) is charismatic and quick, never flirtatious.
- **Files.**
  - `tools.ts`: the 22 tool definitions (JSON Schema) and their implementations against `SimClient` and the app (`AssistantHost`, built in `main.ts`).
  - `prompt.ts`: persona, what the app is, answering rules, and the live context block.
  - `realtime.ts`: the WebRTC session (connect, push-to-talk, hands-free, barge-in, tool calls, transcripts, errors).
  - `textChat.ts`: the Responses API tool loop for typed questions without a voice line.
  - `assistant.ts` + `assistant.css`: the Ask panel, keyboard shortcut, idle timer, context refresh, and the bridge to the Starship console.

## Tools

Everything about this future that the assistant says must come from these (the prompt forbids invented simulated facts). Results are compact JSON, numbers already formatted with units, years in calendar years.

| Tool | What it returns or does |
|---|---|
| `get_context` | year, future #, zoom level, era and named age, selection, aboard or not, how far the run has simulated, the inspector card as text |
| `global_metrics` | humanity-wide measures at a year (any of the 81 global series by key) |
| `find` | places, galaxies and technologies (the app's own search), and named people from the Chronicle |
| `place` | a world at a year: stage, population, founding, allegiance, polity, government, faith, language, economy, stability, life expectancy, recent events |
| `place_history` | one measure of a world through its history, sampled, with its peak |
| `residents` | a few residents (names, ages, jobs, ids) and the total |
| `person` | a life story: birth, family, partners, story, death |
| `chronicle` | Chronicle entries in a span of years, optionally about one world or matching text |
| `annals` | summary, polities, wars (with counts and deaths), faiths, named ages, natural upheavals, all as of a year |
| `society` | government and why, polity, bodies (baseline, adapted, uploaded), language, faiths, art, architecture, daily life, mood |
| `climate` | the inspector's Climate and geology section as text, with its R/E/P provenance tags |
| `launch_economics` | transport spending and its parts, launches, tanker flights, payload, people moved, cost per kg, satellites |
| `technologies` | inventions by a year and what is not yet invented |
| `data_query` | every living settlement filtered and ranked with the data desk's query language (`src/sim/query.ts`) |
| `data_scan` | a settlement query aggregated over the whole run |
| `way_of_war` | wars, deaths and outcomes in the last 500 years against the 500 before, and the war-mind generation |
| `go_to` | flies to a place, technology, "resident N of World" or a person id (optionally at a year), and returns what is there |
| `set_year` | moves the slider (a chrono trip when aboard) and returns once that year's state has loaded |
| `zoom` | multiverse, universe, galaxy, local, system, planet, street |
| `open_panel` | the Chronicle, or a Data tab (places, charts, groups, history, time, econ, orbits, impact, run) |
| `starship` | board, leave, cockpit or chase camera |
| `end_session` | closes the voice line after a goodbye |

## Latency

- Audio is streamed both ways over WebRTC; the first audio of an answer arrived about 1.3 s after a typed question in testing.
- A tool starts as soon as its arguments are complete (`response.function_call_arguments.done`), not when the response ends; tools run in parallel; data tools take 0 to 120 ms.
- The live context (year, era, place, selection, the start of the inspector card) is in the instructions from the first second and refreshed by `session.update` (at most every 2 s) as the user moves, so "what am I looking at?" needs no lookup. `go_to` returns a summary of the place so "take me to X" needs no second round trip.
- The microphone prompt and the client secret are requested in parallel.

## Security model

- **The key never reaches the browser.** `OPENAI_API_KEY` is read only in `vite.config.ts` with `loadEnv(mode, process.cwd(), '')` and handed to the dev-server plugin. It is not `VITE_`-prefixed, so Vite never inlines it; it is not in `define`; the routes never return or log it (OpenAI error messages are scrubbed of anything like `sk-…`). `.env.local` is gitignored (`git check-ignore .env.local` confirms).
- **The page gets a short-lived client secret.** `POST /openai/session` mints an `ek_…` secret that expires 120 s after creation (the minimum it needs: one SDP exchange). Model, voice, transcription and token cap are fixed server-side when it is minted.
- **The text proxy is pinned.** `POST /openai/responses` forwards only `instructions`, `input`, `tools` and `previous_response_id`; the model, reasoning effort and token cap are set by the server.
- **Other sites can't spend the key.** Requests with a foreign `Origin` are refused with 403, and both POST routes require `Content-Type: application/json`, which forces a CORS preflight the server never grants. Vite's own host check guards against DNS rebinding.
- **No server, no assistant.** The single-file build (`dist/index.html`, `dist/artifact.html`) has no server: the panel says "Voice assistant needs the local dev server" and the Start voice button is disabled. Nothing is fetched from a non-local page.
- **Proof.** After `npm run build`, a script reads the key from `.env.local` (without printing it) and searches every file in `dist/` for its first and last 8 characters, and for any `sk-` followed by 8 or more key characters. Result on 2026-10-25: 0 files contain either end of the key; the only `sk-` hits are CSS `mask-composite` and the word "ask-" in class names.

## Cost and safety

- No session starts without a user gesture (click, key press, or the Starship's Talk).
- The panel shows the state (`voice off`, `connecting…`, `voice live 1:23 · hold to talk` or `· listening`).
- Voice closes after 2 minutes without speech or questions, and on "goodbye" (`end_session`).
- Push-to-talk is the default: the mic track is muted except while the button or key is held, and the input buffer is cleared at each press, so nothing is sent between questions.
- Errors are spelled out: no key, key rejected, out of credits or over quota, rate limit, no dev server, microphone blocked, network.

## How to run

```bash
echo 'OPENAI_API_KEY=sk-...' >> .env.local   # gitignored
npm run dev
```

Click **Ask** in the header or tap `` ` ``. Type a question, hold *Hold to talk* (or hold `` ` ``), or turn on *Hands-free*. Aboard the Starship, the ship console is the assistant's face: *Talk* opens the voice line, questions go to Vela, and plain orders still use the offline parser.

Check the endpoint without a browser (prints only status and expiry):

```bash
curl -s -X POST -H 'Content-Type: application/json' -d '{}' http://localhost:5173/openai/session | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.error??`ok, expires ${new Date(j.expires_at*1000).toISOString()}`)})'
```

## Gaps

- The voice line and the text thread are separate conversations: opening voice starts a fresh thread.
- Named people are found through the Chronicle (captains, founders, rulers, prophets); an ordinary resident is found through `residents` or "resident N of World", not by name.
- The assistant sees the inspector card as text but not the 3D picture itself.
- A preview server (`vite preview`) also serves the routes; a static host of `dist/` does not.
