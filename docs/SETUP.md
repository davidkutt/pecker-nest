# Setup-Guide nest V1

Von null bis zum ersten echten Lauf: Code ansehen, klonen, Pi umstellen, Pilot-Repos und Container. Rechne mit gut einer Stunde, plus die Zeit, die du dir für das Durchsehen des Codes nimmst. Die Abnahmetests danach stehen im [Runbook](RUNBOOK.md).

Die Befehle sind für macOS mit Homebrew geschrieben; unter Linux tauschst du nur die Installationsbefehle aus. Sie laufen in bash, zsh und fish gleich. Wo sich fish unterscheidet, steht zuerst der Befehl für bash/zsh und danach der für fish.

## Überblick

Drei Repos, alle unter `github.com/davidkutt`:

| Repo | Was es ist | Wohin |
| --- | --- | --- |
| `pecker-nest` | Die Pi-Konfiguration aus dem Plan (dort `pi-config`): Gates, Router, Subagent-Rollen, Prompts, Skills, Docker | `~/dev/pecker-nest`, genau dieser Pfad |
| `pecker-api` | TypeScript-Pilot: Gerüst mit einem kleinen Modul und Tests (seit 07.11. nur noch Testmaterial; echte Arbeit läuft in pecker-grove, danach in undertext, siehe Runbook M7) | `~/dev/pecker-api` |
| `pecker-ml` | Python-Pilot: Gerüst mit einem kleinen Modul und Tests (ebenso) | `~/dev/pecker-ml` |

So hängt es zusammen:

- Pi liest seine Konfiguration aus `~/.pi/agent`. `scripts/link.sh` ersetzt dort `settings.json`, `models.json`, `APPEND_SYSTEM.md`, `mcp.json` und einige Prompts durch Symlinks auf `pecker-nest/agent/`. Ab dann gilt: Was im Repo steht, gilt in Pi.
- Die Modelle laufen über OpenRouter (Strategie A): DeepSeek V4.1 Flash arbeitet, GLM 5.3 plant, prüft und springt ein, wenn Flash hängt. Das Standardmodell `router/escalate` entscheidet je Anfrage. Seit 08.11. lässt sich das starke Modell mit `/strong kimi` auf Kimi K3.1 Pro umstellen (optional, für den Vergleich; siehe RUNBOOK M5). OpenRouter routet nur an Provider mit Zero Data Retention.
- Für Headless-Läufe baust du ein Docker-Image, das eine Kopie von `pecker-nest` enthält.

## 1. Voraussetzungen prüfen (10 Minuten)

```bash
pi --version       # mindestens 1.5.0
node --version     # mindestens 22.18
git --version
pnpm --version     # 10.x
uv --version
docker --version   # Docker Desktop muss laufen
```

| Fehlt oder zu alt | So bekommst du es |
| --- | --- |
| Pi älter als 1.5.0 | `pi update` |
| Node | `brew install node` (jede Version ab 22.18) |
| pnpm | `npm install -g pnpm@10` |
| uv | `brew install uv` |
| Docker | Docker Desktop installieren und starten |

## 2. OpenRouter vorbereiten (10 Minuten)

Auf openrouter.ai:

1. **Settings → Privacy:** Zero Data Retention für „alle anderen Modelle“ einschalten. Danach bietet OpenRouter deinem Konto nur noch Provider an, die nichts speichern.
2. **Keys → Create Key:** einen Key nur für den Container anlegen, Kreditlimit 20 $. Leg ihn in deinen Passwort-Manager; in Schritt 6 kommt er in den macOS-Schlüsselbund.

Für die interaktive Arbeit brauchst du keinen eigenen Key anzulegen und keinen zu exportieren. Du meldest dich in Schritt 4 mit `/login openrouter` an; das reicht. Ein exportierter `OPENROUTER_API_KEY` hat kein Limit und liegt in jeder Shell offen, deshalb warnt `scripts/doctor.sh`, wenn er gesetzt ist.

## 3. pecker-nest klonen und ansehen (30–60 Minuten)

```bash
mkdir -p ~/dev
git clone -b main https://github.com/davidkutt/pecker-nest ~/dev/pecker-nest
cd ~/dev/pecker-nest
```

Der Code liegt auf `main`.

### Was du dir ansehen solltest

Extensions laufen mit deinen Rechten im Pi-Prozess. Lies sie deshalb, bevor du `link.sh` ausführst. In dieser Reihenfolge ergibt es am meisten Sinn:

| Datei | Was sie tut | Worauf achten |
| --- | --- | --- |
| `README.md` | Überblick und Verzeichnisstruktur | – |
| `agent/settings.json` | Modelle, Tools, Kompaktierung, Packages, Subagent-Standards | Standardmodell, gepinnte Version von pi-subagents |
| `agent/models.json` | OpenRouter-Routing: `zdr`, `data_collection: deny`, `require_parameters`; dazu ein `modelOverrides`-Eintrag, damit Kimi K3.1 Pro ein Gespräch übernehmen kann, das Flash begonnen hat | Stimmt das mit deiner Datenschutz-Entscheidung überein? |
| `agent/APPEND_SYSTEM.md` | Globale Arbeitsregeln für das Modell | Passen sie zu deiner Arbeitsweise? |
| `extensions/safety-gate.ts`, `extensions/lib/safety-rules.ts`, `extensions/lib/protect-config.ts` | Blockiert `rm -rf`, `git push`, `git reset --hard`, `curl … \| sh`, Schreiben auf `.env`, Secrets, `.pi/` und die Harness selbst; wendet `.pi/protect.json` je Repo an | Fehlt dir etwas, oder ist etwas zu streng? |
| `extensions/quality-gate.ts`, `extensions/lib/tamper-check.ts` | Führt nach Code-Änderungen den Befehl aus `.pi/gate.json` aus, höchstens zwei Reparaturrunden. Prüft dabei den Diff auf abgeschwächte Tests: gelöschte Testdateien, weniger Testfälle, neue Skip-Marker und Unterdrückungen, geänderte Lint-, Typ- und Test-Konfiguration | Läuft nur in Repos, denen du vertraust (`/trust`). Die Prüfung macht nichts rückgängig; was bleibt, bekommst du als Liste |
| `extensions/router.ts`, `extensions/lib/router-logic.ts` | Virtuelles Modell `router/escalate`: Flash für jeden Prompt, das starke Modell für `/plan`, ein rotes Gate in Runde 2, Schleifen und `/hard`; `/strong glm\|kimi` wählt es | Die Schwellen und `DEFAULT_STRONG` in `router-logic.ts` |
| `extensions/checkpoint.ts`, `extensions/lib/checkpoint.ts` | Git-Checkpoint vor jedem Prompt, `/rewind` | Ruft `git` auf, schreibt nur Refs unter `refs/nest/checkpoints/` |
| `extensions/provider-log.ts`, `extensions/lib/provider-log.ts` | Schreibt zu jeder Anfrage den OpenRouter-Provider in die Session-Datei, aus dem Stream der Antwort | Schickt selbst keine Anfrage und braucht keinen Key |
| `extensions/vendor/` | `todo`- und `questionnaire`-Tool, unverändert aus Pis Beispielen | – |
| `scripts/session-report.ts`, `scripts/field-note.ts`, `skills/nest-supervise`, `skills/nest-handoff` | Kennzahlen aus Pis Session-Logs; die geprüfte Konfiguration und die offene Feldnotiz für die Übergabe; Skills für begleitete Sessions (Claude Code, Cursor, Pi), nicht Teil von Pis Package | Der Report gibt nur Zahlen und Pfade aus und arbeitet offline |
| `agent/agents/*.md` | Die vier Rollen `scout`, `planner`, `worker`, `reviewer` | Modell und Tools je Rolle |
| `docker/Dockerfile.pi`, `docker/pi-run.sh`, `docker/task.sh`, `scripts/build-image.sh` | Image und Headless-Läufe | Was in den Container kommt und was nicht; woher `pi-run.sh` den Key nimmt |
| `scripts/doctor.sh`, `scripts/probe-openrouter.ts` | Prüft, ob der Rechner bereit ist (liest nur; Docker-Daemon und Image nur mit `--docker`); Live-Probe gegen OpenRouter, die du selbst startest | Die Probe schickt echte Anfragen (ein paar Cent) |
| `docs/v1-notes.md` | Abweichungen vom Plan, Prüfung von pi-subagents, was nicht getestet ist | – |

Fremdcode: `pi-subagents@0.87.0` von npm, dazu zwei unveränderte Beispiele aus Pi (`extensions/vendor/`) und der Skill `grill-me` nach Matt Pocock (MIT). Was ich daran geprüft habe, steht in `docs/v1-notes.md` im Abschnitt „pi-subagents“.

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
   ~/dev/pecker-nest/scripts/link.sh --claude
   ```

   `--claude` verlinkt zusätzlich die Skills `nest-supervise` und `nest-handoff` nach `~/.claude/skills/` (Runbook M7), `--cursor` nach `~/.cursor/skills/` und installiert dazu den Cursor-Adapter (Abschnitt 8), `--pi` nach `~/.pi/agent/skills/`; die Optionen lassen sich kombinieren. Ohne sie bleiben Claude Code, Cursor und Pis Skills unberührt. In einem Skill-Verzeichnis verschiebt das Skript nichts: Was dort kein Link in dieses Repo ist, meldet es als `foreign` und lässt es stehen.

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
   - `/model` zeigt `router/escalate` (ausgewählt) und unter `openrouter` drei Modelle: `deepseek/deepseek-v4.1-flash-1017`, `z-ai/glm-5.3` und `moonshotai/kimi-k3.1-pro`.
   - Fehlt eines davon, lässt dein ZDR-Filter es nicht zu. Siehe „Häufige Probleme“ unten. Kimi K3.1 Pro braucht der Router nur nach `/strong kimi`; fehlt es, läuft alles auf GLM.
   - In der Shell zeigt `pi list` zwei Packages: `~/dev/pecker-nest` und `npm:pi-subagents@0.87.0`.

5. Alles auf einmal prüfen:

   ```bash
   ~/dev/pecker-nest/scripts/doctor.sh
   ```

   Jede Zeile beginnt mit `PASS`, `WARN` oder `FAIL`, und `WARN` und `FAIL` enden mit dem Befehl, der es behebt. Jetzt sollte keine Zeile mit `FAIL` beginnen. Docker-Daemon und Image prüft der Befehl erst mit `--docker`; ohne den Schalter steht dafür eine Zeile `SKIP  docker: …` da. Zu erwarten ist noch ein `WARN` für den Schlüsselbund-Eintrag, den du erst in Schritt 6 anlegst.

6. Kurzer Rauchtest mit echtem Modell (kostet weniger als einen Cent):

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
~/dev/pecker-nest/scripts/build-image.sh
```

Das Image enthält eine Kopie von `pecker-nest`, und `build-image.sh` schreibt den Commit als Label hinein (`nest.commit`, dazu `nest.dirty=1`, wenn beim Bauen uncommittete Änderungen im Repo lagen). `pi-run.sh` vergleicht das Label vor jedem Lauf mit dem `HEAD` des Repos und startet ein veraltetes Image nicht, sondern nennt den Befehl zum Neubauen. Ein vergessener Neubau fällt also sofort auf, statt still mit alten Gates und altem Routing zu laufen.

Optional ohne Kosten: `npm run e2e:docker` prüft das Image mit dem Stand-in.

Leg den Container-Key aus Schritt 2 einmal im macOS-Schlüsselbund ab. Der Befehl fragt nach dem Key; er steht damit weder in der Shell-History noch in einer Datei. Er ist in bash, zsh und fish derselbe:

```bash
security add-generic-password -U -a "$USER" -s pecker-nest-container-key -w
```

Erster echter Headless-Lauf:

```bash
~/dev/pecker-nest/docker/pi-run.sh -C ~/dev/pecker-api "Füge einen Test für slugify mit Emojis hinzu"
```

`pi-run.sh` sucht den Key in dieser Reihenfolge: `PI_RUN_OPENROUTER_API_KEY` (für einen einzelnen Lauf oder unter Linux), dann der Schlüsselbund-Eintrag `pecker-nest-container-key`. Deinen interaktiven `OPENROUTER_API_KEY` nimmt es nie von selbst: Der Container läuft mit `--approve`, und dieser Key hat kein Limit. Ohne Container-Key bricht das Skript mit Exit-Code 64 ab und nennt den Schlüsselbund-Befehl. Nur mit `PI_RUN_ALLOW_INTERACTIVE_KEY=1` gibt es den interaktiven Key weiter, mit Warnung.

Vorher zeigt `~/dev/pecker-nest/scripts/doctor.sh --docker`, ob Daemon, Key und Image bereit sind; jetzt sollte keine Zeile mehr mit `FAIL` beginnen. Der Befehl ist in bash, zsh und fish derselbe.

`pi-run.sh` gibt am Ende `result: ok`, die Exit-Codes von Setup, Modellliste und Gate und die geänderten Dateien aus. Die Logs liegen unter `~/dev/pecker-nest/runs/` (`<id>.jsonl` und `<id>.stderr.log`). Im Container gibt es keine Knowledge Base; das ist so entschieden.

## 7. Wie es weitergeht

1. **Dogfooding:** [Runbook](RUNBOOK.md), M7: pecker-grove M3c.2 mit nest bauen, danach undertext, Claude Code begleitet und schreibt Übergaben. Die Abnahmetests 1–13 laufen dabei mit.
2. **Router verstehen:** Runbook, M5. `router/escalate` ist schon Standard.
3. **Knowledge Base nutzen:** Runbook, M3. Der Server `kb` (pecker-grove) ist schon eingetragen; du startest grove und meldest dich einmal mit `pi mcp login kb` an.

## 8. Cursor (optional, 15 Minuten)

In Cursor gelten dieselben Sicherheitsregeln und dasselbe Quality Gate wie in nest, aus denselben Dateien je Repo (`.pi/protect.json`, `.pi/gate.json`). Dafür installiert `link.sh --cursor` Hooks auf Benutzerebene (`~/.cursor/hooks.json`), die die Logik aus `extensions/lib/` aufrufen. Grundlage sind die Befunde in [research/cursor-hooks.md](research/cursor-hooks.md) und der Capture vom 17.11.2026 (Cursor 3.30.14, Run Mode „Auto Review (with Sandbox)“).

1. Installieren. Der Befehl ist in bash, zsh und fish derselbe:

   ```bash
   ~/dev/pecker-nest/scripts/link.sh --cursor
   ```

   Das Skript verlinkt wie immer Pis Dateien und die Supervision-Skills nach `~/.cursor/skills/`. Dazu schreibt es `~/.cursor/hooks.json` (eine vorhandene Datei wird zu `hooks.json.bak.<zeitstempel>`), verlinkt den Reviewer-Subagent nach `~/.cursor/agents/reviewer.md` und die Skills `grill-me`, `testing-ts` und `testing-py` nach `~/.agents/skills/`. `best-practices` bleibt draußen: Es braucht die Knowledge Base, und die gibt es in Cursor nicht.

   Es merkt sich außerdem den aufgelösten Pfad deines Node in `~/.config/pecker-nest/cursor-node`. Cursor startet Hooks ohne deine Shell, und `command -v node` zeigt bei fnm in ein Verzeichnis, das mit der Shell verschwindet. Nach einem Node-Update oder `fnm uninstall` den Befehl wiederholen. Drei der Hooks blockieren bei einem Fehler (`failClosed`): Findet der Hook kein Node, lehnt Cursor jeden Befehl und jeden Dateizugriff ab und nennt den Befehl zum Reparieren.

2. Cursor mit Cmd+Q beenden und neu starten. Unter Customize → Hooks stehen danach sechs Hooks.

3. Dem Gate die Repos freigeben, in denen es laufen darf. Das Gate führt den Befehl aus `.pi/gate.json` mit deinen Rechten aus, deshalb läuft es nur in Repos auf dieser Liste. Die Sicherheitsregeln gelten überall. In bash, zsh und fish gleich:

   ```bash
   ~/dev/pecker-nest/scripts/cursor-trust.sh add ~/dev/undertext
   ~/dev/pecker-nest/scripts/cursor-trust.sh add ~/dev/pecker-grove
   ~/dev/pecker-nest/scripts/cursor-trust.sh list
   ```

   Ein Worktree, den Cursor mit `/worktree` aus einem freigegebenen Repo anlegt, gilt mit als freigegeben. Entfernen: `cursor-trust.sh remove <pfad>`.

4. Die User Rule einfügen: Cursor → Settings → Rules → User Rules, Inhalt von `cursor/user-rule.md`. Zum Kopieren, in allen Shells gleich:

   ```bash
   pbcopy < ~/dev/pecker-nest/cursor/user-rule.md
   ```

5. Prüfen, in allen Shells gleich:

   ```bash
   ~/dev/pecker-nest/scripts/doctor.sh --cursor
   ```

   Die Zeilen mit `cursor:` sollten `PASS` zeigen. Ein `WARN` für `nest-supervise` und `nest-handoff` ist erwartet, solange die Links von `--claude` noch bestehen: Cursor liest `~/.claude/skills/` mit und zeigt die beiden Skills deshalb doppelt.

Jede Entscheidung steht als eine Zeile in `~/.local/state/pecker-nest/cursor/log.jsonl`: Zeit, Hook, Repo, Entscheidung, Regel, beim Gate Ergebnis, Runde und Zahl der Befunde. Keine Befehle, Prompts, Dateiinhalte oder Ausgaben. Die letzten Zeilen, in allen Shells gleich: `tail -n 20 ~/.local/state/pecker-nest/cursor/log.jsonl`.

### Was abgedeckt ist

| Hook | Was er tut |
| --- | --- |
| `beforeShellExecution`, `preToolUse` auf `Shell` (failClosed) | Dieselben Regeln wie nests Safety-Gate, gegen die `.pi/protect.json` jedes Workspace-Ordners. Jeder `git push` wird abgelehnt, auch der des eigenen Branches (siehe Runbook, „Entschieden“). Dazu gesperrt: `scripts/link.sh` und `scripts/cursor-trust.sh`, weil sie die Hooks austauschen oder ein Repo freigeben würden. |
| `preToolUse` auf `Write`, `Delete` und weitere Schreib-Tools (failClosed) | Nests geschützte Pfade (Secrets, `.env*`, `.git/`, `.pi/`, `write`-Globs), dazu die Harness: dieses Repo, `~/.cursor/` (außer `~/.cursor/worktrees/`), `~/.config/pecker-nest/`, `~/.local/state/pecker-nest/`, Pis und Claude Codes Verzeichnisse, sowie in jedem Repo `.cursorignore`, `.cursor/hooks.json`, `.cursor/hooks/` und `.claude/settings*.json`. Auf dem Mac in jeder Schreibweise (`.Cursor/hooks.json`, `.PI/gate.json`, `.ENV`), weil APFS Groß- und Kleinschreibung nicht unterscheidet; Pis Safety-Gate vergleicht dort genauso. |
| `preToolUse` auf `Read` und `Grep`, `beforeReadFile` (failClosed), `beforeTabFileRead` | Lesen von Dateien, die `.pi/protect.json` unter `read` schützt, immer nach den Regeln des Repos, in dem die Datei liegt. Eine Grep-Suche wird abgelehnt, sobald sie eine solche Datei erreichen kann; die Meldung nennt die Datei, und der Agent sucht dann enger (Pfad oder Glob). Eine Inhaltssuche ohne Pfad und ein Glob, der aus dem Ordner führt, werden ebenfalls abgelehnt. |
| `beforeSubmitPrompt`, `stop` | Das Quality Gate: wie in nest, mit Prüfung auf abgeschwächte Tests und höchstens `maxRepairRounds` Reparaturrunden (in Cursor höchstens 4). Ist es nach den Runden noch rot, kommt eine letzte Nachricht an den Agenten, die ihm sagt, nichts mehr zu ändern und dir das Ergebnis mit allen Befunden zu berichten; `stop` kann dir selbst nichts anzeigen, und nach der letzten Nachricht ruft Cursor `stop` nicht mehr auf. Ein freigegebenes Repo, das der Agent ändert, ohne dass Cursor es als Workspace-Ordner meldet (nach einem Worktree oder im Multi-root-Fenster), nimmt das Gate mit. |

### Bekannte Lücken

- **`.cursorignore` schützt nichts.** Im Capture las der Agent eine ignorierte Datei trotzdem: Read über einen Umweg, Grep „by reading it directly“, `cat` in der Sandbox. Der Leseschutz hängt allein an den Hooks; `.cursorignore` ist keine zweite Schicht.
- **Keine Bereinigung der Ausgabe.** nest entfernt aus der Ausgabe von grep, find, ls und bash die Zeilen, die eine geschützte Datei nennen. Cursor erlaubt das nur für MCP-Tools. Deshalb lehnt der Adapter eine Grep-Suche ganz ab, statt sie zu filtern, und Befehle wie `ls` oder `find`, die nur Dateinamen zeigen, laufen durch.
- **Befehle sind ein Stolperdraht, keine Sandbox**, wie in nest: `cd evals && cat "$(ls)"` kommt durch.
- **Cloud Agents** führen Hooks auf Benutzerebene nicht aus.
- **Die CLI im Headless-Modus** (`agent -p`) kennt kein `stop` und kein `beforeSubmitPrompt`, also kein Gate. Die interaktive CLI ist nicht getestet.
- **Multi-root:** Im Capture meldete Cursor den Hooks nur einen Ordner. Lesen und Schreiben mit Pfad prüft der Adapter trotzdem nach den Regeln des richtigen Repos, eine Dateisuche ohne Pfad aber nur gegen den gemeldeten Ordner: Sie kann Dateinamen aus dem anderen Ordner zeigen.
- **MCP-Tools** prüft der Adapter nicht.
- **Dieses Repo selbst** zählt in Cursor zur Harness. Solange das so bleibt, kann der Agent in Cursor `pecker-nest` nicht bearbeiten (offen, siehe [v1-notes.md](v1-notes.md)).

### Rückgängig machen

In allen Shells gleich:

```bash
rm ~/.cursor/hooks.json ~/.cursor/agents/reviewer.md
rm ~/.agents/skills/grill-me ~/.agents/skills/testing-ts ~/.agents/skills/testing-py
ls ~/.cursor/hooks.json.bak.*    # eine frühere hooks.json, falls es eine gab
```

Danach Cursor neu starten. Die Trust-Liste (`~/.config/pecker-nest/cursor-trusted`) und das Log bleiben liegen, bis du sie löschst.

## Häufige Probleme

| Meldung oder Symptom | Ursache und Lösung |
| --- | --- |
| `link.sh`: „this repo must live at ~/dev/pecker-nest“ | Falscher Klon-Pfad. Verschieben, oder `ln -s <klon> ~/dev/pecker-nest`. |
| Modell fehlt in `/model` | Dein Konto lässt es nicht zu, meist wegen ZDR. Auf der Modellseite bei OpenRouter prüfen, welche Provider ZDR anbieten. Danach `pi update --models`. |
| „No endpoints found …“ beim Senden | Mit ZDR und `require_parameters` bleibt kein Provider übrig. Beim starken Modell weicht der Router selbst auf GLM 5.3 oder Flash aus und sagt es. Runbook, Abschnitt „Wenn Anfragen scheitern“. |
| „gate.json ignored: this project is not trusted“ | In dem Repo `/trust` ausführen. |
| Ein Befehl wird mit „Blocked by safety-gate“ abgelehnt | Absicht. Wenn du ihn wirklich willst, führ ihn selbst aus: `!befehl` in Pi oder im Terminal. |
| Beim Start: „MCP servers need attention: kb …“ | Die Knowledge Base (pecker-grove) läuft nicht oder Pi ist dort nicht angemeldet. Pi arbeitet ohne sie weiter. `~/dev/pecker-nest/scripts/doctor.sh` nennt in der Zeile `knowledge base:` den passenden Befehl; Runbook, M3. |
| `pi-run.sh`: „error: no container key …“ | Der Container-Key fehlt im Schlüsselbund (Schritt 6). Ein exportierter `OPENROUTER_API_KEY` zählt absichtlich nicht. |
| `pi-run.sh`: „image pecker-nest-pi is stale …“ | Das Image stammt nicht vom aktuellen Commit, hat kein Label (mit `docker build` von Hand gebaut) oder wurde mit uncommitteten Änderungen gebaut. `~/dev/pecker-nest/scripts/build-image.sh` ausführen; liegt es an `agent/settings.json`, vorher `git checkout agent/settings.json`. Bewusst trotzdem starten: `env PI_RUN_ALLOW_STALE_IMAGE=1 …/pi-run.sh …`. |
| Cursor lehnt jeden Befehl ab: „the hook cannot start Node“ | Das Node, das `link.sh --cursor` sich gemerkt hat, gibt es nicht mehr (Node-Update, `fnm uninstall`). `~/dev/pecker-nest/scripts/link.sh --cursor` erneut ausführen; `scripts/doctor.sh --cursor` zeigt den Pfad. |
| Cursor: „Blocked by pecker-nest: a search under … can reach …“ | Absicht: Die Suche würde eine Datei erreichen, die `.pi/protect.json` unter `read` schützt, und Cursor kann die Treffer nicht herausfiltern. Der Agent sucht enger, mit Pfad oder Glob. |
| Cursor: das Gate läuft nicht | Das Repo steht nicht auf der Trust-Liste (`scripts/cursor-trust.sh list`), hat keine `.pi/gate.json`, oder der Turn hat nur Doku geändert. Das Log (`~/.local/state/pecker-nest/cursor/log.jsonl`) nennt den Grund als `rule`. |
| `pi-run.sh` meldet `models exit: 1` | Die Modellliste ließ sich nicht laden (keine Verbindung zu `pi.dev` oder `openrouter.ai`). Der Lauf geht mit Pis eingebautem Katalog weiter. |

## Rückgängig machen

Zurück zu deiner alten Pi-Konfiguration:

Zuerst die Symlinks entfernen. In bash oder zsh:

```bash
cd ~/.pi/agent
for f in settings.json models.json APPEND_SYSTEM.md mcp.json; do [ -L "$f" ] && rm "$f"; done
```

In fish:

```fish
cd ~/.pi/agent
for f in settings.json models.json APPEND_SYSTEM.md mcp.json; test -L $f; and rm $f; end
```

Der Rest ist in allen drei Shells gleich:

```bash
find prompts -type l -lname '*pecker-nest*' -delete
ls *.bak.*                                       # deine gesicherten Dateien
mv settings.json.bak.<zeitstempel> settings.json  # je Datei, die du zurückhaben willst
```

Die Supervision-Skills (alles Symlinks, in allen drei Shells gleich): `rm ~/.claude/skills/nest-supervise ~/.claude/skills/nest-handoff`, ebenso unter `~/.cursor/skills/` und `~/.pi/agent/skills/`, je nachdem, wohin du sie verlinkt hast. Den Container-Key aus dem Schlüsselbund: `security delete-generic-password -a "$USER" -s pecker-nest-container-key`.

Container-Reste entfernen: `docker rmi pecker-nest-pi` und `docker volume rm pecker-nest-sessions`.
