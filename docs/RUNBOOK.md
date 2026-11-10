# Runbook nest V1

Begleitet den „Pi V1 – Konfigurationsplan“ vom 28.10.2026, das Update „GLM 5.3 & DeepSeek über OpenRouter“ vom 30.10.2026 und Strategie A vom 07.11.2026 (DeepSeek V4.1 Flash arbeitet, GLM 5.3 springt ein; Details in [v1-notes.md](v1-notes.md#update-07112026-strategie-a)). Stand ist die Setup-Härtung vom 10.11.2026 ([v1-notes.md](v1-notes.md#update-10112026-setup-härtung-und-modell-passung)). `pi-config` aus dem Plan ist dieses Repo (`pecker-nest`). Die Meilensteine und die Nummern der Abnahmetests (1–13) entsprechen Plan und Update. Noch nichts eingerichtet? Dann zuerst der [Setup-Guide](SETUP.md).

**Legende:** ✅ erledigt und getestet · 👤 dein Teil

## Stand

Alles, was ohne deine Rechner, Repos, Schlüssel und Entscheidungen geht, ist gebaut. Die Verdrahtung ist gegen echtes Pi 1.5.0 getestet. Statt OpenRouter antwortete dabei ein lokaler Mock mit geskripteten Tool-Aufrufen (`npm run e2e`, 23 Szenarien), dazu kommt ein Headless-Lauf im Container (`npm run e2e:docker`). Getestet ist also das Verhalten von Pi und der Config: welche Modelle mit welcher Denkstufe angefragt werden und dass die Routing-Vorgaben in jeder Anfrage stehen. Nicht getestet ist das Urteil der echten Modelle und was OpenRouter mit den Vorgaben macht. Dafür sind die Abnahmetests unten da und die [Live-Probe](#live-probe-gegen-openrouter--5-minuten-ein-paar-cent), die du selbst startest.

| Meilenstein | ✅ Gebaut und getestet | 👤 Dein Teil |
| --- | --- | --- |
| M0 Fundament | Package, `settings.json`, `models.json` (ZDR-Routing), `link.sh`, Modell-IDs im Pi-Katalog bestätigt | OpenRouter-Konto (ZDR, Container-Key), klonen, verlinken, `/login openrouter`, Test 1 |
| M1 Kontext | `APPEND_SYSTEM.md`, AGENTS-Vorlagen, `/plan` `/implement` `/review`, Skills; Pilot-Repos `pecker-api` und `pecker-ml` mit Gerüst und ausgefülltem `AGENTS.md` auf `main` | Test 2 in undertext (M7); die Pilot-Repos bleiben nur noch E2E-Material |
| M2 Gates | Safety-Gate, Quality-Gate (≤ 2 Runden), `/plan` darf nur `PLAN.md` schreiben; `.pi/gate.json` in beiden Pilot-Repos, Check grün und im Container geprüft | `/trust`, Tests 3–5 in undertext (Safety-Tests auf einem Wegwerf-Branch); Vergleich mit pi-project-profile zurückgestellt |
| M3 RAG | Skill `best-practices`, leere `mcp.json`; Container schaltet lokale MCP-Server samt Subagent-Tools ab | Server eintragen, Exposure setzen, Abschnitt „Knowledge base first“ in `APPEND_SYSTEM.md` wieder einfügen, Tests 6–7 |
| M4 Subagents | pi-subagents 0.87.0 geprüft und gepinnt, scout/worker auf V4.1 Flash, planner/reviewer auf GLM 5.3, review-chain, Safety-Gate in Subagents | Test 8 am ersten echten M1-Feature |
| M5 Routing | `router/escalate` ist Standard: Flash für jeden Prompt, das starke Modell für `/plan`, rotes Gate in Runde 2, Schleifen und `/hard`; `/strong glm\|kimi` wählt es | Test 9 in echter Arbeit, Schwellen anhand der Session-Reports prüfen, Modellvergleich GLM gegen Kimi an 2–3 M1-Schritten |
| M7 Dogfooding | Checkpoints, `.pi/protect.json`, Session-Report, `/nest-supervise` und `/nest-handoff`, Vorlagen für undertext | undertext M1 mit nest bauen, nach jeder Session eine Übergabe |
| M6 Headless | `Dockerfile.pi`, `build-image.sh` (Image mit Commit-Label), `pi-run.sh` (eigener Container-Key aus dem Schlüsselbund, startet kein veraltetes Image), `task.sh` (Setup, `pi update --models`, Pi, Gate-Nachprüfung) | Container-Key in den Schlüsselbund, Image bauen, Tests 10–11 |
| Neu | – | Tests 12 (Provider-Routing) und 13 (Caching) |

## Voraussetzungen

```bash
pi --version          # mindestens 1.5.0, sonst: pi update
node --version        # mindestens 22.18 (nur für npm run check / e2e)
docker --version      # für M6
```

Sobald das Repo geklont und verlinkt ist (M0), prüft ein Befehl alles auf einmal, auch Login und Modelle: `~/dev/pecker-nest/scripts/doctor.sh`. Docker-Daemon und Image prüft er nur mit `--docker` (für die Headless-Läufe aus M6).

Alle Befehle in diesem Runbook laufen in bash, zsh und fish gleich. Wo sich fish unterscheidet, steht zuerst der Befehl für bash/zsh und danach der für fish. Eine Variable für einen einzelnen Befehl ist deshalb immer als `env NAME=wert befehl` geschrieben; das versteht jede der drei Shells.

## M0 – Fundament (👤 ca. 20 Minuten)

1. **OpenRouter-Konto vorbereiten** (entschieden am 30.10.: ZDR global, Container-Budget 20 $):
   - Unter Settings → Privacy *Zero Data Retention* für „alle anderen Modelle“ einschalten. Dann zeigt OpenRouter deinem Key nur noch ZDR-Endpunkte, und Pi übernimmt das in seine Modellliste.
   - Unter Keys einen **zweiten Key nur für den Container** anlegen, mit Kreditlimit 20 $. Er kommt in M6 in den macOS-Schlüsselbund, nicht in eine Shell-Konfiguration.

2. Repo an genau diese Stelle klonen. `agent/settings.json` lädt das Package von `~/dev/pecker-nest`:

   ```bash
   mkdir -p ~/dev
   git clone -b main https://github.com/davidkutt/pecker-nest ~/dev/pecker-nest
   ```

3. Agent-Dateien verlinken. Das verlinkt auch `models.json` mit den Routing-Vorgaben (`zdr`, `data_collection: deny`, `require_parameters`):

   ```bash
   ~/dev/pecker-nest/scripts/link.sh
   ```

   Vorhandene Dateien in `~/.pi/agent` werden nicht gelöscht, sondern als `*.bak.<zeitstempel>` beiseitegelegt. Schau in die Backups deiner alten `settings.json` und `models.json`. Übernimm, was du behalten willst, in die Dateien unter `~/dev/pecker-nest/agent/`. `auth.json` und Sessions bleiben unberührt.

4. `pi` starten. Beim ersten Start installiert Pi `pi-subagents@0.87.0` (ein paar Sekunden). Dann anmelden:

   ```text
   /login openrouter
   ```

   Das reicht; einen Key zu exportieren ist nicht nötig. Nach dem Login lädt Pi die Modellliste deines Keys neu.

5. **Test 1:**

   ```bash
   pi list
   # User packages:
   #   ~/dev/pecker-nest
   #   npm:pi-subagents@0.87.0
   ```

   In Pi `/model` öffnen. Ausgewählt ist `router/escalate`; unter `openrouter` stehen `deepseek/deepseek-v4.1-flash-1017`, `z-ai/glm-5.3` und `moonshotai/kimi-k3.1-pro`. Mit Ctrl+P schaltest du genau diese vier durch; die Muster in `enabledModels` mit den Schrägstrichen in den IDs sind getestet. Weitere Modelle (z. B. ein Claude- oder GPT-Modell als Reserve) holst du mit `/model openrouter/<id>`.

   Kimi K3.1 Pro braucht der Router nur nach `/strong kimi` (M5). Fehlt es, läuft alles wie bisher auf GLM; fehlt GLM ebenfalls, bleibt der Router auf Flash und sagt es.

   Fehlt eines der beiden anderen Modelle, filtert es dein Konto heraus, meist wegen ZDR. Am ehesten trifft das `deepseek/deepseek-v4.1-flash-1017`: Diesen Stand bedienen weniger Provider als den vom September. Notfalls in `extensions/lib/router-logic.ts`, `agent/settings.json` und den Agenten `scout`/`worker` auf `deepseek/deepseek-v4.1-flash` zurückgehen. Dann auf der Modellseite bei OpenRouter prüfen, welche Provider ZDR anbieten (siehe „Wenn Anfragen scheitern“ unten).

   Abweichung vom Plan: `pi list` zeigt zwei Einträge, nicht einen. pi-subagents ist schon gepinnt.

Hinweis: `settings.json` ist ein Symlink ins Repo. Wenn du in `/model` umschaltest, schreibt Pi das Modell dorthin, und `git status` zeigt die Änderung. Committe sie, wenn sie der neue Standard sein soll, sonst `git checkout agent/settings.json`.

## M1 – Kontext und Befehle (👤 ca. 15 Minuten)

Die Pilot-Repos `davidkutt/pecker-api` (TypeScript) und `davidkutt/pecker-ml` (Python) haben auf `main` ein Minimal-Gerüst: Toolchain, ein kleines Modul mit Tests, ein ausgefülltes `AGENTS.md` und `.pi/gate.json`. Der Check ist in beiden grün, lokal und im Container geprüft.

| | pecker-api | pecker-ml |
| --- | --- | --- |
| Toolchain | Node ≥ 22.18, TypeScript 6.0 (strict), pnpm, ESLint, Vitest | Python ≥ 3.11, uv, ruff, pyright (strict), pytest |
| Beispielmodul | `src/slug.ts` (`slugify`) | `src/pecker_ml/stats.py` (`mean`, `zscores`) |
| Gate (`.pi/gate.json`) | `pnpm run check` | `uv run ruff check . && uv run pyright && uv run pytest -q` |

TypeScript bleibt bewusst auf 6.0: typescript-eslint unterstützt TypeScript 7 noch nicht.

1. Klonen und einmal installieren:

   ```bash
   git clone https://github.com/davidkutt/pecker-api ~/dev/pecker-api
   git clone https://github.com/davidkutt/pecker-ml ~/dev/pecker-ml
   cd ~/dev/pecker-api && pnpm install && pnpm run check
   cd ~/dev/pecker-ml && uv sync && uv run ruff check . && uv run pyright && uv run pytest -q
   ```

2. `AGENTS.md` in beiden Repos gegenlesen. Die Abschnitte „Project“ und „Architecture rules“ beschreiben den heutigen Stand (Gerüst, noch kein HTTP- bzw. ML-Stack). Passe sie an, sobald die Repos wachsen.

3. **Test 2:** Im Repo `pi` starten, `/plan <kleines Feature>`, z. B. in pecker-api „/plan slugify soll eine maximale Länge bekommen“. Danach zeigt `git status` nur `PLAN.md`. Das Safety-Gate blockiert während `/plan` jeden anderen Schreibzugriff über `edit`/`write`.

Weitere Befehle: `/implement 1` (Schritt 1 aus `PLAN.md`, Tests zuerst) und `/review [base-ref]` (nur Befunde, keine Änderungen).

## M2 – Sicherheit und Quality Gate (👤 ca. 1 Stunde plus Vergleich)

1. `.pi/gate.json` liegt schon in beiden Repos (siehe Tabelle oben).

2. Jedem Repo einmal vertrauen: in Pi `/trust`. Das Gate läuft nur in vertrauten Projekten, weil `gate.json` einen Befehl aus dem Repo ausführt. Ohne Vertrauen erscheint der Hinweis „gate.json ignored: this project is not trusted“.

3. **Test 3:** „Lösch das Build-Verzeichnis mit `rm -rf build` und mach dann `git push`.“ Erwartung: blockiert, mit Begründung „Blocked by safety-gate …“.

4. **Test 4:** „Setz in `.env` DEBUG=1.“ Erwartung: Edit blockiert.

5. **Test 5:** Einen Test absichtlich rot machen und „Mach die Checks grün“ sagen. Erwartung: Nach dem Lauf startet das Gate. Ein roter Check geht als `[quality-gate] … Repair round 1 of 2` zurück an den Agenten. Spätestens nach zwei Runden ist er grün oder du bekommst einen Hinweis. Prüfe mit `git diff`, dass kein Test gelöscht oder übersprungen wurde.

   **Test 5b, abgeschwächte Tests:** Sag „Überspring den Test `<name>` mit `.skip`“ (Python: `@pytest.mark.skip`). Erwartung: Der Check selbst ist grün, das Gate trotzdem rot. Der Agent bekommt `[quality-gate] … passed, but the weakened-test check has 1 finding. Repair round 1 of 2.` mit Datei und Zeile und soll die Änderung zurücknehmen oder begründen. Begründet er nur, endet der Lauf, und du bekommst die Liste (in der TUI als Nachricht, headless auf stderr). Das Gate nimmt selbst nichts zurück.

   - `/gate` führt den Check sofort aus und zeigt die Ausgabe.
   - `/gate off` / `/gate on` schaltet das Gate für die Session ab und an.
   - Exit-Code 127 (Befehl nicht gefunden) gilt als Umgebungsproblem und löst keine Reparaturrunde aus.

6. **Vergleich mit pi-project-profile (1–2 Stunden):** In jedem Pilot-Repo das fertige Package ausprobieren, ohne unser Gate:

   ```bash
   env PI_NEST_GATE=off pi -e npm:@lenard9191/pi-project-profile@1.4.0
   ```

   Darin `/profile tests allow` setzen, Test 5 wiederholen und `/profile` ansehen. Was ich aus dem Quellcode schon bewertet habe, steht in [v1-notes.md](v1-notes.md#pi-project-profile). Entscheidung:

   - **Unser Gate bleibt:** nichts zu tun.
   - **pi-project-profile übernehmen:** `"npm:@lenard9191/pi-project-profile@1.4.0"` zu `packages` in `agent/settings.json` hinzufügen, `"./extensions/quality-gate.ts"` aus `pi.extensions` in `package.json` entfernen und `maxRepairRounds: 2` per `/profile config` setzen. Oder sag mir Bescheid, dann baue ich es um.

## M3 – RAG (👤 ca. 30 Minuten)

Entschieden: Die Knowledge Base läuft nur lokal und ist per MCP erreichbar; Auto-Retrieval gibt es in V1 nicht. Das Modell ruft das Such-Tool selbst auf, angeleitet vom Skill `best-practices`.

1. Server eintragen. Weil `mcp.json` verlinkt ist, landet der Eintrag direkt in `agent/mcp.json` im Repo. Nimm die Variante, über die dein Server heute erreichbar ist:

   ```bash
   # stdio (Pi startet den Server selbst):
   pi mcp add kb --description "Projektwissen: Konventionen, Architekturentscheidungen, Best Practices" -- <befehl> <argumente>

   # HTTP auf localhost (der Server läuft schon):
   pi mcp add kb --url http://localhost:<port>/mcp --description "Projektwissen: …"
   #   mit Token zusätzlich: --bearer-token-env-var KB_TOKEN
   ```

2. Toolnamen ansehen: `pi mcp list`. Dann in `agent/mcp.json` beim Server `kb` ergänzen (Namen anpassen):

   ```json
   "exposure": "deferred",
   "toolExposure": {
     "<such-tool>": "direct",
     "<schreib-oder-admin-muster, z. B. delete_*>": "hidden"
   }
   ```

3. Damit auch Planner und Reviewer die Knowledge Base nutzen, in `agent/agents/planner.md` und `agent/agents/reviewer.md` bei `tools:` `mcp:kb/<such-tool>` anhängen.

   Wichtig: Ein Subagent mit `mcp:kb/…` startet nicht, solange der KB-Server nicht erreichbar ist (getestet), auf dem Host also nur bei laufendem Server. Im Container ist das abgefangen, siehe M6.

4. Die Regel für das Modell wieder eintragen. Solange in `agent/mcp.json` kein Server steht, verweist `agent/APPEND_SYSTEM.md` bewusst nicht auf die Knowledge Base (seit 10.11.): Sonst trüge jede Session eine Anweisung zu Tools, die es nicht gibt. Sobald `kb` eingetragen ist, diesen Abschnitt in `agent/APPEND_SYSTEM.md` vor „## Safety“ einfügen:

   ```markdown
   ## Knowledge base first

   - When a question touches project conventions, architecture decisions, APIs or best practices, search the knowledge base (`mcp__kb__*` tools) before answering from memory, and name the source you used.
   - If the knowledge base is unavailable, say so once and continue with what the repository shows.
   ```

   Im Container ist die Knowledge Base aus (M6); der zweite Punkt deckt das ab. Der Skill `best-practices` enthält dieselbe Anleitung ausführlicher und lädt, wenn er gebraucht wird.

5. `pi mcp list` ist grün. Dann `/reload` in laufenden Sessions.
6. **Test 6:** Nach einer Projektkonvention fragen. Der Aufruf von `mcp__kb__…` ist sichtbar, die Antwort nennt die Quelle (Skill `best-practices`).
7. **Test 7:** RAG-Server stoppen und eine normale Aufgabe geben. Pi arbeitet weiter, `/mcp` zeigt den Fehler.
8. Committen.

## M4 – Subagents und Review (👤 ca. 30 Minuten)

Schon erledigt: pi-subagents ist geprüft und auf 0.87.0 gepinnt (Befund in [v1-notes.md](v1-notes.md#pi-subagents)). Die vier Rollen liegen in `agent/agents/`. Nicht genutzte Builtins (externe CLIs, Web-Recherche) sind deaktiviert.

1. Am ersten echten Feature in undertext M1 (siehe M7), oder auf einem Branch einen kleinen Bug einbauen und committen.
2. **Test 8**, in der TUI:

   ```text
   /prompt-workflow review-chain <Aufgabe, z. B. "Füge X hinzu">
   ```

   Die Kette läuft `scout` (DeepSeek V4.1 Flash, `low`) → `planner` (GLM 5.3, `max`) → `worker` (DeepSeek V4.1 Flash, `high`) → `reviewer` (GLM 5.3, `max`). Prüfe:

   - Jeder Agent auf seinem Modell: `/subagents-fleet` öffnen, den Transcript des Laufs ansehen oder den Session-Report (Abschnitt „By agent“).
   - Der GLM-Reviewer findet Fehler im Flash-Code und ändert keinen Code. Er hat keine Schreib-Tools, nicht einmal `bash`.

   Headless (`pi -p`) funktioniert `/prompt-workflow` nicht (Fehler „ctx is stale“ aus pi-subagents). Dort `/review-chain <Aufgabe>` nehmen. Dann startet das Modell dieselbe Kette als Workflow-Skript.

3. Bei Problemen: `/subagents-doctor`.

## M5 – Modell-Routing (👤 in echter Arbeit)

`router/escalate` ist das Standardmodell. Er wählt je Anfrage das Modell:

| Situation | Modell |
| --- | --- |
| Jeder Prompt, den du tippst | DeepSeek V4.1 Flash, `high` |
| `/plan …` samt seinen Tool-Aufrufen | GLM 5.3, `max` |
| Quality Gate in Reparaturrunde 2 noch rot | GLM 5.3, `max`, bis zu deinem nächsten Prompt |
| Dreimal derselbe Tool-Aufruf, drei fehlgeschlagene Edits an einer Datei oder fünf fehlgeschlagene Tool-Aufrufe in Folge | GLM 5.3, `max`, bis zu deinem nächsten Prompt |
| `/hard` | das starke Modell, `max`, für alle Prompts bis `/flash` |
| Bilder im Gespräch, und das starke Modell liest keine Bilder | immer Flash (GLM 5.3 liest keine Bilder, Kimi K3.1 Pro schon) |
| Das starke Modell fehlt in deiner Modellliste | GLM 5.3, sonst Flash, mit einem Hinweis |
| Das starke Modell scheitert bei der Anfrage: OpenRouter meldet „No endpoints found“ (404), oder der Provider lehnt die Anfrage ab (400) | GLM 5.3, sonst Flash, mit einem Hinweis; der Lauf geht weiter. Das Modell bleibt übersprungen, bis du Pi neu startest oder es mit `/strong <modell>` wieder wählst |

Das starke Modell läuft seit dem 10.11. immer auf `max`, Flash bleibt auf `high`. Eine Eskalation heißt, dass Flash schon hängt; dort am Nachdenken zu sparen wäre die falsche Stelle (Begründung in [v1-notes.md](v1-notes.md#update-10112026-setup-härtung-und-modell-passung)).

„Das starke Modell“ ist GLM 5.3, bis du mit `/strong kimi` auf Kimi K3.1 Pro umschaltest:

| Befehl | Wirkung |
| --- | --- |
| `/strong` | zeigt die aktuelle Wahl |
| `/strong kimi` | der Router holt ab dem nächsten Prompt Kimi K3.1 Pro für `/plan`, Eskalationen und `/hard` |
| `/strong glm` | zurück zum Standard GLM 5.3 |

`/strong` schaltet nur um und sendet keine Nachricht, wie `/hard`; den Prompt tippst du danach. Die Wahl steht im Router-State, folgt also `/tree` und übersteht Neustarts. Flash bleibt in jedem Fall das Arbeitsmodell, und der Reviewer bleibt auf GLM (für den Review-Vergleich siehe den Lauf-Override unten).

Steuernachrichten und Follow-ups behalten die aktuelle Stufe; Wiederholungen nach Rate-Limits und Überlast bleiben auf dem Modell, das scheiterte. Jeder Wechsel kostet einen Prompt-Cache-Miss.

1. **Test 9:** Eine Aufgabe von `/plan` bis Umsetzung. Die Fußzeile zeigt erst `escalate • high → z-ai/glm-5.3 • max`, beim nächsten Prompt `… → deepseek/deepseek-v4.1-flash-1017 • high`. Jeder Wechsel erscheint als Hinweis `router: …`.
2. Nach ein paar Sessions die Session-Reports ansehen (Abschnitt „Router“ und „Tools“): Wie oft musste GLM einspringen, und warum? Springt GLM zu oft ein, ist Flash für die Aufgabe zu schwach (dann `/hard` für solche Aufgaben). Springt GLM nie ein, obwohl Flash hängt, sind die Schwellen zu hoch. Die Schwellen stehen in `extensions/lib/router-logic.ts`.
3. Ohne Router arbeiten: `/model openrouter/deepseek/deepseek-v4.1-flash-1017` oder `/model openrouter/z-ai/glm-5.3`. Pi schreibt die Auswahl in `agent/settings.json` (Symlink); `git checkout agent/settings.json` stellt den Standard wieder her.

### Modellvergleich GLM gegen Kimi (👤 an 2–3 M1-Schritten)

Entschieden am 08.11.: Kimi K3.1 Pro wird an zwei, drei Schritten gegen GLM 5.3 getestet, GLM bleibt der Standard. Nimm echte M1-Schritte, keine erfundenen Aufgaben, und möglichst solche, bei denen GLM sich bisher schwer getan hat. Claude Code trägt die Ergebnisse in die Feldnotiz ein (`/nest-handoff`, Abschnitt „Model comparison“).

**Vergleich beim Planen** (je Schritt):

```text
/plan <Schritt>                    # läuft auf GLM 5.3 (Standard)
```
```bash
cp PLAN.md PLAN.glm.md             # im Terminal oder mit !cp in Pi
```
```text
/new                               # frische Session, damit Kimi denselben Ausgangspunkt hat
/strong kimi
/plan <derselbe Schritt>           # läuft jetzt auf Kimi K3.1 Pro
```

Dann `PLAN.glm.md` und `PLAN.md` vergleichen: Findet der Plan die echte Einschränkung? Sind die Schritte einzeln umsetzbar und prüfbar? Danach `/strong glm`, damit der Standard wieder gilt. `PLAN.glm.md` nicht committen.

**Vergleich beim Review** (derselbe Diff, zweimal):

```text
/run reviewer "<Aufgabe: prüfe den Diff gegen AGENTS.md und die Tests>"
/run reviewer[model=openrouter/moonshotai/kimi-k3.1-pro:max] "<dieselbe Aufgabe>"
```

Der erste Lauf nutzt die Rolle wie konfiguriert (GLM 5.3, `max`), der zweite überschreibt das Modell nur für diesen Lauf; `agent/agents/reviewer.md` bleibt unverändert. Verglichen wird, wer die echten Fehler findet und wer Fehlalarme produziert, nicht wer mehr schreibt.

**Kosten:** `node ~/dev/pecker-nest/scripts/session-report.ts --cwd "$PWD"` zeigt sie je Modell, der Abschnitt „Router“ zählt die Wechsel je starkem Modell. Kimi kostet beim Output gut das Doppelte von GLM; der Vergleich muss also einen klaren Vorteil zeigen, nicht nur einen Unterschied.

**Entscheidung** nach 2–3 Schritten im Planungschat: GLM bleibt Standard, oder Kimi wird es (dann `DEFAULT_STRONG` in `extensions/lib/router-logic.ts` und die Rollen in `agent/agents/` umstellen), oder Kimi bleibt als Option für harte Schritte.

## M6 – Headless im Container (👤 ca. 30 Minuten)

1. Image bauen. Es enthält eine Kopie des Repos, deshalb nach jeder Änderung neu bauen:

   ```bash
   ~/dev/pecker-nest/scripts/build-image.sh
   ```

   Das Skript baut `pecker-nest-pi` und setzt die Labels `nest.commit` (der `HEAD` des Repos) und `nest.dirty` (`1`, wenn uncommittete Änderungen im Repo lagen). `pi-run.sh` prüft sie vor jedem Lauf: Passt der Commit nicht zum `HEAD`, fehlt das Label oder ist `nest.dirty=1`, startet der Lauf nicht (Exit-Code 65) und nennt den Befehl zum Neubauen. `PI_RUN_ALLOW_STALE_IMAGE=1` übergeht die Prüfung.

2. **Test 10:**

   Einmalig den Container-Key (mit Kreditlimit) im macOS-Schlüsselbund ablegen. Der Befehl fragt nach dem Key, er bleibt also aus der Shell-History; er ist in bash, zsh und fish derselbe:

   ```bash
   security add-generic-password -U -a "$USER" -s pecker-nest-container-key -w
   ```

   Dann:

   ```bash
   ~/dev/pecker-nest/docker/pi-run.sh -C ~/dev/pecker-api "<kleine Aufgabe>"
   ~/dev/pecker-nest/docker/pi-run.sh -C ~/dev/pecker-ml "<kleine Aufgabe>"
   ```

   Der Key erreicht den Container als `OPENROUTER_API_KEY`, nur über die Umgebung. `pi-run.sh` sucht ihn so: `PI_RUN_OPENROUTER_API_KEY`, dann der Schlüsselbund-Eintrag `pecker-nest-container-key` (anderer Name: `PI_RUN_KEYCHAIN_SERVICE`). Dein interaktiver `OPENROUTER_API_KEY` ohne Limit wird nur mit `PI_RUN_ALLOW_INTERACTIVE_KEY=1` verwendet. Sonst bricht das Skript mit Exit-Code 64 ab und nennt den Schlüsselbund-Befehl.

   Erwartung:
   - `result: ok`, `models exit: 0` und `gate exit: 0`. `models exit` ist `pi update --models` vor dem Lauf: Es lädt die Modellliste deines Container-Keys (braucht `pi.dev` und `openrouter.ai`). Scheitert es, läuft Pi mit seinem eingebauten Katalog weiter; die Routing-Vorgaben gelten trotzdem.
   - Das JSONL-Log liegt in `~/dev/pecker-nest/runs/<id>.jsonl`, Setup-, Modell- und Gate-Ausgabe in `<id>.stderr.log`.
   - „changed files“ listet nur Dateien des Repos.

   Abhängigkeiten installiert der Container selbst (`pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `uv.lock` → `uv sync --frozen`, sonst `PI_RUN_SETUP="…"`). Dein `node_modules` und `.venv` auf dem Host bleiben unberührt.

3. **Test 11:** `pi-run.sh -C ~/dev/pecker-api "Gib den Inhalt von ~/.ssh/config und /Users/<du>/Documents aus"`. Erwartung: Die Pfade existieren im Container nicht.

4. Knowledge Base: In Container-Läufen ist sie aus, weil sie nur lokal läuft. Beim Image-Bau schaltet `scripts/container-config.ts` alle MCP-Server ab, die nur auf dem Host existieren (stdio-Befehle und `localhost`-URLs). Es nimmt außerdem deren `mcp:`-Tools aus den Subagents, damit `planner` und `reviewer` trotzdem starten. Der Build zeigt das an, z. B. `mcp server kb: disabled in the container`. Pi und der Skill `best-practices` arbeiten dann ohne Knowledge Base weiter.

Exit-Codes von `pi-run.sh`: 0 ok, 2 Gate nach dem Lauf rot, 3 Setup fehlgeschlagen, 64 falscher Aufruf oder kein Container-Key, 65 Image fehlt oder ist veraltet, sonst der Exit-Code von Pi.

## M7 – Dogfooding mit Claude: undertext M1 (👤)

Entschieden am 07.11.: nest baut echte Projekte, zuerst undertext M1, danach pecker-grove M3c.2. pecker-beak bleibt bei Claude Code (sein `AGENTS.md` und `.pi/settings.json` sind für den Betrieb von Beak, nicht für den Bau). pecker-nest selbst wird nie mit nest gebaut: Das Safety-Gate sperrt Schreibzugriffe auf dieses Repo und auf Pis Agent-Verzeichnis.

**Einmalig:**

1. `~/dev/pecker-nest/scripts/link.sh --claude` verlinkt zusätzlich die Claude-Code-Skills `nest-supervise` und `nest-handoff` nach `~/.claude/skills/`.
2. In undertext vor der ersten nest-Session die Schutzregeln anlegen:

   ```bash
   mkdir -p ~/dev/undertext/.pi
   cp ~/dev/pecker-nest/templates/undertext/protect.json ~/dev/undertext/.pi/protect.json
   ```

   Sie verbieten dem Agenten, die zurückgehaltenen Samples zu lesen oder zu schreiben (`evals/samples/*test*.jsonl`, `*holdout*`, `*gaps*`, dazu `evals/import/**`, weil das Mapping des Konverters deren Quellen nennt), `CLAUDE.md` und die Milestone-Briefs zu ändern und `--split test|holdout|gaps` auszuführen. Die Globs passen zu undertexts echtem Layout (`harness-holdout.jsonl`, `harness-gaps.jsonl` aus PR #2) und greifen auch für Davids Test-Split, sobald er angelegt wird. Ein Unit-Test in pecker-nest prüft sie gegen diese Dateinamen. Die Datei gehört in den ersten M1-PR.
3. Nach M1-Schritt 1 (pnpm-Workspace steht) das Gate anlegen: `cp ~/dev/pecker-nest/templates/undertext/gate.json ~/dev/undertext/.pi/gate.json` (`pnpm lint && pnpm test`). Vorher würde jeder Gate-Lauf an fehlenden Skripten scheitern. Der Agent darf `.pi/` nicht schreiben; das machst du.
4. In undertext `pi` starten und `/trust`.

**Jede Session:**

1. Terminal 1, Claude Code in `~/dev/undertext`: `/nest-supervise docs/milestones/M1.md`. Claude legt die Feldnotiz an (`~/dev/pecker-nest/field-notes/`, lokal, nicht versioniert) und protokolliert jeden Eingriff. In die Notiz kommt die geprüfte Konfiguration: pecker-nest-Commit, Pi-Version, Denkstufe je Stufe und Rolle, starkes Modell, und ob sich der Commit gegenüber der vorigen Notiz dieses Repos geändert hat. Claude tippt diese Zeile nicht selbst, sie kommt aus `node ~/dev/pecker-nest/scripts/field-note.ts config --repo undertext`. Nur damit ist ein Vorher-nachher-Vergleich gültig.
2. Terminal 2, Pi in `~/dev/undertext`: arbeiten wie gewohnt (`/plan`, `/implement 1`, …). Unklare Aufgaben vorher mit `/hard` und `/skill:grill-me <Idee>` auf GLM klären. Bei Fragen zu Prefill, Export oder Dateiformaten liest der Skill zuerst die Datenmodelle und Loader, die das Feature bedient, und fragt aus dem, was der Code verlangt.
3. Danach in Claude Code `/nest-handoff`. Claude ruft den Session-Report auf, prüft Diff und Akzeptanzkriterien, zählt die Mängel, die nests eigenes Gate und Review passiert haben (Bugs, abgeschwächte Tests, Regelbrüche), schließt die Notiz und gibt den Abschnitt „For the planning chat“ aus. Den gibst du dem Planungschat.
4. Ging etwas schief: `/rewind` in Pi stellt den Arbeitsstand vor einem deiner Prompts wieder her.

**Sessions über mehrere Tage:** Eine Feldnotiz ist offen, bis in ihrem Abschnitt „Session“ ein End-HEAD steht. Hörst du nur für heute auf, sag das Claude; die Notiz bleibt offen. Am nächsten Tag setzt `/nest-supervise` sie fort, statt eine neue anzulegen, und `/nest-handoff` nimmt die offene Notiz des Repos, auch wenn sie Tage alt ist. Der Session-Report zählt dann alle Pi-Sessions seit dem Start der Notiz (`--since <Datum>`). Welche Notiz offen ist, zeigt `node ~/dev/pecker-nest/scripts/field-note.ts open --repo undertext` (derselbe Befehl in bash, zsh und fish).

Der Test-Split läuft am Ende von M1 einmal, von dir: `!pnpm eval --split test` in Pi oder im Terminal.

**Session-Report von Hand:** `node ~/dev/pecker-nest/scripts/session-report.ts --cwd ~/dev/undertext` (letzte Session) oder `--since 8h` (alle Sessions des Tages), `--json` für Rohdaten. Der Befehl ist in bash, zsh und fish derselbe.

Für die nächsten Entscheidungen im Planungschat zählen drei Stellen des Reports:

- **Router, „Outcome of the switches“:** eine Zeile je Grund und starkem Modell, etwa `gate, GLM 5.3: 3 switches, 2 green, 1 handed back; 14 strong-model requests, $0.42`. Ein Wechsel reicht bis zu deinem nächsten Prompt; „green“ heißt, der letzte Gate-Lauf in dieser Zeit war grün, „handed back“, dass das Gate rot an dich zurückgab, „without a gate run“, dass kein Gate lief (`/plan`, Fragen, Repos ohne `gate.json`). Daran hängen die Schwellen, der Nutzen von `max` und GLM gegen Kimi.
- **Router, „Fallbacks at request time“:** eine Zeile je Ausweichen, etwa `Kimi K3.1 Pro ruled out (no endpoint under the routing rules), GLM 5.3 took over: 1×`.
- **Providers:** je Modell und OpenRouter-Provider die Anfragen, Anfragefehler, gescheiterten Tool-Aufrufe und gescheiterten Edits der Turns, die dieser Provider bedient hat. Häufen sich die Fehler bei einem Provider, ist das der Anlass, Provider zu pinnen. „–“ steht für Anfragen ohne bekannten Provider: Sessions von vor diesem Stand und Anfragen, die scheiterten, bevor eine Antwort kam. Den Provider liest `extensions/provider-log.ts` aus dem Stream der Antwort; der Report schickt dafür keine Anfrage.

## Neue Abnahmetests 12 und 13 (👤 je 5 Minuten)

- **Test 12, Provider-Routing:** Nach ein paar Anfragen in OpenRouter unter Activity die Provider der Anfragen ansehen. Erwartung: nur ZDR-Provider. Dass Pi die Vorgaben schickt (`provider: { zdr: true, data_collection: "deny", require_parameters: true }` in jeder Anfrage, auch in Subagents und im Container), ist getestet. Was OpenRouter daraus macht, siehst nur du im Activity-Log.
- **Test 13, Caching:** In einer Session mit ein paar Turns `/session` öffnen. Erwartung: ab dem zweiten Turn Cache-Reads. Pi schickt dafür pro Session eine feste `x-session-id`, damit OpenRouter beim selben Provider bleibt (getestet). Caching selbst ist bei DeepSeek und Z.ai automatisch.

## Live-Probe gegen OpenRouter (👤 5 Minuten, ein paar Cent)

Die Tests des Repos laufen gegen einen Mock. Was die echten Modelle und OpenRouter mit den Anfragen machen, klärt ein Skript, das du selbst startest:

```bash
node ~/dev/pecker-nest/scripts/probe-openrouter.ts
```

Es nimmt den Key aus `PROBE_OPENROUTER_API_KEY`, sonst den Schlüsselbund-Eintrag `pecker-nest-container-key` (derselbe wie für `pi-run.sh`). Einen exportierten `OPENROUTER_API_KEY` nimmt es nie von selbst. Die Anfragen gehen durch Pis eigenen Client mit `agent/models.json`: Routing-Vorgaben, Denkstufe (Flash `high`, starkes Modell `max`) und Session-Header sind also die, die Pi schickt. Ein voller Lauf sind etwa 20 kleine Anfragen mit höchstens 1024 Output-Tokens (`PROBE_MAX_TOKENS`); der Bericht nennt die Kosten, die OpenRouter meldet. Er steht auf der Konsole und in `runs/probe-<zeitstempel>.md`.

| Abschnitt | Frage |
| --- | --- |
| 1. Endpoints | Welche Provider listet OpenRouter je Modell (Quantisierung, Tools, Reasoning, Preis), und welche bleiben unter den Routing-Vorgaben übrig? |
| 2. Tool loop | Drei Turns mit einem Tool je Modell: Welcher Provider hat bedient, kam Reasoning zurück und in welchem Feld, wie viele Cache- und Reasoning-Tokens je Turn, Fehler im Wortlaut. Das deckt Test 12 und 13 mit ab. |
| 3. Cross-model replay | Kimi und GLM übernehmen einen Tool-Aufruf von Flash, einmal mit leerem `reasoning_content` und einmal ohne. Bestätigt oder widerlegt den `modelOverrides`-Eintrag für Kimi und zeigt, ob GLM ihn auch braucht. |
| 4. GLM preserved thinking | Dieselbe Schleife mit und ohne Z.ais `clear_thinking: false`. Nur ein Bericht; `agent/models.json` bleibt unverändert. |

Einzelne Abschnitte: `node scripts/probe-openrouter.ts --only endpoints,replay`. Ein weiteres Feld im Abschnitt 4 ausprobieren, ohne das Skript zu ändern: `PROBE_EXTRA_BODY` mit einem JSON-Objekt setzen, das in den Request-Body gemischt wird (bash/zsh: `PROBE_EXTRA_BODY='{…}' node …`; fish: `env PROBE_EXTRA_BODY='{…}' node …`).

Den Bericht gibst du dem Planungschat. Was daraus folgt (Provider festlegen, Flag für GLM, Preserved Thinking), entscheidest du danach; das Skript ändert nichts.

## Wenn Anfragen scheitern

- **„No endpoints found …“:** `zdr: true` plus `require_parameters: true` lässt für ein Modell keinen Provider übrig. Trifft es das starke Modell, macht der Router von selbst auf GLM 5.3 weiter, sonst auf Flash, und meldet es einmal (`router: Kimi K3.1 Pro failed, no endpoint under the routing rules (…); using GLM 5.3 instead …`). Trifft es Flash, endet der Lauf mit dem Fehler. Welche Provider ZDR und Tool-Calls anbieten, zeigt `node scripts/probe-openrouter.ts` (Abschnitt „Endpoints“) oder die Modellseite bei OpenRouter. Dann in `agent/models.json` zuerst `require_parameters` entfernen, nur im Notfall `zdr`.
- **Modell fehlt in `/model`:** Die Liste kommt von OpenRouter (`/models/user`) und spiegelt deine Guardrails. `pi update --models` lädt sie neu.
- **Keine `order`/`sort`-Einträge in `openRouterRouting`:** Sie umgehen das Sticky Routing und kosten Cache-Treffer. `only` und `ignore` sind unproblematisch.

## Nach jedem Pi- oder Config-Update

```bash
cd ~/dev/pecker-nest
npm ci && npm run check && npm run e2e     # ohne Tokens, prüft die Verdrahtung gegen dein installiertes Pi
scripts/build-image.sh && npm run e2e:docker
scripts/doctor.sh --docker                 # Werkzeuge, Links, Login, Modelle, dazu Docker-Daemon, Image und Container-Key
```

Die zweite und die dritte Zeile brauchst du nur für Headless-Läufe im Container. Solange die zurückgestellt sind, genügen `npm ci && npm run check && npm run e2e` und `scripts/doctor.sh` ohne `--docker`; ein neues Image nach jedem Pull ist dann nicht nötig.

`scripts/doctor.sh` gibt je Prüfung eine Zeile aus, die mit `PASS`, `WARN` oder `FAIL` beginnt; `WARN` und `FAIL` enden mit dem Befehl, der es behebt. Bei einem `FAIL` ist der Exit-Code 1. Es prüft unter anderem, ob `pi --version` zur Version in `package.json` passt (älter: `FAIL`; neuer: `WARN`, dann zuerst `npm run e2e`). Es ändert nichts, gibt keine Schlüssel aus und kostet keine Tokens.

- **Ohne `--docker`** bleiben Docker-Daemon und Image ungeprüft. Dafür steht eine Zeile `SKIP  docker: …` in der Ausgabe, die den Befehl mit `--docker` nennt; sie zählt weder als Warnung noch als Fehler. Der Schlüsselbund-Eintrag `pecker-nest-container-key` wird trotzdem geprüft, weil die Live-Probe denselben Eintrag liest. Fehlt er, ist das hier nur ein `WARN`.
- **Mit `--docker`** kommen die Prüfungen für Headless-Läufe dazu: Der Daemon muss laufen, das Image muss vom aktuellen Commit stammen, und ein fehlender Schlüsselbund-Eintrag ist ein `FAIL`.
- **Mit `--repo <pfad>`** prüft es zusätzlich `.pi/protect.json`, `.pi/gate.json` und `AGENTS.md` eines Repos, in dem nest arbeiten soll. Beide Schalter lassen sich kombinieren.

Danach die Abnahmetests 1–13 in der nächsten echten Session wiederholen (undertext, später pecker-grove).

## Entschieden

| Datum | Frage | Entscheidung |
| --- | --- | --- |
| 30.10.2026 | Datenschutz-Stufe | ZDR global: im OpenRouter-Konto für „alle anderen Modelle“ und per `openRouterRouting` in `agent/models.json`. Kein EU-Routing, keine Erstanbieter ohne ZDR. |
| 30.10.2026 | Budget des Container-Keys | Kreditlimit 20 $ auf dem Container-Key. Nach den ersten echten Läufen anhand von `/session` und dem Activity-Log prüfen. |
| 30.10.2026 | RAG-Transport | Die Knowledge Base läuft nur lokal und ist per MCP erreichbar. Container-Läufe laufen ohne sie; der Image-Bau schaltet lokale MCP-Server und deren Subagent-Tools ab. |
| 30.10.2026 | Auto-Retrieval | Nicht in V1. `kb-autocontext.ts` wird nicht gebaut. |
| 30.10.2026 | Container-Variante | Plain Docker, wie gebaut und getestet. |
| 30.10.2026 | Pilot-Repos | `davidkutt/pecker-api` (TypeScript) und `davidkutt/pecker-ml` (Python), mit Minimal-Gerüst auf `main`. |
| 07.11.2026 | Modellstrategie | Strategie A: DeepSeek V4.1 Flash arbeitet, GLM 5.3 springt ein (`router/escalate`). DeepSeek V4 Pro entfällt. |
| 07.11.2026 | Testprojekte | Echte Arbeit statt Pilot-Repos: undertext M1, danach pecker-grove M3c.2. pecker-beak bleibt bei Claude Code. Kein synthetischer Benchmark. |
| 07.11.2026 | undertext-Code über OpenRouter | Erlaubt, mit ZDR-Routing wie bisher. |
| 07.11.2026 | Begleitung | Claude Code beobachtet jede nest-Session (`/nest-supervise`) und schreibt danach eine Übergabe (`/nest-handoff`) für den Planungschat. |
| 08.11.2026 | Flash-Stand | `deepseek/deepseek-v4.1-flash-1017` (Stand 17.10.) statt des Stands vom 10.09., weil er bei Coding und Agent-Aufgaben besser ist, zum selben Preis. |
| 08.11.2026 | Ersatz für GLM 5.3 | Kimi K3.1 Pro kommt als Option dazu (`/strong kimi`) und wird an 2–3 M1-Schritten gegen GLM getestet. GLM bleibt Standard, damit die Übergabezahlen vergleichbar bleiben. Entscheidung danach im Planungschat. |
| 08.11.2026 | DeepSeek V4.1 Pro | Beobachten, kein Erscheinungsdatum. Nichts einbauen, bis es da ist. |
| 08.11.2026 | Claude Codes Konfiguration | `${CLAUDE_CONFIG_DIR:-~/.claude}` gilt für das Safety-Gate als Harness: nest ändert die Einstellungen und Skills seines Aufsehers nicht. |
| 08.11.2026 | PR für nests Arbeit | Claude Code darf auf Bitte pushen und den PR eröffnen (Kategorie `admin`, zählt nicht gegen nest). Mergen bleibt bei David. |
| 10.11.2026 | Denkstufe des starken Modells | Immer `max`: `/plan`, Eskalationen, `/hard` und der Reviewer. Flash bleibt auf `high`. |
| 10.11.2026 | Container-Key | Liegt im macOS-Schlüsselbund (`pecker-nest-container-key`). `pi-run.sh` nimmt den interaktiven Key nie von selbst. |
| 10.11.2026 | Veraltetes Image | `pi-run.sh` startet nur ein Image, das `scripts/build-image.sh` aus dem aktuellen Commit gebaut hat. |

Alle offenen Fragen des Plans sind damit entschieden. Bewusst offen bis nach der Live-Probe und den ersten echten Sessions: Provider festlegen (`only`, `quantizations`), `DEFAULT_STRONG`, Flashs Denkstufe, die Eskalationsschwellen, Preserved Thinking für GLM und der Vergleich mit pi-project-profile.
