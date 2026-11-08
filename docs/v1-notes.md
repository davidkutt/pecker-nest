# V1 – Abweichungen vom Plan und Befunde

Stand 07.11.2026 (Strategie A), Pi 1.5.0 (`@earendil-works/pi-coding-agent`; das alte Paket `@mariozechner/pi-coding-agent` ist abgekündigt). Der Teil vom 30.10. (Update „GLM 5.3 & DeepSeek über OpenRouter“) steht unten; was das Update vom 07.11. daran ändert, steht im ersten Abschnitt. Grundlage sind die Docs, der Quellcode und die Typdeklarationen aus den npm-Paketen. pi.dev selbst war aus der Build-Umgebung nicht erreichbar.

## Update 07.11.2026: Strategie A

Entschieden im Planungschat: DeepSeek V4.1 Flash arbeitet, GLM 5.3 springt ein (Strategie A). Getestet wird an echter Arbeit (undertext M1, danach pecker-grove), nicht an den Pilot-Repos; Claude Code beobachtet und schreibt nach jeder Session eine Übergabe.

**Warum die Modelle wechseln:**
- DeepSeek hat am 10.09. V4.1 Flash veröffentlicht und leitet seit dem 14.09. Anfragen an V4 Pro auf V4.1 Flash um. Der bisherige Reviewer (V4 Pro 0813) fällt weg. V4.1 Flash nimmt Bilder an, GLM 5.3 nicht.
- nest nutzt den Stand vom 17.10. (`deepseek/deepseek-v4.1-flash-1017`, entschieden am 08.11.). Bei OpenRouter ist `deepseek/deepseek-v4.1-flash` ohne Datum der Stand vom 10.09., kein Alias auf den neuesten. Laut DeepSeek ist 1017 bei Coding und Agent-Aufgaben besser und schreibt kürzere Antworten, zum selben Preis. Dafür bedienen ihn bei OpenRouter weniger Provider (12 statt rund 38), deshalb nach dem Wechsel prüfen, ob mit ZDR noch einer übrig bleibt.
- GLM 5.3 kostet bei OpenRouter etwa 1,40 / 4,40 / 0,26 USD (Input / Output / Cache-Read je Million Tokens), nicht 0,079 / 1,40 / 0,078 wie im Pi-Katalog 1.4.0. V4.1 Flash liegt je nach Provider bei etwa 0,15–0,30 / 0,60–1,20 / 0,003–0,03. Bei Coding-Agents dominiert der Cache-Read, deshalb ist eine lange Session auf Flash grob 10- bis 40-mal billiger.

**Was sich geändert hat:**

| Bereich | Vorher (30.10.) | Jetzt (07.11.) |
| --- | --- | --- |
| Pi / pi-subagents | 1.4.0 / 0.83.1 | 1.5.0 / 0.87.0 (Prüfung unten) |
| Flash-Modell | `deepseek/deepseek-v4-flash-0731` | `deepseek/deepseek-v4.1-flash-1017` |
| Standardmodell | `openrouter/z-ai/glm-5.3` (`high`) | `router/escalate` |
| Router | `router/phased`: GLM plant auf `max`, baut auf `high` | `router/escalate`: Flash `high` für jeden Prompt; GLM `max` für `/plan`; GLM `high`, wenn das Quality Gate in Reparaturrunde 2 noch rot ist, bei Schleifen (dreimal derselbe Tool-Aufruf, drei fehlgeschlagene Edits an einer Datei, fünf fehlgeschlagene Tool-Aufrufe in Folge) und mit `/hard` bis `/flash`. Ein Gespräch mit Bildern bleibt auf Flash. |
| Rollen | scout V4 Flash `low`, planner GLM `max`, worker GLM `high`, reviewer V4 Pro `high` | scout V4.1 Flash `low`, planner GLM `max`, worker V4.1 Flash `high`, reviewer GLM `high` |
| Builtins | `oracle`, `delegate` auf GLM | `delegate` auf Flash (`subagents.defaultModel`), `oracle` auf GLM |
| Kompaktierung | bei ~1M Kontext (Standard `reserveTokens` 16k) | bei ~250k: `compaction.modelOverrides` mit `reserveTokens: 800000` für Router, Flash und GLM. Andere Modelle behalten den Standard. |
| Safety Gate | feste Regeln | zusätzlich: `.pi/` ist für den Agenten tabu, ebenso dieses Repo und Pis Agent-Verzeichnis; `.pi/protect.json` je Repo (Pfade nicht schreiben, Pfade nicht lesen, Befehle nicht ausführen; Zeilen mit geschützten Pfaden werden aus grep-, find-, ls- und bash-Ausgaben entfernt). Eine kaputte `protect.json` sperrt alle Schreibzugriffe und Befehle. |
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
| `-e OPENROUTER_API_KEY` (Container-Key) | `pi-run.sh` liest `PI_RUN_OPENROUTER_API_KEY` und gibt ihn als `OPENROUTER_API_KEY` in den Container | Dein interaktiver Key (ohne Limit) landet so nicht versehentlich im Container. Fehlt die Variable, nimmt das Skript `OPENROUTER_API_KEY` und warnt. |
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

Stand 07.11. (beide 1M Kontext; Preise in USD je Million Tokens, Input / Output / Cache-Read, wie OpenRouter sie im November listet; der Pi-Katalog schätzt anders). Nach `/login openrouter` ersetzt Pi Limits und Preise durch die Werte deines Keys, und der Session-Report rechnet mit den Kosten, die OpenRouter meldet.

| Modell | ID | Preis (OpenRouter) | Denkstufen | Bilder | Rolle |
| --- | --- | --- | --- | --- | --- |
| DeepSeek V4.1 Flash (Stand 17.10.) | `deepseek/deepseek-v4.1-flash-1017` | ca. 0,15–0,30 / 0,60–1,20 / 0,003–0,03, je nach Provider | `off`, `low`, `high`, `max` | ja | Router (Standard), `scout` (`low`), `worker` (`high`), `delegate` |
| GLM 5.3 | `z-ai/glm-5.3` | ca. 1,40 / 4,40 / 0,26 | `low`, `high`, `max` (nicht abschaltbar) | nein | Router (`/plan`, Eskalation, `/hard`), `planner` (`max`), `reviewer` (`high`), `oracle` |

Neue Modelle zum Beobachten (Stand 08.11.): Kimi K3.1 Pro (`moonshotai/kimi-k3.1-pro`, 2 / 10 / 0,20, liest Bilder) als möglicher Ersatz für GLM bei Eskalation oder Review, an zwei, drei M1-Schritten gegen GLM testen; DeepSeek V4.1 Pro, sobald es erscheint. Nicht nötig: GLM 5.3 Prime (dasselbe Modell, schneller, doppelter Preis), GLM 5.3 Flash und ähnliche günstige Modelle (der Platz ist mit V4.1 Flash besetzt).

Weggefallen: DeepSeek V4 Pro 0813 (DeepSeek leitet V4 Pro seit dem 14.09. auf V4.1 Flash um) und V4 Flash 0731 (bei DeepSeek selbst abgeschaltet; bei Drittanbietern noch erhältlich und mit ca. 0,04 / 0,08 billiger, aber ohne Bilder). Maßgeblich ist, was OpenRouter mit ZDR tatsächlich routet (Test 12).

## OpenRouter-Routing

- **`agent/models.json`** wird wie `settings.json` nach `~/.pi/agent/` verlinkt und ins Image übernommen. Es setzt für alle OpenRouter-Modelle `openRouterRouting` mit `zdr: true`, `data_collection: "deny"` und `require_parameters: true`. Pi schickt das als `provider`-Feld.
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
- **Der `apt-get`-Schritt im `Dockerfile.pi`:** Die Debian-Mirrors waren aus der Build-Umgebung gesperrt. Getestet wurde eine Variante auf `node:24-bookworm` (git und python3 vorinstalliert) mit identischen übrigen Schritten. Beim ersten Build auf deinem Rechner läuft der apt-Schritt zum ersten Mal.
- **macOS-Besonderheiten:** Docker Desktop und Bash 3.2. Die Skripte sind auf Bash 3.2 ausgelegt, liefen aber nur unter Linux.
- **Interaktive TUI:** Fußzeile, `/subagents-fleet` und Benachrichtigungen. Getestet wurden Print-, JSON- und RPC-Modus.
