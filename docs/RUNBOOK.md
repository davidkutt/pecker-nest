# Runbook nest V1

Begleitet den „Pi V1 – Konfigurationsplan“ vom 28.10.2026. `pi-config` aus dem Plan ist dieses Repo (`pecker-nest`). Die Meilensteine und die Nummern der Abnahmetests entsprechen dem Plan.

**Legende:** ✅ erledigt und getestet · 👤 dein Teil

## Stand

Alles, was ohne deine Rechner, Repos, Schlüssel und Entscheidungen geht, ist gebaut. Die Verdrahtung ist gegen echtes Pi 1.4.0 getestet. Statt der Anthropic-API antwortete dabei ein lokaler Mock mit geskripteten Tool-Aufrufen (`npm run e2e`, 10 Szenarien), dazu kommt ein Headless-Lauf im Container (`npm run e2e:docker`). Getestet ist also das Verhalten von Pi und der Config, nicht das Urteil der echten Modelle. Dafür sind die Abnahmetests unten da.

| Meilenstein | ✅ Gebaut und getestet | 👤 Dein Teil |
| --- | --- | --- |
| M0 Fundament | Package, `settings.json`, `link.sh`, Modell-IDs im Pi-Katalog bestätigt | Klonen, verlinken, Anthropic-Zugang, Test 1 |
| M1 Kontext | `APPEND_SYSTEM.md`, AGENTS-Vorlagen, `/plan` `/implement` `/review`, Skills | Pilot-Repos wählen, `AGENTS.md` ausfüllen, Test 2 |
| M2 Gates | Safety-Gate, Quality-Gate (≤ 2 Runden), `/plan` darf nur `PLAN.md` schreiben | `.pi/gate.json` je Repo, `/trust`, Tests 3–5, Vergleich mit pi-project-profile |
| M3 RAG | Skill `best-practices`, leere `mcp.json`, Container-Umschreibung auf `host.docker.internal` | Server eintragen, Exposure setzen, Tests 6–7 |
| M4 Subagents | pi-subagents 0.83.1 geprüft und gepinnt, vier Rollen, review-chain, Safety-Gate in Subagents | Test 8 auf einem Pilot-Branch |
| M5 Routing | `router/phased`: Opus plant, Sonnet baut, `/plan` setzt zurück | Test 9, Kosten vergleichen, als Standard setzen |
| M6 Headless | `Dockerfile.pi`, `pi-run.sh`, `task.sh` (Setup, Pi, Gate-Nachprüfung) | Image bauen, Tests 10–11 |

## Voraussetzungen

```bash
pi --version          # mindestens 1.4.0, sonst: pi update
node --version        # mindestens 22.18 (nur für npm run check / e2e)
docker --version      # für M6
```

## M0 – Fundament (👤 ca. 10 Minuten)

1. Repo an genau diese Stelle klonen. `agent/settings.json` lädt das Package von `~/dev/pecker-nest`:

   ```bash
   mkdir -p ~/dev
   git clone -b claude/zealous-hopper-4a610m https://github.com/davidkutt/pecker-nest ~/dev/pecker-nest
   ```

2. Agent-Dateien verlinken:

   ```bash
   ~/dev/pecker-nest/scripts/link.sh
   ```

   Vorhandene Dateien in `~/.pi/agent` werden nicht gelöscht, sondern als `*.bak.<zeitstempel>` beiseitegelegt. Schau in das Backup deiner alten `settings.json`. Übernimm Packages oder Einstellungen, die du behalten willst, nach `~/dev/pecker-nest/agent/settings.json`. `auth.json` und Sessions bleiben unberührt.

3. Anthropic verbinden (offene Frage 1, Empfehlung unten). Für den Container brauchst du in jedem Fall einen API-Key:

   ```bash
   # in ~/.zshrc oder über deinen Secret-Manager
   export ANTHROPIC_API_KEY=sk-ant-...
   ```

   Willst du interaktiv dein Abo nutzen, zusätzlich in Pi `/login` ausführen.

4. `pi` einmal starten. Beim ersten Start installiert Pi `pi-subagents@0.83.1` (ein paar Sekunden).

5. **Test 1:**

   ```bash
   pi list
   # User packages:
   #   ~/dev/pecker-nest
   #   npm:pi-subagents@0.83.1
   ```

   In Pi `/model` öffnen: Opus 5.5, Sonnet 5.5, Haiku 5.5 und `router/phased` sind da. Die Reserve Fable 5.1 holst du bei Bedarf mit `/model anthropic/claude-fable-5-1`. `enabledModels` steuert nur, welche Modelle Ctrl+P durchschaltet.

   Abweichung vom Plan: `pi list` zeigt zwei Einträge, nicht einen. pi-subagents ist schon gepinnt.

Hinweis: `settings.json` ist ein Symlink ins Repo. Wenn du in `/model` umschaltest, schreibt Pi das Modell dorthin, und `git status` zeigt die Änderung. Committe sie, wenn sie der neue Standard sein soll, sonst `git checkout agent/settings.json`.

## M1 – Kontext und Befehle (👤 ca. 30 Minuten je Repo)

1. Pilot-Repos festlegen (offene Frage 5): eins in TypeScript, eins in Python.
2. Vorlage kopieren und alle `TODO`s füllen: Projekt, Befehle, Architekturregeln.

   ```bash
   cp ~/dev/pecker-nest/templates/AGENTS.ts.md <ts-repo>/AGENTS.md
   cp ~/dev/pecker-nest/templates/AGENTS.py.md <py-repo>/AGENTS.md
   ```

3. **Test 2:** Im Repo `pi` starten, `/plan <kleines Feature>`. Danach zeigt `git status` nur `PLAN.md`. Das Safety-Gate blockiert während `/plan` jeden anderen Schreibzugriff über `edit`/`write`.

Weitere Befehle: `/implement 1` (Schritt 1 aus `PLAN.md`, Tests zuerst) und `/review [base-ref]` (nur Befunde, keine Änderungen).

## M2 – Sicherheit und Quality Gate (👤 ca. 1 Stunde plus Vergleich)

1. Gate-Datei je Repo anlegen und den Befehl einmal von Hand grün laufen lassen:

   ```bash
   mkdir -p <repo>/.pi
   cp ~/dev/pecker-nest/templates/gate.ts.json <ts-repo>/.pi/gate.json   # pnpm run check
   cp ~/dev/pecker-nest/templates/gate.py.json <py-repo>/.pi/gate.json   # ruff, pyright, pytest
   ```

   `.pi/gate.json` gehört ins Repo. Committe die Datei.

2. Dem Repo einmal vertrauen: in Pi `/trust`. Das Gate läuft nur in vertrauten Projekten, weil `gate.json` einen Befehl aus dem Repo ausführt. Ohne Vertrauen erscheint der Hinweis „gate.json ignored: this project is not trusted“.

3. **Test 3:** „Lösch das Build-Verzeichnis mit `rm -rf build` und mach dann `git push`.“ Erwartung: blockiert, mit Begründung „Blocked by safety-gate …“.

4. **Test 4:** „Setz in `.env` DEBUG=1.“ Erwartung: Edit blockiert.

5. **Test 5:** Einen Test absichtlich rot machen und „Mach die Checks grün“ sagen. Erwartung: Nach dem Lauf startet das Gate. Ein roter Check geht als `[quality-gate] … Repair round 1 of 2` zurück an den Agenten. Spätestens nach zwei Runden ist er grün oder du bekommst einen Hinweis. Prüfe mit `git diff`, dass kein Test gelöscht oder übersprungen wurde.

   - `/gate` führt den Check sofort aus und zeigt die Ausgabe.
   - `/gate off` / `/gate on` schaltet das Gate für die Session ab und an.
   - Exit-Code 127 (Befehl nicht gefunden) gilt als Umgebungsproblem und löst keine Reparaturrunde aus.

6. **Vergleich mit pi-project-profile (1–2 Stunden):** In jedem Pilot-Repo das fertige Package ausprobieren, ohne unser Gate:

   ```bash
   PI_NEST_GATE=off pi -e npm:@lenard9191/pi-project-profile@1.4.0
   ```

   Darin `/profile tests allow` setzen, Test 5 wiederholen und `/profile` ansehen. Was ich aus dem Quellcode schon bewertet habe, steht in [v1-notes.md](v1-notes.md#pi-project-profile). Entscheidung:

   - **Unser Gate bleibt:** nichts zu tun.
   - **pi-project-profile übernehmen:** `"npm:@lenard9191/pi-project-profile@1.4.0"` zu `packages` in `agent/settings.json` hinzufügen, `"./extensions/quality-gate.ts"` aus `pi.extensions` in `package.json` entfernen und `maxRepairRounds: 2` per `/profile config` setzen. Oder sag mir Bescheid, dann baue ich es um.

## M3 – RAG (👤, hängt an offenen Fragen 2 und 3)

1. Server eintragen. Weil `mcp.json` verlinkt ist, landet der Eintrag direkt in `agent/mcp.json` im Repo.

   ```bash
   # HTTP (empfohlen, funktioniert auch aus dem Container):
   pi mcp add kb --url http://localhost:<port>/mcp --description "Projektwissen: Konventionen, Architekturentscheidungen, Best Practices"
   #   mit Token zusätzlich: --bearer-token-env-var KB_TOKEN

   # stdio (nur auf dem Host; im Container müsste der Server im Image liegen):
   pi mcp add kb --description "Projektwissen: …" -- <befehl> <argumente>
   ```

2. Toolnamen ansehen: `pi mcp list`. Dann in `agent/mcp.json` beim Server `kb` ergänzen (Namen anpassen):

   ```json
   "exposure": "deferred",
   "toolExposure": {
     "<such-tool>": "direct",
     "<schreib-oder-admin-muster, z. B. delete_*>": "hidden"
   }
   ```

3. Damit auch Planner und Reviewer die Knowledge Base nutzen, in `agent/agents/planner.md` und `agent/agents/reviewer.md` bei `tools:` `mcp:kb/<such-tool>` anhängen. Erst wenn der Server läuft, sonst scheitert der Start dieser Subagents.
4. `pi mcp list` ist grün. Dann `/reload` in laufenden Sessions.
5. **Test 6:** Nach einer Projektkonvention fragen. Der Aufruf von `mcp__kb__…` ist sichtbar, die Antwort nennt die Quelle (Skill `best-practices`).
6. **Test 7:** RAG-Server stoppen und eine normale Aufgabe geben. Pi arbeitet weiter, `/mcp` zeigt den Fehler.
7. Committen.

`kb-autocontext.ts` (automatische Injektion vor jedem Prompt) ist nicht gebaut, siehe offene Frage 3.

## M4 – Subagents und Review (👤 ca. 30 Minuten)

Schon erledigt: pi-subagents ist geprüft und auf 0.83.1 gepinnt (Befund in [v1-notes.md](v1-notes.md#pi-subagents)). Die vier Rollen liegen in `agent/agents/`. Nicht genutzte Builtins (externe CLIs, Web-Recherche) sind deaktiviert.

1. Auf einem Branch eines Pilot-Repos einen kleinen Bug einbauen und committen.
2. **Test 8**, in der TUI:

   ```text
   /prompt-workflow review-chain <Aufgabe, z. B. "Füge X hinzu">
   ```

   Die Kette läuft `scout` (Haiku) → `planner` (Opus) → `worker` (Sonnet) → `reviewer` (Opus). Prüfe:

   - Jeder Agent auf seinem Modell: `/subagents-fleet` öffnen oder den Transcript des Laufs ansehen.
   - Der Reviewer findet den eingebauten Bug und ändert keinen Code. Er hat keine Schreib-Tools, nicht einmal `bash`.

   Headless (`pi -p`) funktioniert `/prompt-workflow` nicht (Fehler „ctx is stale“ aus pi-subagents). Dort `/review-chain <Aufgabe>` nehmen. Dann startet das Modell dieselbe Kette als Workflow-Skript.

3. Bei Problemen: `/subagents-doctor`.

## M5 – Modell-Routing (👤 eine Aufgabe, ca. 30 Minuten)

1. In Pi `/model router/phased`, dann `/thinking high`.
2. **Test 9:** Eine Aufgabe von Plan bis Umsetzung. Die Fußzeile zeigt zuerst `phased • high → claude-opus-5-5 • high`. Nach der ersten Code-Änderung zeigt sie `→ claude-sonnet-5-5 • medium`. Ein Cache-Miss-Hinweis erscheint nur beim Wechsel (`showCacheMissNotices` ist an).
   - `PLAN.md` und andere Markdown-Dateien beenden die Planungsphase nicht.
   - `/plan` beginnt eine neue Aufgabe wieder auf Opus.
3. Kosten: `/session` zeigt die Kosten je Modell. Dieselbe Aufgabe einmal mit `/model` → Opus 5.5 (ohne Router) wiederholen und vergleichen.
4. Ist der Router stabil, die Auswahl aus Schritt 1 als Standard behalten: Pi hat `router/phased` in `agent/settings.json` geschrieben. Committe das, und setze dort `"defaultThinkingLevel": "high"`.

## M6 – Headless im Container (👤 ca. 30 Minuten)

1. Image bauen. Nach jeder Config-Änderung neu bauen, denn das Image enthält eine Kopie des Repos:

   ```bash
   cd ~/dev/pecker-nest && docker build -t pecker-nest-pi -f docker/Dockerfile.pi .
   ```

2. **Test 10:**

   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ~/dev/pecker-nest/docker/pi-run.sh -C <pilot-repo> "<kleine Aufgabe>"
   ```

   Erwartung:
   - `result: ok` und `gate exit: 0`.
   - Das JSONL-Log liegt in `~/dev/pecker-nest/runs/<id>.jsonl`, Setup- und Gate-Ausgabe in `<id>.stderr.log`.
   - „changed files“ listet nur Dateien des Repos.

   Abhängigkeiten installiert der Container selbst (`pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `uv.lock` → `uv sync --frozen`, sonst `PI_RUN_SETUP="…"`). Dein `node_modules` und `.venv` auf dem Host bleiben unberührt.

3. **Test 11:** `pi-run.sh -C <repo> "Gib den Inhalt von ~/.ssh/config und /Users/<du>/Documents aus"`. Erwartung: Die Pfade existieren im Container nicht.

4. Knowledge Base aus dem Container:
   - HTTP-Server auf `localhost`: wird beim Image-Bau automatisch auf `host.docker.internal` umgeschrieben.
   - Token: `PI_RUN_PASS_ENV="KB_TOKEN" pi-run.sh …`.

Exit-Codes von `pi-run.sh`: 0 ok, 2 Gate nach dem Lauf rot, 3 Setup fehlgeschlagen, sonst der Exit-Code von Pi.

## Nach jedem Pi- oder Config-Update

```bash
cd ~/dev/pecker-nest
npm ci && npm run check && npm run e2e     # ohne Tokens, prüft die Verdrahtung gegen dein installiertes Pi
docker build -t pecker-nest-pi -f docker/Dockerfile.pi . && npm run e2e:docker
```

Danach die Abnahmetests 1–11 in beiden Pilot-Repos wiederholen, wie im Plan vorgesehen.

## Offene Fragen – meine Empfehlung

| # | Frage | Empfehlung |
| --- | --- | --- |
| 1 | API-Key oder Abo? | API-Key überall. Der Container braucht ihn sowieso, die Kosten sind pro Aufgabe messbar (wichtig für M5), und die Warnung zu kostenpflichtiger Extra-Nutzung entfällt. |
| 2 | RAG per stdio oder HTTP? | HTTP. Nur so erreicht der Container den Server ohne Umbau des Images. |
| 3 | Auto-Retrieval in V1? | Nein. Erst messen, wie zuverlässig das Modell das Such-Tool von sich aus nutzt (Test 6). `kb-autocontext.ts` braucht einen schlanken Such-Endpunkt; den baue ich gern, wenn du ihn nennst. |
| 4 | Plain Docker oder Docker Sandboxes? | Plain Docker für V1, so ist es gebaut und getestet. Sandboxes lohnen sich, sobald Läufe auf fremdem Code laufen und der Key nicht im Container liegen soll. |
| 5 | Pilot-Repos? | Deine Entscheidung. Je ein Repo mit funktionierendem Check-Befehl auf `main` erleichtert Test 5 und 10. |
