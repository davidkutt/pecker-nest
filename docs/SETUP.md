# Setup-Guide nest V1

Von null bis zum ersten echten Lauf: Code ansehen, klonen, Pi umstellen, Pilot-Repos und Container. Rechne mit gut einer Stunde, plus die Zeit, die du dir für das Durchsehen des Codes nimmst. Die Abnahmetests danach stehen im [Runbook](RUNBOOK.md).

Die Befehle sind für macOS mit Homebrew geschrieben; unter Linux tauschst du nur die Installationsbefehle aus.

## Überblick

Drei Repos, alle unter `github.com/davidkutt`:

| Repo | Was es ist | Wohin |
| --- | --- | --- |
| `pecker-nest` | Die Pi-Konfiguration aus dem Plan (dort `pi-config`): Gates, Router, Subagent-Rollen, Prompts, Skills, Docker | `~/dev/pecker-nest`, genau dieser Pfad |
| `pecker-api` | TypeScript-Pilot: Gerüst mit einem kleinen Modul und Tests | `~/dev/pecker-api` |
| `pecker-ml` | Python-Pilot: Gerüst mit einem kleinen Modul und Tests | `~/dev/pecker-ml` |

So hängt es zusammen:

- Pi liest seine Konfiguration aus `~/.pi/agent`. `scripts/link.sh` ersetzt dort `settings.json`, `models.json`, `APPEND_SYSTEM.md`, `mcp.json` und einige Prompts durch Symlinks auf `pecker-nest/agent/`. Ab dann gilt: Was im Repo steht, gilt in Pi.
- Die Modelle laufen über OpenRouter: GLM 5.3 als Hauptmodell, DeepSeek V4 Pro als Reviewer, DeepSeek V4 Flash als Scout. OpenRouter routet nur an Provider mit Zero Data Retention.
- Für Headless-Läufe baust du ein Docker-Image, das eine Kopie von `pecker-nest` enthält.

## 1. Voraussetzungen prüfen (10 Minuten)

```bash
pi --version       # mindestens 1.4.0
node --version     # mindestens 22.18
git --version
pnpm --version     # 10.x
uv --version
docker --version   # Docker Desktop muss laufen
```

| Fehlt oder zu alt | So bekommst du es |
| --- | --- |
| Pi älter als 1.4.0 | `pi update` |
| Node | `brew install node` (jede Version ab 22.18) |
| pnpm | `npm install -g pnpm@10` |
| uv | `brew install uv` |
| Docker | Docker Desktop installieren und starten |

## 2. OpenRouter vorbereiten (10 Minuten)

Auf openrouter.ai:

1. **Settings → Privacy:** Zero Data Retention für „alle anderen Modelle“ einschalten. Danach bietet OpenRouter deinem Konto nur noch Provider an, die nichts speichern.
2. **Keys → Create Key:** einen Key nur für den Container anlegen, Kreditlimit 20 $. Leg ihn in deinen Passwort-Manager; du brauchst ihn erst in Schritt 6.

Für die interaktive Arbeit brauchst du keinen eigenen Key anzulegen. Du meldest dich in Schritt 4 mit `/login openrouter` an. Alternativ geht auch ein Key in der Umgebungsvariable `OPENROUTER_API_KEY`.

## 3. pecker-nest klonen und ansehen (30–60 Minuten)

```bash
mkdir -p ~/dev
git clone https://github.com/davidkutt/pecker-nest ~/dev/pecker-nest
cd ~/dev/pecker-nest
```

Der Code liegt auf dem Branch `claude/zealous-hopper-4a610m`; einen `main` gibt es in diesem Repo noch nicht. Der Klon checkt diesen Branch automatisch aus.

### Was du dir ansehen solltest

Extensions laufen mit deinen Rechten im Pi-Prozess. Lies sie deshalb, bevor du `link.sh` ausführst. In dieser Reihenfolge ergibt es am meisten Sinn:

| Datei | Was sie tut | Worauf achten |
| --- | --- | --- |
| `README.md` | Überblick und Verzeichnisstruktur | – |
| `agent/settings.json` | Modelle, Tools, Packages, Subagent-Standards | Standardmodell, gepinnte Version von pi-subagents |
| `agent/models.json` | OpenRouter-Routing: `zdr`, `data_collection: deny`, `require_parameters` | Stimmt das mit deiner Datenschutz-Entscheidung überein? |
| `agent/APPEND_SYSTEM.md` | Globale Arbeitsregeln für das Modell | Passen sie zu deiner Arbeitsweise? |
| `extensions/safety-gate.ts`, `extensions/lib/safety-rules.ts` | Blockiert `rm -rf`, `git push`, `git reset --hard`, `curl … \| sh`, Schreiben auf `.env` und Secrets | Fehlt dir etwas, oder ist etwas zu streng? |
| `extensions/quality-gate.ts` | Führt nach Code-Änderungen den Befehl aus `.pi/gate.json` aus, höchstens zwei Reparaturrunden | Läuft nur in Repos, denen du vertraust (`/trust`) |
| `extensions/router.ts` | Virtuelles Modell `router/phased`: GLM 5.3 plant auf `max`, baut auf `high` | – |
| `agent/agents/*.md` | Die vier Rollen `scout`, `planner`, `worker`, `reviewer` | Modell und Tools je Rolle |
| `docker/Dockerfile.pi`, `docker/pi-run.sh`, `docker/task.sh` | Image und Headless-Läufe | Was in den Container kommt und was nicht |
| `docs/v1-notes.md` | Abweichungen vom Plan, Prüfung von pi-subagents, was nicht getestet ist | – |

Fremdcode: `pi-subagents@0.83.1` von npm. Was ich daran geprüft habe, steht in `docs/v1-notes.md` im Abschnitt „pi-subagents“.

### Optional: die Tests des Repos laufen lassen (10 Minuten, keine Kosten)

Die End-to-End-Tests starten dein installiertes Pi gegen einen lokalen Stand-in für OpenRouter. Sie kosten keine Tokens und brauchen keinen Key. So siehst du vor dem Umstellen, dass die Config mit deiner Pi-Version funktioniert.

```bash
cd ~/dev/pecker-nest
npm ci
npm run check   # Typecheck und Unit-Tests
npm run e2e     # echtes Pi gegen den Stand-in; endet mit "all scenarios passed"
```

`npm run e2e` installiert pi-subagents in ein temporäres Verzeichnis und braucht dafür Internet. Dein `~/.pi/agent` fasst es nicht an.

## 4. Pi auf die Config umstellen (10 Minuten)

1. Sieh nach, was schon da ist:

   ```bash
   ls -la ~/.pi/agent
   ```

2. Verlinken:

   ```bash
   ~/dev/pecker-nest/scripts/link.sh
   ```

   Das Skript löscht nichts. Vorhandene Dateien benennt es in `<name>.bak.<zeitstempel>` um und zeigt jede Aktion an. `auth.json` und deine Sessions bleiben, wo sie sind. Hattest du in der alten `settings.json` eigene Packages oder Einstellungen, übernimm sie in `~/dev/pecker-nest/agent/settings.json`.

   Prüfen lässt sich der Stand jederzeit mit `~/dev/pecker-nest/scripts/link.sh --check`.

3. Pi starten und anmelden:

   ```bash
   pi
   ```

   Beim ersten Start installiert Pi `pi-subagents` (ein paar Sekunden). Dann in Pi:

   ```text
   /login openrouter
   ```

   Der Browser öffnet sich; danach lädt Pi die Modelle, die dein Konto nutzen darf.

4. Kontrolle:
   - `/model` zeigt unter `openrouter` `z-ai/glm-5.3`, `deepseek/deepseek-v4-pro-0813` und `deepseek/deepseek-v4-flash-0731`, dazu `router/phased`.
   - Fehlt eines davon, lässt dein ZDR-Filter es nicht zu. Siehe „Häufige Probleme“ unten.
   - In der Shell zeigt `pi list` zwei Packages: `~/dev/pecker-nest` und `npm:pi-subagents@0.83.1`.

5. Kurzer Rauchtest mit echtem Modell (kostet weniger als einen Cent):

   ```bash
   cd /tmp && pi -p "Antworte nur mit OK"
   ```

Hinweis: `settings.json` ist jetzt ein Symlink ins Repo. Wenn du in Pi das Modell wechselst, schreibt Pi das dorthin, und `git status` in `pecker-nest` zeigt die Änderung. Committe sie, wenn sie der neue Standard sein soll, sonst `git checkout agent/settings.json`.

## 5. Pilot-Repos einrichten (15 Minuten)

```bash
git clone https://github.com/davidkutt/pecker-api ~/dev/pecker-api
git clone https://github.com/davidkutt/pecker-ml ~/dev/pecker-ml

cd ~/dev/pecker-api && pnpm install && pnpm run check
cd ~/dev/pecker-ml && uv sync && uv run ruff check . && uv run pyright && uv run pytest -q
```

Beide Checks müssen grün sein. Lies in beiden Repos kurz `AGENTS.md`: Das ist der Kontext, den Pi dort bekommt (Befehle, Regeln, Definition of Done).

Dann in jedem Repo einmal Pi starten und dem Projekt vertrauen:

```bash
cd ~/dev/pecker-api && pi
```

```text
/trust
```

Ohne `/trust` läuft das Quality Gate dort nicht. Pi meldet dann „gate.json ignored: this project is not trusted“. Dasselbe in `~/dev/pecker-ml`.

Erster echter Auftrag, z. B. in pecker-api:

```text
/plan slugify soll eine maximale Länge bekommen
```

Danach zeigt `git status` nur eine neue `PLAN.md` (Abnahmetest 2). Weiter mit `/implement 1`. Nach der Umsetzung läuft das Quality Gate automatisch.

## 6. Container einrichten (15 Minuten)

```bash
cd ~/dev/pecker-nest
docker build -t pecker-nest-pi -f docker/Dockerfile.pi .
```

Das Image enthält eine Kopie von `pecker-nest`. Bau es nach jeder Config-Änderung neu.

Optional ohne Kosten: `npm run e2e:docker` prüft das Image mit dem Stand-in.

Erster echter Headless-Lauf mit dem Container-Key aus Schritt 2:

```bash
export PI_RUN_OPENROUTER_API_KEY=sk-or-...   # der Container-Key mit 20 $ Limit
~/dev/pecker-nest/docker/pi-run.sh -C ~/dev/pecker-api "Füge einen Test für slugify mit Emojis hinzu"
```

`pi-run.sh` gibt am Ende `result: ok`, die Exit-Codes von Setup, Modellliste und Gate und die geänderten Dateien aus. Die Logs liegen unter `~/dev/pecker-nest/runs/` (`<id>.jsonl` und `<id>.stderr.log`). Im Container gibt es keine Knowledge Base; das ist so entschieden.

## 7. Wie es weitergeht

1. **Abnahmetests:** [Runbook](RUNBOOK.md), Tests 1–13 in beiden Pilot-Repos.
2. **Knowledge Base eintragen:** Runbook, M3. Das geht mit `pi mcp add kb …`.
3. **Router ausprobieren:** Runbook, M5. Dort wählst du `/model router/phased`.
4. **`main` für pecker-nest:** Wenn dir der Stand passt, leg auf GitHub `main` aus dem Branch an und mach ihn zum Default. Danach `git -C ~/dev/pecker-nest fetch && git -C ~/dev/pecker-nest switch main`.

## Häufige Probleme

| Meldung oder Symptom | Ursache und Lösung |
| --- | --- |
| `link.sh`: „this repo must live at ~/dev/pecker-nest“ | Falscher Klon-Pfad. Verschieben, oder `ln -s <klon> ~/dev/pecker-nest`. |
| Modell fehlt in `/model` | Dein Konto lässt es nicht zu, meist wegen ZDR. Auf der Modellseite bei OpenRouter prüfen, welche Provider ZDR anbieten. Danach `pi update --models`. |
| „No endpoints found …“ beim Senden | Mit ZDR und `require_parameters` bleibt kein Provider übrig. Runbook, Abschnitt „Wenn Anfragen scheitern“. |
| „gate.json ignored: this project is not trusted“ | In dem Repo `/trust` ausführen. |
| Ein Befehl wird mit „Blocked by safety-gate“ abgelehnt | Absicht. Wenn du ihn wirklich willst, führ ihn selbst aus: `!befehl` in Pi oder im Terminal. |
| `pi-run.sh`: „set PI_RUN_OPENROUTER_API_KEY …“ | Container-Key exportieren (Schritt 6). |
| `pi-run.sh` meldet `models exit: 1` | Die Modellliste ließ sich nicht laden (keine Verbindung zu `pi.dev` oder `openrouter.ai`). Der Lauf geht mit Pis eingebautem Katalog weiter. |

## Rückgängig machen

Zurück zu deiner alten Pi-Konfiguration:

```bash
cd ~/.pi/agent
for f in settings.json models.json APPEND_SYSTEM.md mcp.json; do [ -L "$f" ] && rm "$f"; done
find prompts -type l -lname '*pecker-nest*' -delete
ls *.bak.*                                       # deine gesicherten Dateien
mv settings.json.bak.<zeitstempel> settings.json  # je Datei, die du zurückhaben willst
```

Container-Reste entfernen: `docker rmi pecker-nest-pi` und `docker volume rm pecker-nest-sessions`.
