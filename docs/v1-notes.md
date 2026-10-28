# V1 – Abweichungen vom Plan und Befunde

Stand 28.10.2026, Pi 1.4.0 (`@earendil-works/pi-coding-agent`; das alte Paket `@mariozechner/pi-coding-agent` ist abgekündigt). Grundlage sind die Docs und Typdeklarationen aus dem npm-Paket. pi.dev selbst war aus der Build-Umgebung nicht erreichbar.

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

## Was die Tests gefunden haben

Die End-to-End-Tests (echtes Pi gegen einen Anthropic-Mock) haben drei Fehler aufgedeckt, die behoben sind:

- **`.txt` galt als Dokumentation.** Änderungen an `requirements.txt` hätten den Check nicht ausgelöst. Jetzt gelten nur `.md`, `.mdx`, `.markdown`, `.rst` und `.adoc` als reine Doku.
- **`canContinue` als Vorbedingung war falsch.** Im Print-Modus meldet Pi beim Settle `canContinue: false`, die Fortsetzung mit eigener Nachricht funktioniert trotzdem. Ohne den Fix wären die Reparaturrunden headless ausgefallen.
- **Docker unter Linux:** Mit Host-uid ≠ 1000 konnte der Agent im gemounteten Repo nicht schreiben, und das Gate-Log ließ sich nicht anlegen. Behoben durch Läufe als Host-uid und Logs über stderr.

Außerdem bestätigt:

- **Router:** Für Claude 5.5 schickt Pi die Denkstufe als Nachricht innerhalb der Konversation (`supportsMidConvoEffort`), nicht nur als Request-Parameter.
- **Gemessene Abfolge:** Opus high, Opus high, nach der ersten Code-Änderung Sonnet medium. Ein neuer Prompt bleibt auf Sonnet, `/plan` geht zurück auf Opus.
- **Subagents:** `scout`, `planner`, `worker` und `reviewer` laufen auf Haiku, Opus, Sonnet und Opus. Der Reviewer hat weder `edit` noch `write` noch `bash`. Im Worker blockiert das Safety-Gate `rm -rf`.

## Modelle

Laut Pi-Katalog 1.4.0 (Provider `anthropic`, alle 1M Kontext, 128K Output; Preise in USD je Million Tokens, Input/Output):

| Modell | ID | Input / Output |
| --- | --- | --- |
| Opus 5.5 | `claude-opus-5-5` | 4 / 20 |
| Sonnet 5.5 | `claude-sonnet-5-5` | 2 / 10 |
| Haiku 5.5 | `claude-haiku-5-5` | 0,10 / 0,50 |
| Fable 5.1 | `claude-fable-5-1` | 10 / 50 |

Der Router bildet die gewählte Denkstufe so ab: Opus plant auf der gewählten Stufe, Sonnet baut eine Stufe tiefer (high → Opus high, Sonnet medium). Angeboten werden `medium`, `high` und `xhigh`.

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

Geprüft wurde Version 0.83.1 (npm, Quelle `github.com/nicobailon/pi-subagents`, veröffentlicht am 28.10.2026 per GitHub Actions). Kein vollständiges Audit des 4-MB-Bundles, sondern eine gezielte Prüfung:

- **Keine Install-Hooks:** keine `scripts` in `package.json`. `install.mjs` läuft nur bei `npx pi-subagents`, nicht bei `pi install`.
- **Netzwerk:** keine fest eingebauten Endpunkte außer GitHub-Links. Ein Gist wird nur mit `share: true` angelegt (über `gh gist create`).
- **Kindprozesse:**
  - immer: `git` (Worktrees, Diffs), `ps` und `npm root -g`
  - nur wenn diese Profile gewählt werden: externe CLIs (`claude`, `codex`, `cursor-agent`). Sie sind deaktiviert.
- **Peer-Dependencies:** sauber deklariert; Laufzeit-Abhängigkeiten sind gepinnt.

Deaktiviert in `settings.json`: `researcher` und `evidence-auditor` (bräuchten `pi-web-access`) sowie alle sechs Profile für externe CLIs. `oracle` und `delegate` bleiben und laufen standardmäßig auf Sonnet (`subagents.defaultModel`), weil Kinder den virtuellen Router nicht laden.

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
- **Der `apt-get`-Schritt im `Dockerfile.pi`:** Die Debian-Mirrors waren aus der Build-Umgebung gesperrt. Getestet wurde eine Variante auf `node:24-bookworm` (git und python3 vorinstalliert) mit identischen übrigen Schritten. Beim ersten Build auf deinem Rechner läuft der apt-Schritt zum ersten Mal.
- **macOS-Besonderheiten:** Docker Desktop und Bash 3.2. Die Skripte sind auf Bash 3.2 ausgelegt, liefen aber nur unter Linux.
- **Interaktive TUI:** Fußzeile, `/subagents-fleet` und Benachrichtigungen. Getestet wurden Print-, JSON- und RPC-Modus.
