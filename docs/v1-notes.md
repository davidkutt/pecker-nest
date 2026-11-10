# V1 – Abweichungen vom Plan und Befunde

Stand 10.11.2026, Pi 1.5.0 (`@earendil-works/pi-coding-agent`; das alte Paket `@mariozechner/pi-coding-agent` ist abgekündigt). Die Abschnitte stehen in umgekehrter Reihenfolge: zuerst das Update vom 10.11. (Setup-Härtung und Modell-Passung), dann das vom 08.11. (Kimi K3.1 Pro als Ersatzmodell), dann Strategie A vom 07.11., dann der Teil vom 30.10. (Update „GLM 5.3 & DeepSeek über OpenRouter“). Grundlage sind die Docs, der Quellcode und die Typdeklarationen aus den npm-Paketen. pi.dev selbst war aus der Build-Umgebung nicht erreichbar.

## Update 10.11.2026: Setup-Härtung und Modell-Passung

Aus der Übergabe vom 10.11.: Die drei Modelle sollen so gut laufen, wie diese Harness es zulässt, und die Setup-Schritte, bei denen ein kleiner Fehler Geld kostet oder still schlechtere Ergebnisse liefert, sollen wegfallen. Zehn Punkte, ein Commit je Punkt.

**Was neu ist:**

| Bereich | Vorher (08.11.) | Jetzt (10.11.) |
| --- | --- | --- |
| Denkstufe des starken Modells | `max` nur für `/plan`; Eskalationen (`gate`, `loop`, `stuck`) und `/hard` auf `high`; Reviewer `high` | immer `max`, auch der Reviewer. Flash bleibt auf `high`. Hinweise lauten `router: GLM 5.3 at max (gate: …)`. |
| Kimi übernimmt von Flash | Wiederholte Assistant-Nachrichten ohne `reasoning_content`; Moonshot kann das mit HTTP 400 ablehnen | `modelOverrides` in `agent/models.json` setzt `requiresReasoningContentOnAssistantMessages` für `moonshotai/kimi-k3.1-pro` |
| Starkes Modell scheitert bei der Anfrage | Der Router wich nur aus, wenn das Modell in der Registry fehlte. Bei „No endpoints found“ endete der Lauf; bei einem von Pi wiederholten Fehler bekam dasselbe Modell die Anfrage wieder | gewähltes Modell → GLM 5.3 → Flash, mit einem Hinweis je Modell. Der Lauf geht weiter, und das Modell bleibt übersprungen, bis Pi neu startet oder du es mit `/strong <modell>` wieder wählst |
| Container-Key | Ohne `PI_RUN_OPENROUTER_API_KEY` nahm `pi-run.sh` den `OPENROUTER_API_KEY` und warnte nur | `PI_RUN_OPENROUTER_API_KEY`, sonst der Schlüsselbund-Eintrag `pecker-nest-container-key`; `OPENROUTER_API_KEY` nur mit `PI_RUN_ALLOW_INTERACTIVE_KEY=1`. Sonst Exit-Code 64 mit dem Schlüsselbund-Befehl |
| Image | `docker build` von Hand; ein veraltetes Image lief ohne jedes Zeichen | `scripts/build-image.sh` setzt die Labels `nest.commit` und `nest.dirty`; `pi-run.sh` startet nur ein Image vom aktuellen Commit (sonst Exit-Code 65, `PI_RUN_ALLOW_STALE_IMAGE=1` übergeht es) |
| Bereitschaft prüfen | Einzelbefehle aus Setup-Guide und Runbook | `scripts/doctor.sh [--repo <pfad>]`: je Prüfung eine Zeile `PASS`, `WARN` oder `FAIL` mit dem Befehl, der es behebt |
| Echte Modelle | nichts live getestet | `scripts/probe-openrouter.ts`, das du selbst startest (Runbook, Abschnitt „Live-Probe“) |
| Knowledge Base im System-Prompt | `APPEND_SYSTEM.md` verwies auf `mcp__kb__*`, obwohl `mcp.json` leer ist | Abschnitt entfernt, bis der Server eingetragen ist (Runbook M3, Schritt 4); `/review` schlägt nur nach, wenn die Tools da sind |
| Gate-Ausgabe | die letzten 80 Zeilen | die ersten 30 und die letzten 50 Zeilen mit einer Auslassungsmarke, im selben Zeichenbudget |
| Doku | Befehle für bash/zsh, Key per `export` | fish berücksichtigt (wo es abweicht: erst bash/zsh, dann fish), Key im Schlüsselbund, `/login openrouter` statt `export` |

**Warum `max`:** Laut Übergabe empfiehlt Z.ai für Coding mit GLM 5.3 die Stufe `max` und veröffentlicht für sie einen höheren Wert als für `high` auf dem eigenen Coding-Benchmark; Moonshots Coding-Ergebnisse für Kimi K3.1 Pro entstanden auf `max` (öffentliche Doku der Anbieter, per Websuche am 10.11.; hier nicht erneut geprüft). Eine Eskalation heißt außerdem, dass Flash schon hängt; dort am Nachdenken zu sparen ist die falsche Stelle. **Der Preis:** Jeder Aufruf des starken Modells erzeugt mehr Output-Tokens, denn Reasoning zählt als Output (GLM 4,40 USD, Kimi 10 USD je Million). Die Wirkung zeigt der Session-Report: Die Spalte „Thinking“ der Modelltabelle nennt die Stufe, „Output“ und „Cost“ daneben den Verbrauch. Vergleiche die Sessions vor und nach dem 10.11.

**Wie das Ausweichen bei der Anfrage funktioniert** (aus Pis Quellcode, 1.5.0):
- Pi wiederholt eine Anfrage nur, wenn die Fehlermeldung nach etwas Vorübergehendem aussieht (`pi-ai/dist/utils/retry.js`: 429, 5xx, „overloaded“, „Provider returned error“, Netzwerkfehler). Der Router bekommt dann `reason: "retry"` samt der gescheiterten Nachricht.
- „No endpoints found“ (HTTP 404) gehört nicht dazu: Der Lauf endete mit Exit-Code 1. Die Fehlermeldung hat die Form `404: {"message":"No endpoints found …","code":404}`.
- Deshalb zwei Wege. Wiederholt Pi selbst (z. B. 400 „Provider returned error“), wechselt der Router in der Wiederholung das Modell. Wiederholt Pi nicht, merkt sich der Router die gescheiterte Antwort in `turn_end`, nimmt sie in `agent_before_settle` per `context_edit` aus dem Kontext (so wie Pi es bei eigenen Wiederholungen tut) und setzt den Lauf fort. `turn_end` selbst kann nach einem Fehler nicht fortsetzen; `agent_before_settle` schon.
- Ausgewichen wird nur bei Routing-Fehlern (404, „No endpoints found“, unbekanntes Modell) und abgelehnten Anfragen (400, 422). Rate-Limits, Überlast und Serverfehler bleiben beim selben Modell. Bei 401, 402 und 403 (Key, Guthaben, Moderation) und bei Kontextüberlauf wechselt der Router nicht, weil ein anderes Modell daran nichts ändert.
- Die Einordnung steht als reine Logik in `extensions/lib/router-logic.ts` (`failureKind`, `ruledOut`, `strongCandidates`). Trifft der Fehler Flash, endet der Lauf wie bisher.

**Weitere Befunde:**
- **Eigenes Reasoning beim Wiederholen:** Für Modelle mit `requiresReasoningContentOnAssistantMessages` schickt Pi das eigene Denken des Modells im Feld `reasoning` zurück und setzt daneben ein leeres `reasoning_content` (im Mock gemessen, bei Flash schon vor dem 10.11.). Für Kimi gilt das jetzt auch. Ob Moonshot über OpenRouter diese Kombination annimmt, zeigt die Probe im Abschnitt „Tool loop“ (Spalte „Earlier turns replayed as“).
- **`/plan` auf Flash bleibt `max`.** Kann das starke Modell ein Gespräch nicht übernehmen (Bilder mit GLM, kein starkes Modell verfügbar), plant Flash wie bisher auf `max`. In allen anderen Fällen läuft Flash auf `high`, auch wenn es eine Eskalation selbst übernehmen muss.
- **Exit-Codes von `pi-run.sh`:** neu 64 (falscher Aufruf oder kein Container-Key) und 65 (Image fehlt oder ist veraltet). Ein fehlendes Image stoppt den Lauf immer, auch mit `PI_RUN_ALLOW_STALE_IMAGE=1`: Docker würde sonst versuchen, den Namen aus einer Registry zu laden.
- **`doctor.sh` prüft den Login ohne die Variable.** Ein exportierter `OPENROUTER_API_KEY` kann so keinen fehlenden `/login openrouter` verdecken. Ein fehlendes Kimi ist nur ein `WARN`, weil der Router dann auf GLM ausweicht. Den Schlüsselbund fragt es nur nach der Existenz des Eintrags (ohne `-w`).
- **OpenRouter-Doku** (Websuche am 10.11.; `openrouter.ai` selbst war aus der Build-Umgebung nicht erreichbar): Die Provider eines Modells liefert `GET /api/v1/models/{author}/{slug}/endpoints`, die ZDR-Vorschau `GET /api/v1/endpoints/zdr` (braucht womöglich einen Management-Key; die Probe meldet den Fehler dann im Wortlaut und führt ZDR als „unknown“). Ein Request-Feld, das Reasoning aus früheren Turns erhält, ist dort nicht dokumentiert; das von einer Drittquelle genannte `reasoning.context` bleibt unbestätigt. Z.ais eigenes Feld ist `thinking: { type: "enabled", clear_thinking: false }`; die Probe schickt es im Abschnitt 4 als Variante mit. `agent/models.json` ändert sich dafür nicht.
- **Feldnamen der Endpoints-Antwort:** Das offizielle Schema ließ sich nicht abrufen. Aus Sekundärquellen belegt sind `provider_name`, `quantization`, `pricing`, `status`, `supported_parameters` und `context_length`. Die Probe liest die Antwort deshalb nachsichtig und zeigt fehlende Werte als „–“; stimmt ein Feldname nicht, sieht man es im Bericht sofort.

**Getestet:** 271 Unit-Tests und 23 E2E-Szenarien (vier neu: Kimi übernimmt eine Tool-Schleife von Flash; 404 für Kimi → GLM mit genau einem Hinweis; beide starken Modelle scheitern → Flash; 400 wechselt in Pis Wiederholung, 429 bleibt beim Modell). `pi-run.sh`, `build-image.sh` und `doctor.sh` laufen in den Tests gegen Stub-Programme für `docker`, `security` und `pi`, zusätzlich einmal unter Bash 3.2.57. `npm run e2e:docker` lief gegen ein Image, das `build-image.sh` gebaut hat (siehe unten zur Einschränkung).

**Nicht getestet:**
- **Die echten Modelle und OpenRouter.** Die Probe hat keine echte Anfrage gesendet: Es gab keinen Key, und `openrouter.ai` war nicht erreichbar. Geprüft sind ihre Auswertung und ihr Bericht mit Fixtures, und gegen den Mock, dass ihre Anfragen die Form haben, die Pi schickt. Offen bleibt damit alles, was sie klären soll: ob Kimi das leere `reasoning_content` wirklich braucht, ob GLM es auch braucht, welche Provider unter ZDR übrig bleiben, ob der Cache trifft.
- **Ob `max` besser ist als `high`.** Das stützt sich auf die Angaben der Anbieter, nicht auf eigene Messungen.
- **macOS:** Der Schlüsselbund (`security`) ist nur als Stub getestet, Docker Desktop gar nicht. Bash 3.2.57 lief als Linux-Build, nicht auf einem Mac.
- **Das echte Image:** Die Debian-Mirrors waren wieder gesperrt, Docker Hub gedrosselt. Gebaut wurde mit `build-image.sh` eine Variante des `Dockerfile.pi` auf `node:24-bookworm` ohne den `apt-get`- und den uv-Schritt. Die Labels, die Prüfung in `pi-run.sh` und `doctor.sh` gegen den echten Docker-Daemon und `npm run e2e:docker` sind damit geprüft, der unveränderte Build nicht.
- **Interaktive TUI:** Die Hinweise des Routers beim Ausweichen sind im Print-Modus geprüft, nicht in der TUI.

## Update 08.11.2026: Kimi K3.1 Pro als Ersatzmodell, DeepSeek V4.1 Pro

Entschieden im Planungschat am 08.11.: Kimi K3.1 Pro kommt als **optionales** Ersatzmodell für GLM 5.3 dazu und wird an zwei, drei M1-Schritten gegen GLM getestet. GLM bleibt der Standard, damit die Übergabezahlen der bisherigen Sessions vergleichbar bleiben.

**Was neu ist:**

| Bereich | Vorher (07.11.) | Jetzt (08.11.) |
| --- | --- | --- |
| Starkes Modell | fest GLM 5.3 | wählbar: GLM 5.3 (Standard) oder Kimi K3.1 Pro, umgeschaltet mit `/strong glm\|kimi` |
| Router-Befehle | `/hard`, `/flash` | zusätzlich `/strong [glm\|kimi]`; ohne Argument zeigt er die aktuelle Wahl |
| Bilder | Ein Gespräch mit Bildern bleibt immer auf Flash (GLM liest keine Bilder) | Mit `kimi` kann auch ein Gespräch mit Bildern eskalieren, denn Kimi liest Bilder. Mit `glm` wie bisher. |
| Session-Report | Wechsel je Grund | zusätzlich je starkem Modell („By strong model: GLM 5.3 1, Kimi K3.1 Pro 2“) |
| `enabledModels`, `compaction.modelOverrides` | Router, Flash, GLM | zusätzlich `openrouter/moonshotai/kimi-k3.1-pro` (`reserveTokens: 800000`) |

**Kimi K3.1 Pro** (`moonshotai/kimi-k3.1-pro`): im Katalog von Pi 1.5.0 vorhanden, Text und Bilder, Denkstufen `off`, `low`, `high`, `max`, 1M Kontext. Preis bei OpenRouter etwa 2 / 10 / 0,20 USD je Million Tokens (Input / Output / Cache-Read); GLM 5.3 liegt bei etwa 1,40 / 4,40 / 0,26. Kimi kostet also beim Input knapp das 1,5-Fache, beim Output gut das Doppelte, beim Cache-Read etwas weniger. Der Vergleich muss deshalb zeigen, dass die Antworten besser sind, nicht nur anders.

**Wie `/strong` sich verhält:**
- Es entscheidet, welches Modell der Router für `/plan`, für Eskalationen und für `/hard` holt (seit 10.11. alles auf `max`, vorher Eskalationen und `/hard` auf `high`). Flash bleibt in jedem Fall das Arbeitsmodell.
- Wie `/hard` schaltet es nur um und sendet keine Nachricht; den Prompt tippst du danach. (Eine von einer Extension gesendete Nachricht würde den `/plan`-Modus des Safety-Gates erben, siehe Befund vom 07.11.)
- Die Wahl steht im Router-State, nicht in einer Variablen im Prozess: sie folgt `/tree` und Forks und übersteht Neustarts und Kompaktierung.
- Alte Sessions bleiben lesbar. Vor `/strong` hieß die starke Stufe im State `tier: "glm"`; `readState()` liest das als die starke Stufe mit GLM. Der Session-Report zählt solche Wechsel weiter als GLM.
- Fehlt das gewählte Modell in der Registry (mit ZDR bleibt womöglich kein Provider übrig), fällt der Router auf GLM 5.3 zurück, dann auf Flash, mit genau einem Hinweis je fehlendem Modell. Er wirft dabei keinen Fehler; die Session bleibt benutzbar.
- Hinweise nennen das Modell beim Namen, z. B. `router: Kimi K3.1 Pro at max (plan)`.

**Der Reviewer bleibt auf GLM.** Für den Vergleich im Review brauchst du keinen Rollenwechsel, sondern den Override für genau einen Lauf (pi-subagents, `docs/models.md`):

```text
/run reviewer[model=openrouter/moonshotai/kimi-k3.1-pro:max] "<Aufgabe>"
```

Das ist in einem E2E-Szenario geprüft (RPC-Modus wie in der TUI): Der Reviewer läuft dann auf Kimi mit `max` (seit 10.11., wie die Rolle selbst; vorher `high`), behält seine Routing-Vorgaben und bekommt weiterhin keine Schreib-Tools. `agent/agents/reviewer.md` bleibt unverändert auf GLM, der Override gilt nur für diesen Lauf.

**DeepSeek V4.1 Pro:** weiter beobachten, es gibt kein Erscheinungsdatum. Sobald es da ist, mit Flash und dem starken Modell vergleichen; bis dahin ändert sich nichts.

**Safety Gate:** Claude Codes Konfigurationsverzeichnis (`${CLAUDE_CONFIG_DIR:-~/.claude}`) gilt jetzt wie dieses Repo und Pis Agent-Verzeichnis als Harness: nest kann die Einstellungen, Skills und Hooks des Harness nicht ändern, der seine Sessions begleitet. Nötig, weil pecker-groves `CLAUDE.md` Agenten anweist, Skills nach `~/.claude/skills` zu schreiben.

**`templates/undertext/protect.json` korrigiert.** Die Globs vom 07.11. (`evals/samples/test*.jsonl` usw.) passten nicht zu undertexts echtem Layout. Die zurückgehaltenen Dateien heißen `evals/samples/harness-holdout.jsonl` und `harness-gaps.jsonl` (undertext PR #2), der Präfix steht also vor dem Namen des Splits. Davids Test-Split existiert noch nicht. Geschützt wird jetzt vor Lesen und Schreiben:

| Glob | Warum |
| --- | --- |
| `evals/samples/*test*.jsonl` | Davids Test-Split, sobald er angelegt wird |
| `evals/samples/*holdout*.jsonl` | `harness-holdout.jsonl` und künftige Holdouts |
| `evals/samples/*gaps*.jsonl` | `harness-gaps.jsonl` |
| `evals/import/**` | das Mapping des Konverters nennt die Quellen der zurückgehaltenen Samples |

Die Befehlsregel (`--split test|holdout|gaps`) bleibt. Ein Unit-Test lädt die Vorlage wie das Safety-Gate eine `.pi/protect.json` und prüft sie gegen diese Dateinamen, damit die Globs nicht wieder am Layout vorbeigehen.

**Claude-Code-Skills:** `/nest-supervise` darf auf Davids Bitte den Branch pushen und den PR für nests Arbeit eröffnen (Kategorie `admin`, die `/nest-handoff` nicht gegen nest zählt; nicht mergen, den Code nicht mergefähig machen). `/nest-handoff` füllt die neue Tabelle „Model comparison“ in der Feldnotiz, wenn die Session einen Vergleich hatte.

**Nicht getestet:** die echten Modelle, also auch, ob Kimi bei OpenRouter mit ZDR einen Provider hat und ob seine Antworten besser sind als die von GLM. Das ist der Zweck des Vergleichs in RUNBOOK M5. Getestet ist die Verdrahtung: `/strong kimi` lässt `/plan` auf Kimi mit `max` laufen, eine Schleife eskaliert auf Kimi, `/strong glm` geht zurück, und ein fehlendes Kimi fällt auf GLM zurück, ohne zu werfen (vier neue E2E-Szenarien plus Unit-Tests).

## Update 07.11.2026: Strategie A

Entschieden im Planungschat: DeepSeek V4.1 Flash arbeitet, GLM 5.3 springt ein (Strategie A). Getestet wird an echter Arbeit (undertext M1, danach pecker-grove), nicht an den Pilot-Repos; Claude Code beobachtet und schreibt nach jeder Session eine Übergabe.

**Warum die Modelle wechseln:**
- DeepSeek hat am 10.09. V4.1 Flash veröffentlicht und leitet seit dem 14.09. Anfragen an V4 Pro auf V4.1 Flash um. Der bisherige Reviewer (V4 Pro 0813) fällt weg. V4.1 Flash nimmt Bilder an, GLM 5.3 nicht.
- nest nutzt den Stand vom 17.10. (`deepseek/deepseek-v4.1-flash-1017`, entschieden am 08.11.). Bei OpenRouter ist `deepseek/deepseek-v4.1-flash` ohne Datum der Stand vom 10.09., kein Alias auf den neuesten. Laut DeepSeek ist 1017 bei Coding und Agent-Aufgaben besser und schreibt kürzere Antworten, zum selben Preis. Wie viele Provider ihn bei OpenRouter bedienen, ändert sich laufend: Am 08.11. stand hier „12 statt rund 38“, am 10.11.2026 listete die Modellseite 40. Maßgeblich ist, welche davon mit ZDR übrig bleiben; das zeigt `node scripts/probe-openrouter.ts` im Abschnitt „Endpoints“.
- GLM 5.3 kostet bei OpenRouter etwa 1,40 / 4,40 / 0,26 USD (Input / Output / Cache-Read je Million Tokens), nicht 0,079 / 1,40 / 0,078 wie im Pi-Katalog 1.4.0. V4.1 Flash liegt je nach Provider bei etwa 0,15–0,30 / 0,60–1,20 / 0,003–0,03. Bei Coding-Agents dominiert der Cache-Read, deshalb ist eine lange Session auf Flash grob 10- bis 40-mal billiger.

**Was sich geändert hat:**

| Bereich | Vorher (30.10.) | Jetzt (07.11.) |
| --- | --- | --- |
| Pi / pi-subagents | 1.4.0 / 0.83.1 | 1.5.0 / 0.87.0 (Prüfung unten) |
| Flash-Modell | `deepseek/deepseek-v4-flash-0731` | `deepseek/deepseek-v4.1-flash-1017` |
| Standardmodell | `openrouter/z-ai/glm-5.3` (`high`) | `router/escalate` |
| Router | `router/phased`: GLM plant auf `max`, baut auf `high` | `router/escalate`: Flash `high` für jeden Prompt; GLM `max` für `/plan`; GLM `high`, wenn das Quality Gate in Reparaturrunde 2 noch rot ist, bei Schleifen (dreimal derselbe Tool-Aufruf, drei fehlgeschlagene Edits an einer Datei, fünf fehlgeschlagene Tool-Aufrufe in Folge) und mit `/hard` bis `/flash`. Ein Gespräch mit Bildern bleibt auf Flash. (Seit 08.11. ist das starke Modell mit `/strong` wählbar; mit Kimi eskaliert auch ein Gespräch mit Bildern. Seit 10.11. läuft das starke Modell immer auf `max`.) |
| Rollen | scout V4 Flash `low`, planner GLM `max`, worker GLM `high`, reviewer V4 Pro `high` | scout V4.1 Flash `low`, planner GLM `max`, worker V4.1 Flash `high`, reviewer GLM `high` (seit 10.11. `max`) |
| Builtins | `oracle`, `delegate` auf GLM | `delegate` auf Flash (`subagents.defaultModel`), `oracle` auf GLM |
| Kompaktierung | bei ~1M Kontext (Standard `reserveTokens` 16k) | bei ~250k: `compaction.modelOverrides` mit `reserveTokens: 800000` für Router, Flash und GLM. Andere Modelle behalten den Standard. |
| Safety Gate | feste Regeln | zusätzlich: `.pi/` ist für den Agenten tabu, ebenso dieses Repo und Pis Agent-Verzeichnis (seit 08.11. auch Claude Codes Konfigurationsverzeichnis); `.pi/protect.json` je Repo (Pfade nicht schreiben, Pfade nicht lesen, Befehle nicht ausführen; Zeilen mit geschützten Pfaden werden aus grep-, find-, ls- und bash-Ausgaben entfernt). Eine kaputte `protect.json` sperrt alle Schreibzugriffe und Befehle. |
| Neu | – | Checkpoints vor jedem Prompt (`/rewind`, `/checkpoints`), `todo`- und `questionnaire`-Tool (unverändert aus Pis Beispielen), Skill `grill-me` (nur manuell), `scripts/session-report.ts`, Claude-Code-Skills `/nest-supervise` und `/nest-handoff`, `field-notes/` (lokal) |

**Befunde aus dem Umbau:**
- **Pis `git-checkpoint.ts`-Beispiel taugt nicht als Undo.** Es hält Checkpoints nur im Speicher, verwirft sie nach jedem Lauf und übergeht ungetrackte Dateien. `extensions/checkpoint.ts` ist deshalb eigener Code: temporärer Index, Commit-Objekt, Ref unter `refs/nest/checkpoints/`. Index, Branch und Stash bleiben unberührt, ignorierte Dateien werden weder gesichert noch gelöscht.
- **Subagents laden die Package-Extensions.** In den E2E-Läufen mit pi-subagents 0.87.0 haben scout, planner und reviewer die Extensions dieses Packages geladen (Checkpoint-Einträge in ihren Sessions). Das Safety-Gate läuft dort also doppelt (Package und `defaultSubagentOnlyExtensions`); das schadet nicht. Der Session-Report zählt Checkpoints und Prompts nur aus der Hauptsession.
- **Die vendorten Beispiele bestehen den strengen Typecheck nicht** (`StringEnum` in `todo.ts`). Zur Laufzeit sind sie in Ordnung; `extensions/vendor/` ist vom `tsc`-Lauf ausgenommen, die E2E-Tests laden sie.
- **Kompaktierung:** Ein globales `reserveTokens: 800000` würde bei jedem Modell mit kleinerem Fenster sofort und dauernd kompaktieren. Deshalb nur per `modelOverrides`.
- **`/hard` sendet keine Nachricht.** Eine von einer Extension gesendete Nachricht würde den `/plan`-Modus des Safety-Gates erben. `/hard` und `/flash` schalten deshalb nur um; den Prompt tippst du danach.

**Nicht getestet** (wie bisher): echte Modelle, was OpenRouter mit ZDR für V4.1 Flash routet, interaktive TUI (Benachrichtigungen des Routers, `/rewind`-Dialog). Die Logik von `/rewind` ist mit echtem git unit-getestet, der Dialog nicht.

## Abweichungen vom Plan

| Plan | Umgesetzt | Grund |
| --- | --- | --- |
| Repo `pi-config` | Repo `pecker-nest`, Pfad fest `~/dev/pecker-nest` | `agent/settings.json` ist ein Symlink und kann keine maschinenspezifischen Pfade enthalten. `~/dev/pecker-nest` ist auf dem Host und im Image (`/home/node/dev/pecker-nest`) gleich. |
| `pi install ~/dev/pi-config` | Package steht direkt in `settings.json`; `pi list` zeigt zusätzlich `npm:pi-subagents@0.83.1` | Spart den Schritt. Pi installiert fehlende Packages beim Start selbst, im Image schon beim Build. |
| Gespeicherte Kette „review-chain“ | Prompt-Templates mit `chain:` (`/prompt-workflow review-chain …`) plus `/review-chain …` | pi-subagents 0.83 hat `.chain.md` entfernt. `/prompt-workflow` läuft in TUI und RPC, nicht mit `pi -p`. Headless startet `/review-chain` die Kette über das Modell. |
| Subagents erben die Gates | Safety-Gate per `subagents.defaultSubagentOnlyExtensions` | Vordergrund-Subagents laden keine Extensions der Hauptsession. Ohne diese Einstellung liefe der Worker ohne Safety-Gate. |
| Quality Gate im Worker | Der Worker führt den Check laut Prompt selbst aus (max. 2 Wiederholungen); die Hauptsession prüft per git | Das Quality-Gate der Hauptsession erkennt Änderungen per git, also auch die von Subagents. |
| `Dockerfile.pi` nach offiziellem Beispiel | Zusätzlich `task.sh`: Setup im Container, Pi, Gate-Nachprüfung; Läufe unter Linux als Host-uid | Host-`node_modules`/`.venv` passen nicht ins Linux-Image und dürfen nicht überschrieben werden. Unter Linux mit uid ≠ 1000 wäre das Repo sonst nicht beschreibbar. |
| uv aus dem offiziellen Image (`ghcr.io/astral-sh/uv`) | uv per pip von PyPI, Version gepinnt | Gleiche Version, eine Registry weniger. |
| Scout auf der „niedrigsten verfügbaren“ Denkstufe | `low` | DeepSeek V4 Flash bietet auch `off`. `low` behält etwas Reasoning für zuverlässige Tool-Aufrufe; `off` ist eine Zeile in `agent/agents/scout.md`. |
| Router-Code aus dem Update | Gleiches Verhalten, angeboten wird nur die Stufe `high` | Die Phase bestimmt die Stufe (`max` → `high`); eine wählbare Stufe hätte keine Wirkung. |
| `-e OPENROUTER_API_KEY` (Container-Key) | `pi-run.sh` liest `PI_RUN_OPENROUTER_API_KEY` und gibt ihn als `OPENROUTER_API_KEY` in den Container | Dein interaktiver Key (ohne Limit) landet so nicht versehentlich im Container. Seit 10.11.: Fehlt die Variable, liest das Skript den macOS-Schlüsselbund (`pecker-nest-container-key`); `OPENROUTER_API_KEY` nimmt es nur noch mit `PI_RUN_ALLOW_INTERACTIVE_KEY=1`, sonst bricht es mit Exit-Code 64 ab. Vorher nahm es `OPENROUTER_API_KEY` mit einer bloßen Warnung. |
| RAG-Server aus dem Container erreichbar machen | Container-Läufe ohne Knowledge Base; `scripts/container-config.ts` schaltet beim Image-Bau MCP-Server ab, die nur auf dem Host laufen (stdio, `localhost`), und nimmt deren `mcp:`-Tools aus den Subagents | Entscheidung vom 30.10.: Die Knowledge Base läuft nur lokal. Ohne das Abschalten würde ein Subagent mit `mcp:kb/…` im Container gar nicht starten (getestet: die Kette bricht am Reviewer ab, mit der Anpassung läuft sie durch). |
| `pi update --models` vor `pi -p` | In `task.sh`, mit 60 s Timeout, Fehlschlag nicht fatal | Der Befehl lädt erst den Katalog von `pi.dev`, dann `/models/user` bei OpenRouter. Ohne Netz läuft Pi mit dem eingebauten Katalog weiter; die Routing-Vorgaben gelten trotzdem. |

## Was die Tests gefunden haben

Die End-to-End-Tests (echtes Pi gegen einen Mock; zuerst der Anthropic-, seit dem Update der OpenRouter-API) und die Probeläufe mit den Pilot-Repos haben vier Fehler aufgedeckt, die behoben sind:

- **`.txt` galt als Dokumentation.** Änderungen an `requirements.txt` hätten den Check nicht ausgelöst. Jetzt gelten nur `.md`, `.mdx`, `.markdown`, `.rst` und `.adoc` als reine Doku.
- **`canContinue` als Vorbedingung war falsch.** Im Print-Modus meldet Pi beim Settle `canContinue: false`, die Fortsetzung mit eigener Nachricht funktioniert trotzdem. Ohne den Fix wären die Reparaturrunden headless ausgefallen.
- **Docker unter Linux:** Mit Host-uid ≠ 1000 konnte der Agent im gemounteten Repo nicht schreiben, und das Gate-Log ließ sich nicht anlegen. Behoben durch Läufe als Host-uid und Logs über stderr.
- **pnpm-Store im Repo:** Der Probelauf mit pecker-api legte `.pnpm-store/` im gemounteten Repo an, weil `/workspace` ein eigenes Dateisystem ist. Das Image setzt den Store jetzt nach `/home/node/.pnpm-store`.

Mit OpenRouter bestätigt (11 Szenarien plus Container-Lauf):

- **Standard:** Die Hauptsession fragt `z-ai/glm-5.3` mit `reasoning.effort: high` an. `enabledModels` löst die IDs mit Schrägstrich auf: Ctrl+P schaltet genau `router/phased` und die drei OpenRouter-Modelle durch.
- **Routing-Vorgaben:** Jede Anfrage enthält `provider: { zdr: true, data_collection: "deny", require_parameters: true }`, in der Hauptsession, in allen vier Subagents und im Container.
- **compat wird zusammengeführt:** Pi mischt das `compat` aus `models.json` Feld für Feld in das jedes Modells. Die eingebauten Werte (`thinkingFormat: openrouter`, Session-Header) bleiben erhalten.
- **Sticky Routing:** Pi schickt pro Session eine feste `x-session-id`, auch über den Phasenwechsel des Routers hinweg.
- **Router:** Alle Anfragen gehen an GLM 5.3. Gemessen: `max`, `max`, nach der ersten Code-Änderung `high`. Ein neuer Prompt bleibt auf `high`, `/plan` geht zurück auf `max`.
- **Subagents (Stand 30.10.; seit 07.11. siehe oben):** `scout`, `planner`, `worker` und `reviewer` laufen auf DeepSeek V4 Flash (`low`), GLM 5.3 (`max`), GLM 5.3 (`high`) und DeepSeek V4 Pro (`high`). pi-subagents löst `openrouter/z-ai/glm-5.3:max` korrekt auf. Der Reviewer hat weder `edit` noch `write` noch `bash`. Im Worker blockiert das Safety-Gate `rm -rf`.

## Modelle

Stand 10.11. (alle drei 1M Kontext; Preise in USD je Million Tokens, Input / Output / Cache-Read, wie OpenRouter sie im November listet; der Pi-Katalog schätzt anders). Nach `/login openrouter` ersetzt Pi Limits und Preise durch die Werte deines Keys, und der Session-Report rechnet mit den Kosten, die OpenRouter meldet.

| Modell | ID | Preis (OpenRouter) | Denkstufen | Bilder | Rolle |
| --- | --- | --- | --- | --- | --- |
| DeepSeek V4.1 Flash (Stand 17.10.) | `deepseek/deepseek-v4.1-flash-1017` | ca. 0,15–0,30 / 0,60–1,20 / 0,003–0,03, je nach Provider | `off`, `low`, `high`, `max` | ja | Router (Standard), `scout` (`low`), `worker` (`high`), `delegate` |
| GLM 5.3 | `z-ai/glm-5.3` | ca. 1,40 / 4,40 / 0,26 | `low`, `high`, `max` (nicht abschaltbar) | nein | Router (`/plan`, Eskalation, `/hard`; immer `max`) als Standard, `planner` (`max`), `reviewer` (`max`), `oracle` |
| Kimi K3.1 Pro (optional, seit 08.11.) | `moonshotai/kimi-k3.1-pro` | ca. 2 / 10 / 0,20 | `off`, `low`, `high`, `max` | ja | Router nach `/strong kimi` (`max`), im Review per Lauf-Override; sonst nicht belegt |

Noch zu beobachten: DeepSeek V4.1 Pro, sobald es erscheint (kein Erscheinungsdatum). Nicht nötig: GLM 5.3 Prime (dasselbe Modell, schneller, doppelter Preis), GLM 5.3 Flash und ähnliche günstige Modelle (der Platz ist mit V4.1 Flash besetzt).

Weggefallen: DeepSeek V4 Pro 0813 (DeepSeek leitet V4 Pro seit dem 14.09. auf V4.1 Flash um) und V4 Flash 0731 (bei DeepSeek selbst abgeschaltet; bei Drittanbietern noch erhältlich und mit ca. 0,04 / 0,08 billiger, aber ohne Bilder). Maßgeblich ist, was OpenRouter mit ZDR tatsächlich routet (Test 12).

## OpenRouter-Routing

- **`agent/models.json`** wird wie `settings.json` nach `~/.pi/agent/` verlinkt und ins Image übernommen. Es setzt für alle OpenRouter-Modelle `openRouterRouting` mit `zdr: true`, `data_collection: "deny"` und `require_parameters: true`. Pi schickt das als `provider`-Feld.
- **Kimi K3.1 Pro übernimmt von Flash (seit 10.11.):** Moonshot verlangt in einer Tool-Schleife die vollständige Assistant-Nachricht samt Reasoning. Beim Modellwechsel verwirft Pi aber das Denken des anderen Modells (`transform-messages.js`, Zweig `isSameModel`). Für DeepSeek hängt Pi deshalb an jede wiederholte Assistant-Nachricht ein leeres `reasoning_content` (`requiresReasoningContentOnAssistantMessages`); der OpenRouter-Eintrag von Kimi im Pi-Katalog hat das Flag nicht, Pis eigener Moonshot-Eintrag schon. `modelOverrides` in `agent/models.json` setzt es für `moonshotai/kimi-k3.1-pro`. Das `compat` des Overrides wird Feld für Feld mit dem des Providers gemischt (`mergeCompat` in Pis `provider-composer.js`), die Routing-Vorgaben bleiben also erhalten; ein E2E-Szenario prüft beides. Für GLM 5.3 ist das Flag nicht gesetzt, weil es dafür keinen Beleg gibt; `scripts/probe-openrouter.ts` prüft beide Modelle live.
- **Bewusst ohne `order` und `sort`:** Beides umgeht das Sticky Routing. `only` und `ignore` kannst du gefahrlos ergänzen.
- **Quantisierung:** `quantizations` ist nicht gesetzt. Mit `["fp8", "bf16"]` schließt du stark quantisierte Endpunkte aus, riskierst aber, dass mit ZDR kein Provider übrig bleibt.
- **EU-Endpunkt** (`https://eu.openrouter.ai/api/v1` als `baseUrl`): nicht eingerichtet. Er braucht einen Business-Plan und bedient DeepSeek V4 Pro derzeit nicht.

## Quality Gate im Detail

- **Auslöser:** am Ende eines Laufs, der Code geändert hat. Die Änderung wird per `git status` und Inhalts-Hash gegen den Stand bei Prompt-Start erkannt, plus `edit`/`write`-Aufrufe. Das erfasst auch Änderungen per `bash` oder durch Subagents.
- **Konfiguration:** `.pi/gate.json` mit `command` (Pflicht), `maxRepairRounds` (Standard 2) und `timeoutSeconds` (Standard 600).
- **Nur in vertrauten Projekten:** Die Datei enthält einen Befehl aus dem Repo.
- **Abbruch:** nach `maxRepairRounds`, wenn eine Runde nichts geändert hat, oder bei Exit-Code 127 (Befehl fehlt, also Umgebungsproblem). Du bekommst dann einen Hinweis, headless auf stderr.
- **Protokoll:** Jedes Ergebnis landet als Eintrag `quality-gate` im Session-Log.

## Safety Gate im Detail

- **bash:** blockiert `rm` mit `-r` und `-f` (in jeder Schreibweise) und rekursives `rm` auf `/`, `~` oder `..`. Ebenso `git push` (auch `git -C … push`), `git reset --hard`, `git clean -f…` und Downloads, die in eine Shell oder einen Interpreter gepipt werden (`curl … | sh`, `sh <(curl …)`, `bash -c "$(curl …)"`). Das gilt auch hinter `sudo`, `env`, `xargs`, `timeout`, `bash -c` und `find -exec`.
- **Schreibzugriffe:** `edit`, `write` und bash-Umleitungen, `tee`, `cp`, `mv`, `sed -i` usw. auf geschützte Pfade sind gesperrt:
  - `.env`, `.env.*` (außer `.env.example`, `.sample`, `.template`, `.dist`)
  - alles unter `.git/`, `.ssh/`, `.aws/`, `.gnupg/`
  - `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `.npmrc`, `.pypirc`, `.netrc`, `auth.json`, `credentials*`, `secrets.*`
- **Nur Schreiben:** Lesen bleibt erlaubt, wie im Plan. Willst du auch das Lesen von `.env` sperren, ist das eine Zeile.
- **Bewusst streng:** Auch ein bloßes Zitat wie `echo "rm -rf x"` wird blockiert. Du kannst jeden Befehl selbst mit `!befehl` ausführen; das Gate prüft nur Tool-Aufrufe des Modells.

## pi-subagents

**Update 07.11.: 0.87.0.** Gegenüber 0.83.1 geprüft: weiterhin keine `scripts` in `package.json`, gleiche Laufzeit-Abhängigkeiten in gleichen Versionen, keine neuen fest eingebauten URLs, keine neuen gestarteten Programme (Vergleich der Bundles). Veröffentlicht mit npm-Provenance (SLSA). Gründe für das Update: 0.84.0 schließt eine Lücke, durch die Workflow-Skripte (die `/review-chain` nutzt) aus ihrer Sandbox auf den Pi-Prozess zugreifen konnten; 0.85.0 macht jeden Kindstart als `subagent_launch`-Tool-Aufruf für Gates sichtbar; 0.87.0 lässt ein Modell `provider/id` nur noch beim genannten Provider laufen. 0.87.0 ist vom 07.11. und damit sehr frisch; die E2E-Tests laufen damit grün.

Geprüft am 30.10. wurde Version 0.83.1 (npm, Quelle `github.com/nicobailon/pi-subagents`, veröffentlicht am 28.10.2026 per GitHub Actions). Kein vollständiges Audit des 4-MB-Bundles, sondern eine gezielte Prüfung:

- **Keine Install-Hooks:** keine `scripts` in `package.json`. `install.mjs` läuft nur bei `npx pi-subagents`, nicht bei `pi install`.
- **Netzwerk:** keine fest eingebauten Endpunkte außer GitHub-Links. Ein Gist wird nur mit `share: true` angelegt (über `gh gist create`).
- **Kindprozesse:**
  - immer: `git` (Worktrees, Diffs), `ps` und `npm root -g`
  - nur wenn diese Profile gewählt werden: externe CLIs (`claude`, `codex`, `cursor-agent`). Sie sind deaktiviert.
- **Peer-Dependencies:** sauber deklariert; Laufzeit-Abhängigkeiten sind gepinnt.

Deaktiviert in `settings.json`: `researcher` und `evidence-auditor` (bräuchten `pi-web-access`) sowie alle sechs Profile für externe CLIs. `delegate` läuft auf DeepSeek V4.1 Flash (`subagents.defaultModel`), `oracle` auf GLM 5.3 (`agentOverrides`), weil Kinder den virtuellen Router nicht nutzen können.

Update-Weg: Version in `agent/settings.json` anheben, `npm run e2e` laufen lassen, dann committen.

## pi-project-profile

Bewertung von Version 1.4.0 aus dem Quellcode; der praktische Test in den Pilot-Repos steht noch aus (Runbook M2, Schritt 6).

**Stärker als unser Gate:**

- Erkennt Befehle selbst.
- Merkt sich, was schon vor der Änderung rot war, und lastet das dem Agenten nicht an.
- Prüft den Diff auf übersprungene Tests, Suppressions, gelockerte Configs und Secrets.
- Lässt nur verwandte Tests laufen.
- Liefert verschachtelte `AGENTS.md` bei Bedarf nach.

**Schwächer für unseren Plan:**

- Keine einzelne Check-Datei im Repo. Überschreibungen liegen unter `~/.pi/agent/project-profile/` und sind nicht versioniert.
- Tests und Build laufen erst nach einer einmaligen Freigabe je Repo.
- Standard sind 3 Reparaturrunden statt 2 (einstellbar).
- Es ist ein weiteres Fremd-Package im Prozess.

**Empfehlung:** Unser Gate als Standard behalten. pi-project-profile übernehmen, falls der Vergleich zeigt, dass die Baseline (vorher schon rot) oder der Diff-Review in deinen Repos klar mehr bringt. Nicht beide gleichzeitig aktiv lassen, sonst laufen die Checks doppelt.

## Was nicht getestet werden konnte

- **Echte Modelle, Pilot-Repos und die Knowledge Base:** brauchen deine Schlüssel und Repos. Die Mock-Tests prüfen die Verdrahtung, nicht die Qualität der Antworten.
- **Was OpenRouter aus den Vorgaben macht:** ob mit ZDR und `require_parameters` für alle drei Modelle Provider übrig bleiben, welche das sind (Test 12) und ob der Cache trifft (Test 13). Getestet ist nur, dass Pi die Vorgaben und die Session-ID schickt.
- **Erfolgreiches `pi update --models`:** braucht `pi.dev`, das hier gesperrt war. Getestet ist der Fehlerfall: Der Lauf geht mit dem eingebauten Katalog weiter.
- **Der `apt-get`-Schritt im `Dockerfile.pi`:** Die Debian-Mirrors waren aus der Build-Umgebung gesperrt. Getestet wurde eine Variante auf `node:24-bookworm` (git und python3 vorinstalliert) mit identischen übrigen Schritten. Beim ersten Build auf deinem Rechner läuft der apt-Schritt zum ersten Mal. (Am 10.11. dasselbe Bild; siehe das Update oben.)
- **macOS-Besonderheiten:** Docker Desktop und der Schlüsselbund. Die Skripte sind auf Bash 3.2 ausgelegt; seit 10.11. laufen ihre Tests auch unter Bash 3.2.57, allerdings als Linux-Build, nicht auf einem Mac.
- **Interaktive TUI:** Fußzeile, `/subagents-fleet` und Benachrichtigungen. Getestet wurden Print-, JSON- und RPC-Modus.
