# V1 – Abweichungen vom Plan und Befunde

Stand 25.11.2026, Pi 1.5.0 (`@earendil-works/pi-coding-agent`; das alte Paket `@mariozechner/pi-coding-agent` ist abgekündigt). Die Abschnitte stehen in umgekehrter Reihenfolge: zuerst das Update vom 25.11. (Stand der Knowledge-Base-Quellen), dann das vierte vom 24.11. (Kontext und Kosten am Stamm des Spechts), dann das dritte vom 24.11. (Specht nur noch auf der Sitzstange), dann das zweite vom 24.11. (Sitzstange für den Specht), dann das erste vom 24.11. (nest als Standard-Herkunft im Review), dann das vom 21.11. (Review pro Pull Request), dann das zweite vom 18.11. (Review des Cursor-Adapters), dann das erste vom 18.11. (Cursor-Adapter), dann das vom 17.11. (Supervision-Skills für Cursor und Pi), dann der Nachtrag vom 15.11. (Übergabe vom 10.11. auf dem Mac nachgeprüft), dann das Update vom 15.11. (eigenes Metadata Document), dann das vom 12.11. (Knowledge Base), dann das zweite Update vom 10.11. (Messung, Supervision-Skills, Prüfung auf abgeschwächte Tests), dann das erste vom 10.11. (Setup-Härtung und Modell-Passung), dann das vom 08.11. (Kimi K3.1 Pro als Ersatzmodell), dann Strategie A vom 07.11., dann der Teil vom 30.10. (Update „GLM 5.3 & DeepSeek über OpenRouter“). Grundlage sind die Docs, der Quellcode und die Typdeklarationen aus den npm-Paketen. pi.dev selbst war aus der Build-Umgebung nicht erreichbar.

## Update 25.11.2026: Stand der Knowledge-Base-Quellen (docs/tasks/kb-sources-status.md)

Auftrag aus dem Planungschat: David weiß nie, welchen Stand seiner Notiz-Repos nest über `kb` sieht. grove indexiert den Arbeitsbaum der Checkouts; ein offener Pull Request, ein Feature-Branch, ein Checkout hinter `origin`, uncommittete Notizen, eine übersprungene Notiz oder ein gescheiterter Ingest bleiben unsichtbar. grove meldet künftig mit dem MCP-Tool `index_status`, was es indexiert hat (davidkutt/pecker-grove#82). Die andere Hälfte, was indexiert sein *sollte*, kommt vom Mac, wo git, `gh` und das Netz sind.

**Was sich ändert, Teil 1 (braucht nichts von grove):**

- `scripts/kb-sources.sh` (neu, bash): liest aus `${GROVE_DIR:-~/dev/pecker-grove}/.env` nur die Zeilen `NOTES_DIR=` und `NOTES_SOURCES=` (per `grep`, nie per `source`) und bildet die Labels wie grove. Je Ordner mit `.git`: Branch und Commit, uncommittete und ungetrackte Notizen (`git status --porcelain --untracked-files=all -- '*.md'`), Default-Branch und Commit des Remotes (`git ls-remote --symref origin HEAD`, höchstens 10 Sekunden), offene Pull Requests (`gh pr list --repo <owner/repo> --state open --json number,title,headRefName`), dazu `problems` und `fixes`. Eine Zeile je Label für Menschen, `--json` für `doctor.sh` und `/kb-status`. Exit-Code 0 außer bei einem Aufruffehler (2).
- `scripts/doctor.sh`: nach der Zeile `knowledge base:` je Label eine Zeile `kb sources:`. `PASS` auf dem Default-Branch, auf dem Commit des Remotes, sauber und ohne offene Pull Requests; sonst `WARN` mit dem Fix; `WARN … not checked` ohne `.env`, ohne `NOTES_DIR` oder ohne Checkout. Nie `FAIL`, auch nicht, wenn grove nicht läuft.

**Was sich ändert, Teil 2 (für groves `index_status`):**

- `agent/mcp.json`: `toolExposure` bekommt `"index_status": "direct"`. Das Tool hat keine Parameter und hilft genau dann, wenn eine Suche leer zurückkommt.
- `agent/APPEND_SYSTEM.md`, „Knowledge base first“: neue Regel, vor „die Knowledge Base hat nichts dazu“ `mcp__kb__index_status` aufzurufen und einen veralteten oder unvollständigen Index zu nennen. `cursor/user-rule.md` bleibt ohne sie (keine Knowledge Base in Cursor; die Entscheidung steht in `test/cursor-user-rule.test.ts`).
- `skills/best-practices/SKILL.md`: eine Tabellenzeile für `index_status`; Schritt 2 prüft es nach zwei leeren Suchen, bevor er „nichts dazu“ sagt.
- `prompts/kb-status.md` (neu, `/kb-status`): ruft `kb-sources.sh --json` und `index_status` auf und stellt je Label groves Stand neben den des Macs, mit den Fixes in der Reihenfolge des Briefs. Ändert nichts; ohne grove nur die Seite des Macs.
- Subagents bleiben ohne `kb`-Tools (P5).

**Die Konfiguration unter Test ändert sich:** Der System-Prompt nennt `index_status`, und jede Session mit laufendem grove deklariert ein Tool mehr. Feldnotizen von vor und nach diesem Stand sind also nicht direkt vergleichbar; deshalb wird zwischen zwei nest-Sessions gemergt.

**Abweichungen und Ergänzungen zum Brief:**

- `git status` läuft mit `GIT_OPTIONAL_LOCKS=0`. Sonst frischt es den Index auf und schreibt ihn, sobald sich nur der Zeitstempel einer Datei geändert hat; „nichts in den Checkout schreiben“ hielte dann nicht. `--untracked-files=all` dazu, damit Notizen in einem neuen Ordner einzeln erscheinen statt als `ordner/`.
- Ohne Fetch lässt sich „hinter dem Remote“ von „auseinandergelaufen“ nur unterscheiden, wenn der Commit des Remotes im Checkout schon bekannt ist. `relation` ist deshalb `same`, `behind`, `ahead`, `diverged` oder `unfetched` („origin/main has commits this checkout has not fetched“); der Fix für `behind` und `unfetched` ist `pull --ff-only`.
- Offline nimmt das Skript den Default-Branch aus dem Klon (`refs/remotes/origin/HEAD`), damit „nicht auf dem Default-Branch“ auch ohne Netz auffällt (`defaultBranchFrom: "clone"`).
- `ahead` (lokale Commits, die nicht auf dem Remote liegen) und `diverged` sind ebenfalls `WARN`; der Brief nannte sie nicht.
- Die Reihenfolge der Fixes in der Zeile: Notizen committen oder entfernen, `switch`, Pull Requests mergen und danach `pull --ff-only`. Die Zeile von `doctor.sh` nennt Pull Requests nur mit Nummer; die Titel stehen nur in `--json` für `/kb-status`.
- Eine Origin-URL wird nie ausgegeben, nur `owner/repo` daraus: Eine https-URL kann ein Token enthalten. Fehlermeldungen von `git ls-remote` und `gh` gehen nach `/dev/null`.
- macOS hat kein `timeout`; das Skript begrenzt `ls-remote` und `gh` selbst. `KB_SOURCES_TIMEOUT` (Sekunden, Standard 10) gibt es für den Test, der einen hängenden Remote simuliert.
- Die JSON-Antwort von `gh` liest `node`; ohne `node` heißt es „pull requests not checked“.
- Annahmen über groves `.env`, die ich nicht an groves Code prüfen konnte (`apps/api/src/documents/sources.service.ts` war aus dieser Session nicht lesbar): Paare in `NOTES_SOURCES` sind durch Kommas getrennt; ein relativer `NOTES_DIR` liegt in groves Verzeichnis, `~/` ist das Home-Verzeichnis; ein Eintrag ohne `=` bekommt den Ordnernamen als Label. `export`, Anführungszeichen und ein Kommentar hinter dem Wert werden verstanden; gilt ein Schlüssel mehrfach, zählt die letzte Zeile.
- `/kb-status` ist nach der Feldliste des Briefs geschrieben. groves Vertrag (`docs/tasks/sources-status.md` in pecker-grove) konnte ich nicht lesen; die Feldnamen von `index_status` außer `intervalMinutes` nennt der Prompt deshalb nicht wörtlich.
- `test/doctor.test.ts`: Der Test „leaves Docker alone without --docker“ zählte genau eine Warnung. Ohne groves `.env` im Test-HOME kommt die Zeile `kb sources: not checked` dazu; er zählt jetzt zwei und prüft beide Zeilen.

**Getestet:** `npm ci`, `npm run check` (662 Tests. Neu in `test/doctor.test.ts` 14 für `kb-sources.sh` und die Zeilen `kb sources:`: sauber → `PASS`; nicht auf dem Default-Branch und mit losgelöstem HEAD; hinter, `unfetched`, auseinandergelaufen, voraus; uncommittete und ungetrackte Notizen, nur `*.md`; zwei offene Pull Requests mit Anführungszeichen, Backslash, Tab und Umlauten im Titel; Remote nicht erreichbar und Remote hängt (Abbruch nach 1 s, Default-Branch aus dem Klon); ohne `gh`, ohne `gh`-Login, Remote nicht auf GitHub; ohne `.env`, ohne `NOTES_DIR`, `GROVE_DIR`, Ordner fehlt; `NOTES_SOURCES` mit zwei Labels; Canary-Test mit `OPENROUTER_API_KEY=canary-…`, weiteren Schlüsseln, Doppelgängern wie `NOTES_DIR_BACKUP=` hinter der echten Zeile, einer Zeile mit `$(touch …)` und einem Token in der Origin-URL, für die menschliche Ausgabe, `--json` und `doctor.sh`; der Checkout ist danach Byte für Byte gleich, auch mit veraltetem Zeitstempel im Index; die Form von `--json` ist festgeschrieben; Aufruffehler; der Prompt `/kb-status`. Angepasst: `test/container-config.test.ts` auf der echten `agent/mcp.json` (`index_status` direkt, `ingest_url` versteckt, der Container schaltet `kb` weiter ab), `test/cursor-user-rule.test.ts` (neue Regel: dropped); `PI_BIN=node_modules/.bin/pi npm run e2e` (26 Szenarien, alle mit eingetragenem `kb` ohne laufenden Server; das Szenario zu Test 7 prüft zusätzlich die neue Regel im System-Prompt und dass `tool_search` ohne Server kein `index_status` anbietet). Die Notiz-Checkouts der Tests sind echte Repos, deren GitHub-Origin git per `insteadOf` auf ein lokales Bare-Repo umlenkt; `git` ist das echte hinter einem Stub, der jeden Aufruf aufzeichnet (ein Test prüft, dass im Notiz-Checkout nur lesende Befehle laufen), `gh` ein Stub. Jede neue Schutzregel einmal gebrochen (Index-Schreiben ohne `GIT_OPTIONAL_LOCKS=0`, ein eingeschmuggeltes `git fetch`, `source` der `.env`, ausgegebene Origin-URL, zu lockeres Schlüsselmuster): die Tests werden jeweils rot.

**Nicht getestet:** macOS-bash 3.2 und Apples git (nur bash 5.2 und git 2.43 unter Linux; das Skript vermeidet, was 3.2 nicht kann, etwa leere Arrays unter `set -u`); `git ls-remote` gegen GitHub selbst und ein echtes `gh pr list` (nur lokal und Stub); `index_status` gegen grove (#82 ist nicht gemergt) und damit `/kb-status` in einer Pi-Session; groves Labels aus `NOTES_SOURCES` gegen groves eigenen Code; die TUI.

## Update 24.11.2026 (viertes): Kontext und Kosten am Stamm des Spechts (docs/tasks/bird-meter.md)

Auftrag aus dem Planungschat: Der Stamm zeigt, wie nah die Session an Pis Auto-Kompaktierung ist, Sprechblasen und Fußzeile zeigen Kontext und Kosten, und `/meter` nennt die Zahlen. Die Entscheidungen stehen im Runbook („Entschieden“, 24.11., „Specht: Meter“ bis „Specht: was er liest“). Warum: nest reserviert 800k Tokens für die Kompaktierung, Pi 1.5.0 kompaktiert also bei Fenster des gerouteten Modells minus Reserve des gewählten Modells, bei 248.576 Tokens, rund 24 % des Fensters. Pis Fußzeile rechnet gegen das ganze Fenster und wird erst bei 70 % davon gelb.

**Was sich ändert:**

- `extensions/lib/bird-meter.ts` (neu): der Kompaktierungspunkt in Pis Reihenfolge (Override des gewählten Modells, dann `compaction.reserveTokens`, dann Pis 16.384), Füllstand und Stufen, die zehn Felder des Stamms, die Hinweise bei 70 und 90 %, die Kostensumme nach den Regeln von Pis Fußzeile, die Texte für `/meter` und `nextMeter`, ein Zustandsautomat wie `next()` für den Vogel.
- `extensions/lib/bird-perch.ts`: Mit einer Meter-Ansicht wird die Rinde zur Anzeige (`#` von unten in Theme-Farbe, frei ein gedimmtes `:`), das Loch liegt darüber. Die Blase zeigt die Hinweise, die Kosten des Laufs und nach grünem Gate ab 70 % `/compact? (78%)`; eine Kompaktierung lässt 1,5 s lang Späne von jeder Zeile des Stamms fallen. Ohne Meter-Ansicht zeichnet sie wie bisher, die alten Tests laufen unverändert.
- `extensions/lib/bird.ts`: `footer` hängt ab 50 % `ctx N%` an.
- `extensions/bird.ts`: liest Kontext, Kosten und Kompaktierungs-Einstellungen bei Events, nie pro Frame, auch bei `/bird off`; neuer Befehl `/meter` (`/meter context`, `/meter cost`).

**Befund:** Pi 1.5.0 gibt `message_end` und `tool_execution_end` an Extensions weiter, bevor es die Nachricht speichert (Extensions dürfen sie dort noch ersetzen), und das Tool-Ergebnis kommt erst nach `tool_execution_end`. Wer dort `ctx.getContextUsage()` liest, sieht die neue Nachricht nicht; vor der ersten Antwort zählt Pis Schätzung dann den System-Prompt mit. Im tmux-Test meldete der Specht so schon bei der ersten Antwort `context 117% - compaction soon`. Er liest deshalb bei `tool_execution_start` (agent-core wartet jedes Event ab, die Antwort, die das Tool aufruft, ist dann gespeichert) und bei `turn_end` (Pi hat Antwort und Tool-Ergebnisse gespeichert und ihre IDs aufgelöst), dazu wie geplant bei `agent_settled`, `session_compact`, `model_select` und `session_tree`. Das weicht von der Event-Tabelle im Brief ab; der Zeitpunkt ist praktisch derselbe.

**Kleinere Abweichungen vom Brief:**

- Prozente sind gerundet wie in Pis Fußzeile, und die Stufen richten sich nach der gerundeten Zahl: Eine angezeigte 70 ist immer gelb, eine 69 nie.
- `compacted from 241k` bleibt wie jeder Hinweis 4 s stehen, die Späne fallen 1,5 s. Solange sie fallen, geht der Hinweis allem vor, danach gilt die Reihenfolge der Hinweise. Zwischen den Läufen steht ein Hinweis 4 s lang vor dem Ergebnis, etwa `compaction failed` nach einem manuellen `/compact`.
- Beim Start oder Fortsetzen einer Session gibt es keinen Hinweis, auch wenn sie schon über einer Linie liegt; Stamm und Fußzeile zeigen den Stand.
- `/meter context` nennt die Quelle der Reserve: den Modellschlüssel bei einem Override, sonst `compaction.reserveTokens` oder `Pi default`. Ohne Modell oder Fenster sagt es `context unknown: no model with a context window`.
- `getEntries()` wird nicht nach Anzahl gecacht: Der Specht liest nur bei Events, und `ReadonlySessionManager` bietet kein `getEntryCount()`.

**Getestet:** `npm ci`, `npm run check` (648 Tests; neu `test/bird-meter.test.ts` mit 34, `test/bird-perch.test.ts` von 21 auf 35, `test/bird.test.ts` von 16 auf 17), `PI_BIN=node_modules/.bin/pi npm run e2e` (26 Szenarien). Dazu das echte Pi 1.5.0 interaktiv in tmux (`xterm-256color`, 100 Spalten) gegen eine Kopie des Mocks außerhalb des Repos, die Tokens nach Länge der Unterhaltung und Kosten meldet, mit Kompaktierungspunkt 3.000 Tokens: der Stamm füllt sich von unten, die Fußzeile geht von `ctx 54%` bis `ctx 112%` (Felder und Fußzeile gelb bei 73 und 87 %, rot ab 100 %), die Hinweise `context 80% of 3.0k` und `context 99% - compaction soon`, `GLM 5.3 is thinking... $0.022` (der Router eskalierte nach drei gleichen Reads), `gate green. /compact? (85%). $0.065. pecked 1`, eine echte Kompaktierung mitten im Lauf (Späne links und rechts vom Stamm, `compacted from 3.4k`, Stamm frei, nach der nächsten Antwort wieder bekannt), ein manuelles `/compact` (danach bleibt der Stamm unbekannt, `/meter context` sagt `context unknown until the next answer (just compacted)`), `compaction failed` bei abgelehnter Zusammenfassung, `/meter`, `/meter context`, `/meter cost`, `/meter budget` (Nutzungszeile), ein ganzer Lauf bei `/bird off` (danach `/meter cost` mit `last run`), `/bird on`. Die Sitzungskosten von `/meter` stimmten mit Pis Fußzeile überein.

**Nicht getestet:** Apple Terminal selbst; echte Token-Zahlen und Kosten von OpenRouter (nur der Mock); eine Kompaktierung wegen Überlaufs (` (overflow)`, nur im Unit-Test); `/tree` und Modellwechsel (`session_tree`, `model_select`) im echten Pi; Kosten von Subagents in Tool-Ergebnissen (nur im Unit-Test); der Farbton `muted` der Fußzeile zwischen 50 und 69 % (nur im Unit-Test); ein RPC-Client.

## Update 24.11.2026 (drittes): Specht nur noch auf der Sitzstange

Davids Wünsche nach der Sitzstange: ein längerer Schnabel, und der alte kleine Vogel `(o>` soll weg. Die Entscheidung steht im Runbook („Entschieden“, 24.11., „Specht: nur die Sitzstange“).

**Was sich ändert:**

- `extensions/lib/bird-perch.ts`: Der Schnabel ist zwei Zeichen lang, `( @ =>` zum Stamm hin, `<= @ )` beim Herausschauen. Stamm, Späne und Sprechblase rücken dafür eine Spalte nach rechts; ihre Spalten leiten sich jetzt aus der Breite des Vogels ab. Die Blase erscheint damit erst ab 33 statt 32 Spalten, die Sitzstange selbst weiter ab 18.
- `extensions/lib/bird.ts`: Die Bilder für Pis Arbeitsanzeige (`indicator`, `allFrames`, `FRAME_WIDTH`) sind weg. `footer` liefert nur noch Text, ohne Vogel: `GLM 5.3 repair 1/2`, `gate ok 14s Kimi K3.1 Pro`, `gate red`, `stopped`, `done`; vor dem ersten Lauf und während eines Laufs auf Flash ohne Reparaturrunde nichts.
- `extensions/bird.ts`: Im interaktiven Modus blendet er den Spinner der Arbeitsanzeige aus (`setWorkingIndicator({ frames: [] })`), Pi zeigt dort nur noch „Working“. `/bird off` holt Pis eigenen Spinner zurück. `/bird minimal` nennt nur noch die Optionen, `PI_NEST_BIRD=minimal` startet wie ohne Variable mit Sitzstange.

**Befund:** Unter 18 Spalten zeichnet die Sitzstange nichts; dann zeigt die Arbeitsanzeige während eines Laufs nur „Working“, ohne Bewegung. Im RPC-Modus fasst der Specht die Arbeitsanzeige nicht mehr an, der Client bekommt Pis Standard.

**Getestet:** `npm ci`, `npm run check` (599 Tests; in `test/bird.test.ts` fallen die Tests der Arbeitsanzeige weg, die der Fußzeile prüfen Text ohne Vogel; `test/bird-perch.test.ts` prüft den neuen Schnabel in jeder Pose und in einem eigenen Test Schnabel und Abstand zum Stamm), `npm run e2e` (26 Szenarien, unverändert). Dazu das echte Pi 1.5.0 interaktiv in tmux (`xterm-256color`, 100 Spalten) gegen den Mock, mit 2,5 s Verzögerung je Antwort: ein Lauf mit Lesen, Write, `bash` und grünem Gate (Sitzstange in allen Posen mit dem langen Schnabel, Arbeitsanzeige nur „Working“, danach Fußzeile `gate ok 2s`), ein Lauf nach `/hard` (Fußzeile `done GLM 5.3`), `/bird minimal` (nennt die Optionen), `/bird off` (Sitzstange und Fußzeile weg, im nächsten Lauf Pis Spinner), `/bird on` (der Specht schaut heraus, weil gerade getippt wurde).

**Nicht getestet:** Apple Terminal selbst; der rote Vogel mit `GLM 5.3 is thinking` im echten Pi (nur im Unit-Test; im tmux-Lauf kam die Antwort zwischen zwei Abgriffen); `PI_NEST_BIRD=off` und `PI_NEST_BIRD=minimal` beim Start; ein RPC-Client.

## Update 24.11.2026 (zweites): Sitzstange für den Specht (docs/tasks/bird-deluxe.md, L1)

Der Specht (`extensions/bird.ts`) zeigt seit dem 24.11. in Pis Arbeitsanzeige und Fußzeile, was der Agent tut; einen eigenen Abschnitt hatte er hier noch nicht. Jetzt bekommt er eine Sitzstange: ein Widget mit fünf Zeilen über dem Editor, immer sichtbar. Sie ist die erste von vier Stufen im Brief. Die Entscheidungen stehen im Runbook („Entschieden“, 24.11.): nur ASCII, Apple Terminal, Sitzstange über dem Editor, kein Ton.

**Was neu ist:**

- `extensions/lib/bird-perch.ts` zeichnet die Sitzstange als reine Funktion aus dem Zustand des Spechts und einer Uhr: wann die Pose begann, wann er zuletzt etwas zu tun hatte, wann zuletzt eine Taste kam. Die Posen sind die der Arbeitsanzeige: denken (blinzeln), lesen (Kopf dreht sich weg), schreiben (ausholen, zuschlagen, zurück), `bash` (trommeln), Gate (Schnabel am Stamm, lauschen). Jeder Edit des Laufs vertieft ein Loch im Stamm (`.` `o` `O` `()`). Jeder Schlag wirft ein oder zwei Späne, die nach einer festen Formel fliegen und fallen, ohne Zufall. Die Sprechblase zeigt nur Zahlen: `tap tap - peck 3`, `repair 1/2 - hold on`, nach dem Lauf `gate green in 41s. pecked 3, drummed 5`. Zwischen den Läufen blinzelt er, zeigt das Ergebnis im Auge (`^` nach grün, `x` nach rot), schläft nach fünf Minuten ein und schaut nach einem Tastendruck zwei Sekunden zu dir.
- `extensions/lib/bird.ts`: `BirdState` zählt die Tool-Aufrufe des Laufs (`tally`: schauen, picken, trommeln); `birdColor` ist exportiert.
- `extensions/bird.ts` registriert die Sitzstange per `ctx.ui.setWidget` nur im interaktiven Modus (`ctx.mode === "tui"`; im RPC-Modus ignoriert Pi Komponenten ohnehin). Die Komponente hat eine eigene Uhr und fordert nur dann ein Neuzeichnen an, wenn sich ihre Zeilen ändern. Der Timer hält Pi nicht am Leben (`unref`) und endet mit `dispose`. Von Tastendrücken (`onTerminalInput`) nimmt sie nur den Zeitpunkt und gibt nichts zurück, verschluckt also nichts. `/bird on|minimal|off`, `PI_NEST_BIRD=minimal|off`.

**Befund:** Gezählt werden Tool-Aufrufe, nicht gelungene Änderungen. Ein Edit, den Pi ablehnt (etwa „No changes made“), vertieft das Loch trotzdem.

**Getestet:** `npm ci`, `npm run check` (604 Tests; neu `test/bird-perch.test.ts` mit 20 Tests: nur ASCII, nie breiter als das Terminal und immer fünf Zeilen bei Breiten von 0 bis 200 für jede Pose und viele Zeitpunkte, Farben je Teil, Posen, Loch, Späne, Sprechblase, Schlafen und Aufwachen; in `test/bird.test.ts` die Zählung des Laufs), `npm run e2e` (26 Szenarien, unverändert). Dazu das echte Pi 1.5.0 interaktiv in tmux (`xterm-256color`, 110 Spalten) gegen den Mock: ein Lauf mit Lesen, Edit, `bash`, Write und grünem Gate, den Bildschirm alle ein bis zwei Sekunden abgegriffen (Sitzstange über dem Editor, Posen, Späne, Lauschen während des Gates, Ergebnis in der Blase); Tippen im Editor (der Specht schaut heraus); `/bird minimal`, `/bird`, `/bird off`, `/bird on`; `PI_NEST_BIRD=minimal`; 30 Spalten (ohne Blase) und 16 Spalten (ohne Sitzstange).

**Nicht getestet:** Apple Terminal selbst (Farben, Flackern beim Neuzeichnen mehrmals pro Sekunde), ein Theme-Wechsel während der Sitzung, das Einschlafen nach echten fünf Minuten (nur im Unit-Test mit gestellter Uhr), lange Sessions.

## Update 24.11.2026: nest als Standard-Herkunft in `/nest-review`

Auf Davids Wunsch braucht ein Review von nests Arbeit kein `--from nest` mehr: Ohne `--from` gilt nest, einen PR aus Cursor kennzeichnet David mit `--from cursor`. Das ändert die Entscheidung „Origin as input … it never guesses“ aus dem Brief (docs/tasks/nest-review.md); die neue steht im Runbook („Entschieden“, 24.11.).

**Was sich ändert:**

- `scripts/nest-review.ts collect`: `--from` ist optional, Standard `nest`. Statt des Abbruchs „origin missing“ gibt es nur noch einen Aufruffehler (Exit-Code 2), wenn `--from` weder `nest` noch `cursor` ist. Die Ausgabe zeigt `Origin: nest (default, no --from)`, die JSON-Ausgabe `originDefault: true`.
- Sicherung gegen einen Cursor-PR, der ohne `--from` als nests Arbeit läuft: Findet `collect` bei angenommenem nest keine Pi-Session im Fenster, bricht es wie bisher ab und nennt dazu `--from cursor`; der Skill fragt David dann, ob Cursor die Arbeit gemacht hat. Liegt im Fenster eine Pi-Session des Repos (etwa Planung), greift das nicht. Dann bleiben die Bestätigung der Sessions durch David und die Warnung vor Cursor-Turns, die Dateien änderten, soweit der Adapter sie geloggt hat.
- `skills/nest-review/SKILL.md`: fragt nicht mehr nach der Herkunft, nur noch nach der Aufgabe.
- Docs: Runbook (Ablauf, „Entschieden“), `docs/HOW-TO-USE.md`, `field-notes/README.md`. Der Brief bleibt, wie er im Planungschat entstand.

**Getestet:** `npm ci`, `npm run check` (562 Tests; angepasst in `test/nest-review.test.ts`: ohne PR genau ein Abbruchgrund, der Hinweis auf `--from cursor` nur bei angenommenem nest, `collect` ohne `--from` als Prozess mit Herkunft nest und der Zeile „default“, `--from pi` mit Exit-Code 2), `npm run e2e` (26 Szenarien, unverändert).

**Nicht getestet:** der geänderte Skill in Cursor und Claude Code, `collect` gegen einen echten PR auf GitHub.

## Update 21.11.2026: Review pro Pull Request (docs/tasks/nest-review.md)

Neuer Skill `nest-review`: Claude prüft nach jedem PR von nest oder Cursor, ob die Aufgabe erfüllt ist, was schlecht lief und an welcher von sechs Stellschrauben es liegt (Config, Anweisungen, Harness-Code, Ziel-Repo, Aufgabenstellung, Umgebung), mit mehreren Fixes samt Aufwand und Nutzen. Er läuft neben `/nest-handoff`, nicht statt. Der Plan steht im Brief, die Entscheidungen im Runbook („Entschieden“, 21.11.).

**Was neu ist:**

- `skills/nest-review/SKILL.md`: Ablauf, die sechs Stellschrauben mit Grenzfällen, festes Ausgabeformat mit einer JSON-Zeile am Ende. Der Skill schreibt nichts; David speichert das Review in `field-notes/reviews/`.
- `scripts/nest-review.ts collect`: liest den PR mit `gh pr view` (nur lesend) und schlägt das Zeitfenster vor, vom Abzweig vom main bis zum letzten Commit. Das Datum des Abzweigs kommt aus dem lokalen git, sonst per `gh api`. Das Skript listet die Pi-Sessions im Fenster mit den PR-Commits darin und der Zahl der Edits und fasst das Log des Cursor-Adapters für das Repo zusammen (Gate-Läufe, Reparaturrunden, Übergaben, Funde, Blockaden, auch aus Cursor-Worktrees des Repos). Dazu liest es CI und den lokalen Checkout und übernimmt die Konfigurationszeile von `field-note.ts`. Es nennt jeden Abbruchgrund (Exit-Code 1) und jede Warnung, mit Zahlen, Daten und Pfaden, ohne PR-Titel, Commit-Nachrichten oder Inhalte.
- `scripts/nest-review.ts patterns`: zählt die Problem-Kennungen je Stellschraube über die gespeicherten Reviews, zeigt Wiederkehrendes und ob eine Kennung nach einem eingetragenen Fix noch auftaucht.
- `scripts/link.sh` verlinkt `nest-review` mit `--claude` und `--cursor`, nicht mit `--pi`. `doctor.sh --cursor` nennt es bei den doppelt sichtbaren Skills mit.

**Wo der Bau vom Plan abweicht:**

- **Problem-Kennungen:** eine feste Liste von 20 Kennungen, die benennen, was schiefging (`tests-not-run`, `scope-creep`, `edit-loop` …), statt einer eigenen Liste je Stellschraube. Die Stellschraube steht im Befund daneben, und `patterns` zählt die Paare. So bleibt sichtbar, wenn dasselbe Problem einmal an den Anweisungen und einmal am Harness lag. Die Kennungen sind englisch wie die Reviews.
- **Ein PR – ein Modell:** Automatisch bricht das Skript nur bei eindeutigem Beleg ab: bei einem Cursor-PR eine Pi-Session, die Dateien änderte und Commits des PRs machte. Alles andere ist eine Warnung, zu der das Review David fragt. Grund: Der `stop`-Hook des Adapters vergleicht den Arbeitsbaum. Läuft ein Cursor-Chat neben nest (Supervision), zählt er nests Änderungen als Änderungen seines Turns. Außerdem kann das Fenster ab dem Abzweig Arbeit an einem anderen PR enthalten.
- **Zeitfenster:** Der Abzweig ist das Datum des Commits, auf dem der erste PR-Commit liegt. Lag `main` dort schon länger, holt das Fenster ältere Sessions herein. Deshalb bestätigt David die Sessions, und Sessions ohne PR-Commits sind markiert.
- **Cursor-Transkript:** Ein eigener Auswerter fehlt. Ort und Format der Transkripte sind nicht erfasst, und der Adapter loggt `transcript_path` nicht. Das Review fragt David nach dem Pfad und zählt selbst.

**Offen, braucht David:**

- Soll der Adapter `transcript_path` mitloggen (ein Pfad, keine Inhalte), damit `collect` das Transkript selbst findet?
- Die Liste der Kennungen nach den ersten Reviews kürzen oder ergänzen.

**Getestet:** `npm ci`, `npm run check` (562 Tests; neu `test/nest-review.test.ts` mit 27 Tests: PR-Felder und Checks, Fenster, Pi-Sessions aus einem Session-Ordner, Cursor-Log mit Worktree und fremdem Repo, jede Abbruch- und Warnregel, Ausgabe ohne Titel und Commit-Nachrichten, gespeicherte Reviews aus Markdown und `.jsonl`, Muster mit Fix, `collect` als Prozess mit einem `gh`-Stub und einem echten git-Repo; angepasst `test/link.test.ts` und `test/doctor.test.ts`), `npm run e2e` (26 Szenarien, unverändert).

**Nicht getestet:** `gh pr view` gegen GitHub (in der Build-Umgebung ist GitHubs GraphQL gesperrt; getestet mit einem Stub in der Form von `gh pr view --json`), `statusCheckRollup` echter PRs, das Log des Cursor-Adapters auf dem Mac, macOS-bash 3.2 für die geänderten Zeilen in `link.sh` und `doctor.sh`, `pbpaste`, der Skill selbst in Cursor: Er ist ein Anweisungstext, getestet ist das Skript, aus dem er seine Fakten nimmt.

## Update 18.11.2026 (zweites): Review des Cursor-Adapters (docs/tasks/cursor-adapter-review.md)

Folge-PR zum Review von #13. Alle Regeln bleiben in `extensions/lib/`; Pi und Cursor bekommen dieselben Änderungen, wo sie dieselben Funktionen nutzen.

**Was sich ändert:**

- **Groß- und Kleinschreibung auf dem Mac (Blocker).** APFS unterscheidet sie standardmäßig nicht, die Regeln verglichen aber case-sensitiv: `.Cursor/hooks.json`, `~/.CURSOR/hooks.json`, `.PI/gate.json`, `.ENV` und `~/DEV/PECKER-NEST/…` kamen durch. `canonicalPath` nimmt jetzt `realpathSync.native` (korrigiert auf dem Mac die Schreibweise der existierenden Pfadteile) und fällt bei einem Fehler auf `realpathSync` zurück. Für Pfadteile, die es noch nicht gibt (`<repo>/.Cursor/hooks.json`), hat `PathPolicy` das neue Feld `caseInsensitive`: Harness-Verzeichnisse, Ausnahmen und Harness-Dateien, die eingebauten Regeln (`.pi`, `.git`, `.env*`, Secret-Namen), die Globs aus `.pi/protect.json` (auch für die Liste der vorhandenen leseschützten Dateien) und `harnessScriptReason` vergleichen dann ohne Rücksicht auf die Schreibweise. Pis Safety-Gate und der Cursor-Adapter setzen es auf `darwin`; die Tests setzen es selbst, damit sie unter Linux laufen. Zusätzlich zum Brief: Auch Programmnamen in Befehlen gelten dann in jeder Schreibweise (`GIT push`, `RM -rf`, `ENV git push`), weil die Shell sie auf APFS unter jedem Namen findet.
- **`sh -lc`, `bash -xc`, `zsh -ic`.** Die Regel für `bash -c "…"` suchte genau `-c` und übersah kombinierte Flags. Sie nimmt jetzt das erste Argument, das auf `-[A-Za-z]*c[A-Za-z]*` passt; das Muster für `bash -c "$(curl …)"` ebenso.
- **GitHub-Schreibzugriffe.** Neu `ghReason`: abgelehnt werden die `gh`-Befehle, die mergen, approven, schließen, kommentieren oder sonst schreiben (Liste im Brief), und `gh api` mit `-X`/`--method` außer GET oder mit `-f`/`-F`/`--field`/`--raw-field`/`--input`. Kurzoptionen dürfen zusammenstehen (`-XPOST`, `-iX PUT`). `gh pr create`, `gh pr view|list|diff|checks`, `gh issue view|list` und `gh api` als GET laufen. Zusätzlich zum Brief: `gh alias set` und `gh alias import`, weil ein Alias jeden dieser Befehle verpacken kann. Log-Regel `gh-write`.
- **Push über Umwege.** `gitReason` lehnt jetzt `git send-pack`, `git subtree … push` und Aliase ab, die pushen oder eine Shell starten (Wert enthält `push` oder beginnt mit `!`): `git -c alias.p=push p` wie im Brief, dazu `git config alias.p push` und `git --config-env alias.p=VAR`, dessen Wert die Regel nicht sieht. Alle Gründe enden auf „the user pushes“ und laufen im Log unter `git-push`. Die User Rule für Cursor hat die Zeile „Never merge, approve, close or comment on pull requests or issues; the user does that.“
- **Das Gate in Cursor führt Repo-Code ohne Sandbox aus.** Der `stop`-Hook startet den Check-Befehl mit Davids Rechten außerhalb von Cursors Sandbox; der Agent kann Tests und `package.json`-Skripte in einem freigegebenen Repo ändern, und ein `git push` darin lief bisher mit Davids Zugangsdaten. `checkEnvironment` in `cursor/lib/gate.ts` setzt jetzt `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS` und `SSH_ASKPASS` auf `/usr/bin/false`, `GIT_SSH_COMMAND=false`, einen leeren `credential.helper` (über `GIT_CONFIG_COUNT`, hinter eigenen Einträgen) und `GH_TOKEN` auf einen Platzhalter, und entfernt `SSH_AUTH_SOCK` und `GITHUB_TOKEN`. Das Environment ist nur ein Stolperdraht, keine Sandbox: Der Code kann weiter Dateien lesen und andere Wege nach draußen nehmen. Eine echte Isolation, etwa mit `sandbox-exec`, ist offen. Ein Check, der selbst Zugangsdaten braucht (eine Abhängigkeit über `git+ssh`), scheitert jetzt im Gate. Pis Quality Gate bleibt, wie es ist: Pi hat keine Sandbox, aus der das Gate herausführen würde.
- **`~/.agents` gehört zur Harness.** `link.sh --cursor` legt Skills nach `~/.agents/skills`, Cursor lädt sie in jede Sitzung, und Pi 1.5.0 liest dasselbe Verzeichnis (`package-manager.js`, `userAgentsSkillsDir`). Es steht deshalb in `harnessDirs`, nicht nur in `cursorHarnessDirs`: Auch Pis Safety-Gate lehnt Schreibzugriffe dort jetzt ab. Die `.agents/skills` eines Repos bleiben beschreibbar.
- **Kleinkram:** `link.sh` trennt Deklaration und Zuweisung des Backup-Namens (SC2155) und hängt die PID an (`<name>.bak.<zeitstempel>.<pid>`). Das e2e-Szenario für `/plan` setzt für seinen Commit eine eigene Identität und läuft jetzt auch ohne globale git-Identität. Dabei aufgefallen und behoben: Mit `PI_BIN=node_modules/.bin/pi` (AGENTS.md) fand der e2e-Runner Pi nicht, weil jedes Szenario Pi im eigenen Repo startet; ein relativer Pfad wird jetzt aufgelöst.

**Hinweis zur offenen Frage im ersten Update vom 18.11. (pecker-nest als Harness in Cursor), nichts geändert:** Ein Cursor-`/worktree` von pecker-nest liegt unter `~/.cursor/worktrees/` und ist schon heute beschreibbar. Die Hooks laufen weiter aus `~/dev/pecker-nest`. Damit lässt sich nest nach dem 06.12. in Cursor weiterbauen, ohne die Harness zu öffnen.

**Offen, braucht David:**

- `gh api -X GET … -f q=…` ist eine lesende Suche, wird aber wie im Brief abgelehnt, weil `-f` vorkommt. Wenn das stört, könnte `-f` mit `-X GET` erlaubt werden.
- Weiter durchlässig, wie jede Befehlsregel ein Stolperdraht: ein Alias über Umgebungsvariablen (`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p`), ein Push-Alias, der schon in Davids git- oder gh-Konfiguration steht, und Skripte, die pushen.
- Echte Isolation des Gate-Befehls (siehe oben).

**Getestet:** `npm ci`, `npm run check` (535 Tests; neu: Schreibweisen in `test/harness.test.ts` und `test/cursor-adapter.test.ts` mit `caseInsensitive: true`, kombinierte Shell-Flags, jeder `gh`- und git-Fall erlaubt und abgelehnt in `test/safety-rules.test.ts`, die Log-Regeln `gh-write` und `git-push`, das Environment des Check-Befehls über ein `env`-Skript, `~/.agents` für Pi und Cursor, die neue Zeile der User Rule), `npm run e2e` (26 Szenarien, auch mit `GIT_CONFIG_GLOBAL=/dev/null`, also ohne globale git-Identität). `shellcheck scripts/link.sh`: SC2155 ist weg, es bleibt der bekannte Hinweis SC2012. Alles unter Linux.

**Nicht getestet:** alles auf dem Mac, vor allem ob `realpathSync.native` dort die Schreibweise korrigiert und ob Cursor `.Cursor/hooks.json` als Projekt-Hook liest (Handschritt 16); macOS-bash 3.2 für die geänderte Zeile in `link.sh`; das Gate-Environment gegen echte Remotes (ein Push über HTTPS und SSH, `gh` mit gespeichertem Login); `git --config-env` mit getrenntem Argument gegen ein echtes git.

## Update 18.11.2026: Cursor-Adapter (Teil 2 von docs/tasks/cursor-adapter.md)

In Cursor gelten jetzt nests Sicherheitsregeln und das Quality Gate, aus denselben `.pi/protect.json` und `.pi/gate.json`. `scripts/link.sh --cursor` installiert sechs Hooks auf Benutzerebene (`cursor/hooks.json`), den Reviewer-Subagent und drei Skills; `scripts/cursor-trust.sh` führt die Repos, in denen das Gate läuft; `scripts/doctor.sh --cursor` prüft die Installation. Die Hooks übersetzen nur: Jede Entscheidung kommt aus `extensions/lib/`. Grundlage sind die Befunde in [research/cursor-hooks.md](research/cursor-hooks.md) und Davids Capture vom 17.11. (Cursor 3.30.14, „Auto Review (with Sandbox)“) mit seiner Auswertung vom 18.11. Setup und Lücken: [SETUP.md](SETUP.md), Abschnitt 8; Handschritte: [cursor-handschritte.md](cursor-handschritte.md).

**Neu in `extensions/lib/`, Pis Verhalten unverändert:**

- `harness.ts`: was zur Harness zählt. Pis Safety-Gate holt seine drei Verzeichnisse jetzt von dort (dieselben wie vorher); Cursor bekommt dazu `~/.cursor/`, `~/.config/pecker-nest/` und `~/.local/state/pecker-nest/`, die Konfigurationsdateien `.cursorignore`, `.cursor/hooks.json`, `.cursor/hooks/` und `.claude/settings*.json` in jedem Repo, und eine Regel gegen Befehle, die `scripts/link.sh` oder `scripts/cursor-trust.sh` aufrufen.
- `safety-rules.ts`: `PathPolicy` hat drei optionale Felder (`harnessFiles`, `harnessExceptions`, `agent`), die Pi nicht setzt, und die neue Regel `searchReadReason` für Suchen, deren Ausgabe sich nicht filtern lässt.
- `gate-message.ts`: die Texte des Gates (Reparaturrunde, Übergabe, Runde ohne Änderung), wörtlich aus `quality-gate.ts` herausgezogen. Router und Session-Report lesen deren erste Zeile; Cursor schickt jetzt denselben Text.
- `canonical-path.ts`: die Funktion aus `safety-gate.ts`, unverändert verschoben.

**Wo der Capture den Brief widerlegt oder der Brief nicht passt:**

- **`git push` wird immer abgelehnt.** Der Brief wollte für den eigenen Branch ein `ask`. Unter Auto-Review läuft ein `ask` ohne Nachfrage durch (X1), und der Hook sieht den Run Mode nicht. Vorschlag für David in der Tabelle „Entschieden“ im Runbook.
- **Die Übergabe an David läuft über den Agenten, im letzten `stop`, den Cursor noch ruft.** Im Capture kam der Text eines `user_message` auf `stop` nirgends an (C4), und nach `loop_limit` Follow-ups ruft Cursor `stop` gar nicht mehr auf (X11). Der Adapter hält deshalb den letzten Aufruf frei: höchstens `loop_limit − 1` Reparaturrunden, und ist das Gate beim letzten Aufruf noch rot, kommt eine letzte Follow-up-Nachricht: nichts mehr ändern, das Ergebnis mit allen Befunden berichten, aufhören. Er zählt dabei mit Cursors `loop_count` (der auch Follow-ups anderer Hooks sieht) und mit seinem eigenen Zähler, der größere gilt. Ändert der Agent in der letzten Runde trotzdem etwas, prüft das Gate es nicht mehr.
- **`.cursorignore` ist keine zweite Schicht.** Der Research-Stand empfahl, geschützte Dateien zusätzlich dort einzutragen. Im Capture scheiterte zwar das Read-Tool an der ignorierten Datei, Grep und `cat` in der Sandbox zeigten sie aber (C8). Der Leseschutz liegt ganz bei den Hooks; das steht als Lücke in SETUP.md.
- **Runden und Zeitlimit stehen fest in `hooks.json`.** Cursor liest `loop_limit` und `timeout` aus der Datei, nicht je Repo. `loop_limit` ist 5, also höchstens 4 Reparaturrunden plus die Übergabe; der `stop`-Hook hat 900 Sekunden, der Check höchstens 840. Ein Repo mit mehr wird darauf gekürzt. Cursors `loop_count` beginnt laut Capture bei jedem neuen Prompt neu, ebenso der Zähler des Adapters. Jedes Follow-up kommt als `beforeSubmitPrompt` zurück; ein Prompt, der mit `[quality-gate]` beginnt, behält den laufenden Turn.
- **Worktrees:** Cursor legt sie unter `~/.cursor/worktrees/<repo>/<branch>` an. Dieses Verzeichnis ist von der Harness `~/.cursor/` ausgenommen, sonst wäre jeder Schreibzugriff dort gesperrt; seine `.cursor/hooks.json` und `.pi/` bleiben geschützt. Ein Worktree eines freigegebenen Repos gilt als freigegeben (er teilt dessen Historie und `.pi/`).
- **`workspace_roots` reicht nicht (X12).** Im Capture blieb es nach dem Wechsel aus dem Worktree zurück auf dem Worktree stehen, während die Befehle mit eigenem `cwd` im Haupt-Checkout liefen, und im Multi-root-Fenster nannte es nur einen Ordner. Der Adapter nimmt deshalb das `cwd` eines Befehls vor `workspace_roots`, und die Policy für einen Pfad immer aus dem Repo, in dem er liegt. Ein Repo, das der Agent gleich ändert (Write, Delete, Befehl mit `cwd`) und das der Turn noch nicht kennt, tritt ihm bei, mit einer Baseline von vor der Änderung, wenn es freigegeben ist und eine `.pi/gate.json` hat. Dafür schreibt `beforeSubmitPrompt` den Turn jetzt auch ohne Repo. Subagents haben eine eigene Conversation ohne Turn; ihre Änderungen zählen dort, wo der Turn des Agenten das Repo kennt.
- **Grep:** Cursor kann Zeilen nicht aus der Ausgabe entfernen (X3). Der Adapter lehnt deshalb jede Suche ab, die eine vorhandene leseschützte Datei erreichen kann, und nennt Datei und Ausweg. Globs mit `{`, `[` oder `!` gelten als „trifft alles“. Neu nach dem Capture (X12): Eine Grep-Suche ohne Pfad ist dort immer eine Dateisuche (leeres Muster, nur Namen) und fand eine Datei in einem Ordner, den die Hooks nicht sahen. Eine Inhaltssuche ohne Pfad lehnt der Adapter daher ab und bittet um den Ordner als `file_path`; ein Glob, der aus dem Root führt (`..`, absolut, `~`), wird abgelehnt (`searchReadReason`). Eine Dateisuche ohne Pfad prüft er gegen die sichtbaren Ordner; aus anderen Ordnern kann sie Namen zeigen, keine Inhalte. Liest der Agent eine so gefundene Datei, greift der Leseschutz ihres Repos.
- **Mehr Tool-Namen im Matcher:** `preToolUse` prüft neben `Write`, `Delete`, `Read` und `Grep` auch `Shell` (zweite Prüfung, auch in Subagents) und die Schreib-Tools anderer Modelle (`StrReplace`, `Edit`, `MultiEdit`, `ApplyPatch`). Findet der Hook bei einem Schreib-Tool keinen Pfad, lehnt er ab.
- **`beforeTabFileRead`** hält leseschützte Dateien von Tab fern (X9). Dieser Hook blockiert bei einem Fehler nicht, weil Tab nicht der Agent ist.
- **Node:** `link.sh` speichert den aufgelösten Pfad (bei fnm zeigt `command -v node` in `fnm_multishells`, das mit der Shell verschwindet); das gilt jetzt auch für den Capture. Findet ein blockierender Hook kein Node, antwortet `cursor/node.sh` selbst mit `deny` und dem Befehl zum Reparieren, statt nur zu scheitern. `doctor.sh --cursor` prüft Pfad, Version und `fnm_multishells`.
- **`probe.sh`** schreibt unter einer Sperre: Bash schreibt eine Zeile über 4096 Bytes in mehreren Stücken, und die vier Probes auf `sessionStart` liefen gleichzeitig; daher die zwei kaputten Zeilen im Capture.

**Offen, braucht David:** Der Brief zählt dieses Repo in Cursor zur Harness, damit der Agent den Adapter nicht abschalten kann. Damit kann der Agent in Cursor aber auch `pecker-nest` selbst nicht bearbeiten, obwohl AGENTS.md Cursor dafür nennt und Claude Code am 06.12. wegfällt. Ein Vorschlag wäre eine Ausnahme, wenn `pecker-nest` selbst ein Workspace-Ordner ist; dann könnte der Agent dort auch den laufenden Adapter ändern. Nicht gebaut.

**Getestet:** `npm run check` (neu `test/cursor-adapter.test.ts`: jede Regelfamilie mit Payloads in der Form des Captures und erfundenen Pfaden, das Gate mit Ersatz für den Check-Befehl, die Übergabe beim letzten `stop`, Repos, die einem Turn beitreten, Grep ohne Pfad, die Einstiegsskripte als Prozesse, auch mit kaputtem Payload und fehlendem Node, `hooks.json`, `link.sh --cursor`, `cursor-trust.sh`; `test/harness.test.ts`; `test/cursor-user-rule.test.ts`, der scheitert, wenn eine Regel in `APPEND_SYSTEM.md` ohne Entscheidung für die User Rule dazukommt; `doctor.sh --cursor` in `test/doctor.test.ts`; parallele Probes in `test/cursor-capture.test.ts`), `npm run e2e` (Pis Gates mit den herausgezogenen Texten). Alles unter Linux, nicht auf dem Mac.

**Nicht getestet:** alles in Cursor selbst (Handschritte); ob Cursor den Matcher als Alternation liest; ob `beforeTabFileRead` das Feld `file_path` trägt (der Capture hatte den Hook nicht eingetragen); ein echtes Multi-root-Workspace aus einer `.code-workspace`-Datei; das Gate in einem Worktree; die interaktive CLI; macOS-bash 3.2 für `cursor-trust.sh` und die neuen Teile von `link.sh` und `doctor.sh` (geschrieben für 3.2, gelaufen unter Linux-bash). Laut Capture feuern die Hooks nach einem Neustart schon beim ersten Prompt (X6 trat nicht auf), und in der Headless-CLI liefen sie, aber mit etwa 10 s zwischen den Hook-Aufrufen eines Befehls.

## Update 17.11.2026: Supervision-Skills für Cursor und Pi

Vorbereitung auf den Ausstieg aus Claude Code am 06.12.2026. `nest-supervise` und `nest-handoff` liegen jetzt in `skills/` statt in `claude/skills/` (per `git mv`). `scripts/link.sh` verlinkt sie mit `--claude`, `--cursor` (`~/.cursor/skills/`) und `--pi` (`${PI_CODING_AGENT_DIR:-~/.pi/agent}/skills/`, das Verzeichnis, das Pi 1.5.0 neben `~/.agents/skills/` für eigene Skills liest). Pis Package lädt `skills/` weiter, lässt die beiden aber mit `"!skills/nest-*"` aus: sonst sähe jede Worker-Session und das Docker-Image sie, und `--pi` ergäbe eine Namenskollision. In Skill-Verzeichnissen legt `link.sh` keine Sicherung an (`<name>.bak.*` würde als zweite Kopie des Skills geladen); Fremdes bleibt stehen und erscheint als `foreign`. `claude/skills/` hält bis zum Ausstieg zwei Symlinks, damit Links von vor dem Umzug weiter funktionieren. Die Skill-Texte nennen jetzt beide Befehlsformen und kommen ohne `$ARGUMENTS` aus.

**Grenze in Pi:** Das Safety-Gate zählt dieses Repo zur Harness und lehnt Schreibzugriffe unter `~/dev/pecker-nest` ab, die Feldnotiz eingeschlossen. Die Skills sagen dem Aufseher in Pi deshalb, David den Text der Notiz zu geben, statt die Datei zu schreiben.

**Getestet:** `npm run check` (neu `test/link.test.ts`: Links für alle drei Werkzeuge, idempotent, eigener alter Link ersetzt, Fremdes unangetastet, Pis Package ohne die beiden Skills), `npm run e2e`.

**Nicht getestet:** ob Cursor und `cursor-agent` die Skills aus `~/.cursor/skills/` anbieten und ob Cursor die doppelte Sicht über `~/.claude/skills/` zusammenfasst; eine echte Pi-Session mit `/skill:nest-supervise`.

## Nachtrag 15.11.2026: Übergabe vom 10.11. auf dem Mac nachgeprüft

Beide Übergaben vom 10.11. sind mit PR #4 und #5 umgesetzt; gebaut und getestet wurde damals in einer Linux-Umgebung ohne Docker. Auf Davids Mac (macOS, Bash 3.2.57, Node 24.22, Docker Desktop 29.8.2) gegen den Stand `593310d` nachgeprüft, Punkt für Punkt gegen die „Done when“-Kriterien der Übergabe:

- **`npm run check`:** 3 von 334 Unit-Tests scheiterten, nur auf macOS und nur an den Tests, nicht an den Skripten.
  - `build-image.sh` nennt sein Verzeichnis mit `pwd -P`; `tmpdir()` liegt unter `/var`, einem Symlink auf `/private/var`. Der Test vergleicht jetzt mit dem aufgelösten Pfad.
  - `doctor.test.ts` hatte `/usr/bin` im `PATH`, und dort liegt auf macOS das echte `security`. Der Fall „kein Schlüsselbund“ fragte so den echten Schlüsselbund (nur nach Existenz, Konto `tester`), statt kein Werkzeug zu finden. Die Tests verlinken die Systemwerkzeuge jetzt in ein eigenes Verzeichnis, ohne die Programme, für die es Stubs gibt.
- **`npm run e2e`:** 26 Szenarien grün, vorher wie nachher.
- **`npm run e2e:docker`:** zum ersten Mal mit dem unveränderten `Dockerfile.pi` gebaut (`scripts/build-image.sh`) und grün, auf Docker Desktop mit `--network host`. PR #4 hatte eine Variante ohne `apt-get` und uv gebaut.
- **`pi-run.sh` von Hand:** Ein Image von einem älteren Commit endet mit Exit-Code 65 und dem Befehl zum Neubau. Ohne Key (Schlüsselbund-Eintrag fehlt, echtes `security`) endet es mit Exit-Code 64 und dem Schlüsselbund-Befehl.
- **Doku:** Runbook M7, die Stand-Tabelle und der Setup-Guide nannten noch undertext M1 als erstes Projekt. Jetzt steht dort pecker-grove M3c.2, danach undertext, sobald M2 geschrieben ist (Entscheidung vom 08.11., neu in „Entschieden“). Diesen Teil hatte PR #4 ausgelassen.

**Weiter nicht getestet:** alles Live (echte Modelle, OpenRouter, die Probe), `doctor.sh` gegen Davids echtes Setup (nur gegen Stubs, jetzt auch unter macOS) und die TUI.

## Update 15.11.2026: eigenes Metadata Document für die Anmeldung an grove

Der erste echte `pi mcp login kb` endete mit „Client not found.“. Auf einem Wegwerf-Keycloak 26.8.2 mit einer Policy für `pi.dev` (groves Realm-Check) zeigte das Log den eigentlichen Grund: Keycloak lädt Pis Dokument, bricht aber beim Feld `token_endpoint_auth_methods_supported` ab (`UnrecognizedPropertyException`, „Client Metadata fetch failed“). Das ist der Fall, den die offene Prüfung 1 in [research/grove-kb-auth.md](research/grove-kb-auth.md#open-checks) vorhergesehen hat. Das Feld gehört zu Server-Metadaten, nicht in ein Client-Dokument; RFC 7591 verlangt umgekehrt, dass ein Server unbekannte Client-Metadaten ignoriert.

**Lösung:** nest veröffentlicht eine Kopie von Pis Dokument auf GitHub Pages, Branch `gh-pages`: `https://davidkutt.github.io/pecker-nest/oauth/pi-client.json`. Gegenüber dem Original fehlen `token_endpoint_auth_methods_supported` sowie `client_uri` und `logo_uri` (damit grove nur diesem Host vertrauen muss); `client_id` ist die neue URL, `redirect_uris` bleiben `http://127.0.0.1/callback` und `http://localhost/callback`. `agent/mcp.json` setzt diese URL als `oauth.clientId` statt `clientRegistration: "cimd"`. Pi schickt einen gesetzten `clientId` unverändert als `client_id`, mit PKCE S256, freiem Loopback-Port und `resource` (`oauth.js` in Pi 1.5.0, `callbackSettings` und `offersClientMetadataDocument`). grove bekommt dafür die Client-Policy `mcp-pi` für `davidkutt.github.io`, sonst dasselbe Muster wie für Claude Code und VS Code.

**Geprüft** auf dem Wegwerf-Keycloak 26.8.2 mit groves geändertem Realm: carol und bob melden sich mit dem Dokument an (beide Loopback-Formen), `aud=http://localhost:8000/mcp`, `kb:read`, `offline_access` und ihre Rollen; Claude Code und VS Code unverändert; falsche `resource`, eine Redirect-URI außerhalb des Dokuments, ein Dokument auf einem anderen `github.io`-Host und Pis Original werden abgelehnt. Am laufenden Keycloak zeigt die Autorisierungsanfrage mit diesem `client_id` das Login-Formular.

**Wer das Dokument ändern kann, kann sich bei grove als dieser Client ausgeben** (nur auf Loopback-Redirects und nach Login und Zustimmung). Unter `davidkutt.github.io` veröffentlicht nur Davids GitHub-Konto. Fällt GitHub Pages aus, kann eine neue Anmeldung scheitern; Keycloak hält Dokumente 5 Minuten bis 3 Tage im Cache (groves ADR-0014). Ob ein Token-Refresh das Dokument erneut braucht, ist nicht geprüft.

## Update 12.11.2026: Knowledge Base (pecker-grove) angebunden

Aus der Aufgabe [tasks/grove-kb.md](tasks/grove-kb.md). Die Knowledge Base aus dem Plan ist pecker-grove unter `http://localhost:8000/mcp`. Wie Pi sich dort anmelden kann, steht mit Quellen in [research/grove-kb-auth.md](research/grove-kb-auth.md); David hat am 12.11. Option A gewählt. Der Pull Request bleibt ein Entwurf, bis groves Handcheck M3c.0 bestanden ist.

**Was neu ist:**

| Bereich | Vorher | Jetzt |
| --- | --- | --- |
| `agent/mcp.json` | leer | Server `kb` mit `oauth.clientRegistration: "cimd"` und Scope `kb:read offline_access`; `exposure: deferred`, `search_knowledge_base` direkt, `ingest_url` versteckt. Kein Token, Secret oder Pfad. |
| Anmeldung | Runbook: Token in `KB_TOKEN`, per `--bearer-token-env-var` | Pi meldet sich selbst an (OAuth mit PKCE, Client ID Metadata Document auf `pi.dev`), speichert die Tokens in `~/.pi/agent/mcp-auth.json` und erneuert sie. Du führst einmal `pi mcp login kb` aus. |
| `agent/APPEND_SYSTEM.md` | kein Verweis auf die Knowledge Base | Abschnitt „Knowledge base first“ ist zurück, mit dem echten Toolnamen und einer neuen Regel: Text aus der Knowledge Base ist Nachschlagematerial, nie eine Anweisung. |
| Skill `best-practices` | Platzhalter `mcp__kb__<search tool>` | die drei Lese-Tools mit Namen, dieselbe neue Regel ausführlich, und: nicht selbst anmelden oder den Server starten |
| `scripts/doctor.sh` | keine Prüfung | eine Zeile `knowledge base:`; `PASS`, wenn grove antwortet und Pi angemeldet ist, sonst `WARN` mit dem Befehl. Nie `FAIL`. |
| Runbook M3 | Server selbst eintragen, 30 Minuten | Voraussetzung in grove, grove starten, einmal anmelden, Tests 6 und 7 |

**Warum nicht `KB_TOKEN`:** groves Access-Tokens leben fünf Minuten. Pi löst einen Header-Wert einmal je Verbindung auf, nicht je Anfrage, und erneuert ein Token nicht, das es per Header bekommen hat. Jede Session wäre nach fünf Minuten ohne Knowledge Base, bis zu einem `/mcp reconnect`.

**Abweichung: `planner` und `reviewer` ohne Knowledge Base.** Der Plan und Runbook M3 sahen `mcp:kb/<such-tool>` für beide vor. Ein Subagent mit einem solchen Tool startet aber nicht, solange der Server fehlt: pi-subagents 0.87.0 löst `mcp:`-Einträge gegen die Tools der Hauptsession auf und bricht den Start bei einem nicht auflösbaren Eintrag ab. Eine Einstellung, die das Tool optional macht, gibt es weder in Pi noch in pi-subagents (gesucht in Doku und Quellcode, Befund P5). grove läuft nicht immer; mit dem Tool wären `/review-chain` und jeder Planner-Lauf an groves Zustand gebunden. Die Hauptsession schlägt deshalb selbst nach und gibt das Ergebnis in der Aufgabe weiter. Ein Unit-Test hält fest, dass keine Rolle ein `mcp:kb`-Tool hat.

**Was sich in jeder Session ändert, auch ohne grove:** Das Tool `tool_search` ist aktiv, und der System-Prompt führt den Server `mcp__kb` mit seiner Beschreibung im Abschnitt `mcp_servers`. Läuft grove nicht, ist kein `mcp__kb__…`-Tool deklariert, `tool_search` antwortet „No matching tools found.“, und der erste Prompt wartet unter zwei Sekunden auf den gescheiterten Verbindungsversuch. Feldnotizen von vor und nach diesem Stand unterscheiden sich also in der Konfiguration; deshalb wird zwischen zwei nest-Sessions gemergt, nicht während eine Notiz offen ist.

**Getestet:** 334 Unit-Tests und 26 E2E-Szenarien, alle mit eingetragenem `kb` und ohne laufenden Server. Neu:

- ein E2E-Szenario: Der Server ist eingetragen und nicht erreichbar, das Modell sucht trotzdem nach dem Tool. Der Lauf endet mit Exit-Code 0, kein `mcp__`-Tool ist deklariert, der System-Prompt nennt Server, Regel und das Verhalten ohne Knowledge Base;
- das erste Szenario prüft jetzt in beide Richtungen, dass der Abschnitt „Knowledge base first“ und der Eintrag in `mcp.json` zusammen kommen und gehen;
- Unit-Tests auf der echten `agent/mcp.json`: Der Container schaltet `kb` ab (Entscheidung vom 30.10.); die Datei enthält weder Header noch Secret, Umgebungsvariable, Befehl oder Home-Pfad; keine Rolle hat ein `mcp:kb`-Tool;
- `doctor.sh` gegen ein Stub-`pi` in allen Zuständen (verbunden, nicht angemeldet, nicht erreichbar, abgeschaltet, fehlend, unlesbare Antwort): immer Exit-Code 0.

Zusätzlich lief Pi 1.5.0 gegen einen lokalen Mock, der wie groves `/mcp` und wie Keycloaks Metadaten mit CIMD antwortet. Die Autorisierungsanfrage trug `client_id=https://pi.dev/oauth/client.json`, PKCE S256, `scope=kb:read offline_access`, `prompt=consent` und `resource=http://localhost:8000/mcp`.

**Nicht getestet:**

- **Die Anmeldung an einem echten Keycloak.** groves Realm hat noch keine Policy für `pi.dev`, und Docker lief in der Build-Umgebung nicht. Ob Keycloak 26.8.1 Pis Dokument annimmt, zeigt groves Realm-Check.
- **Pis Metadata Document selbst.** `pi.dev` war aus der Build-Umgebung nicht erreichbar. Sein Inhalt entscheidet, welche vertrauenswürdigen Domains groves Policy braucht.
- **Tests 6 und 7** und die Antwortqualität der Suche: Sie brauchen deinen Stack.
- **Die TUI:** die Meldung `MCP servers need attention` und `/mcp`. Geprüft sind der Print-Modus und `pi mcp list`.
- **`doctor.sh` gegen ein echtes `pi mcp list`** lief nur für die Zustände „nicht erreichbar“ und „nicht angemeldet“ (gegen den Mock), der Zustand „verbunden“ nur gegen das Stub.

## Update 10.11.2026 (zweite Übergabe): Messung, Supervision-Skills, Prüfung auf abgeschwächte Tests

Aus der zweiten Übergabe vom 10.11.: Die erste hat die Modelle und das Setup verbessert. Diese liefert, was die nächste begleitete Session braucht, um zu zeigen, ob das geholfen hat. Vier Punkte, ein Commit je Punkt.

**Was neu ist:**

| Bereich | Vorher (10.11., erste Übergabe) | Jetzt |
| --- | --- | --- |
| Session-Report, Ausgang der Wechsel | Wechsel zum starken Modell je Grund und je Modell gezählt | zusätzlich je Grund und starkem Modell: wie oft das Gate danach grün war, wie oft es rot zurückgab, wie viele Anfragen das starke Modell brauchte und was sie kosteten, z. B. `gate, GLM 5.3: 3 switches, 2 green, 1 handed back; 14 strong-model requests, $0.42` |
| Session-Report, Ausweichen bei der Anfrage | nur als Hinweis im Terminal | eigene Zeilen: welches Modell ausgeschlossen wurde, warum, welches übernahm. Der Router schreibt dafür den Eintrag `nest-router-fallback` in die Session |
| Session-Report, Provider | keine Angabe, welcher OpenRouter-Provider eine Anfrage bedient hat | Tabelle je Modell und Provider: Anfragen, Anfragefehler, gescheiterte Tool-Aufrufe und gescheiterte Edits. `extensions/provider-log.ts` schreibt den Provider bei der Anfrage in die Session (Eintrag `nest-provider`) |
| Quality Gate | abgeschwächte Tests nur im Prompt verboten; nur der optionale Reviewer suchte danach | deterministische Prüfung des Diffs seit deinem Prompt (`extensions/lib/tamper-check.ts`). Ein Befund zählt wie ein roter Check |
| `.pi/gate.json` | `command`, `maxRepairRounds`, `timeoutSeconds` | zusätzlich `tamperCheck` (Standard `true`) und `tamperPatterns` (eigene Muster) |
| `doctor.sh` | scheiterte ohne laufenden Docker-Daemon und aktuelles Image | Daemon und Image nur mit `--docker`; ohne den Schalter eine Zeile `SKIP  docker: …`. Der Schlüsselbund-Eintrag bleibt geprüft, ohne `--docker` als `WARN` |
| `/nest-handoff` | nahm die neueste Feldnotiz von heute | nimmt die offene Notiz des Repos: die neueste ohne End-HEAD. Sessions über mehrere Tage behalten eine Notiz |
| `/nest-supervise` | notierte pecker-nest-Commit und Pi-Version | notiert dazu die Denkstufe je Stufe und Rolle und das starke Modell, gelesen aus dem Repo mit `scripts/field-note.ts`, und ob sich der Commit gegenüber der vorigen Notiz geändert hat |
| Abschnitt für den Planungschat | Kosten, Wechsel, Eingriffe | zusätzlich die Mängel, die nests eigenes Gate und Review passiert haben (Bugs, abgeschwächte Tests, Regelbrüche), und die Zeilen zum Ausgang der Wechsel |
| `grill-me` | fragte nach Prefill und Dateiformaten aus dem Stand | liest zuerst die Datenmodelle und Loader, die das Feature bedient, und fragt aus dem, was der Code verlangt |

**Session-Report: wie der Ausgang eines Wechsels bestimmt wird**
- Ein Wechsel beginnt mit dem Router-Eintrag, der auf das starke Modell umstellt, und endet mit deinem nächsten Prompt (oder dem Ende der Session). Auch eine Steering-Nachricht zählt als Prompt.
- Sein Ausgang ist der letzte Gate-Lauf in dieser Zeit: grün („green“), rot („handed back“) oder kein Lauf („without a gate run“: `/plan`, Fragen, Repos ohne `gate.json`). Springt das starke Modell wegen eines roten Gates ein und das Gate läuft danach nicht mehr, weil die Runde nichts geändert hat, zählt der Wechsel als „handed back“.
- Gezählt werden nur Anfragen, die ein starkes Modell bedient hat. Bleibt Flash trotz Wechsel am Zug (Bilder mit GLM), sind es null.
- `/hard` über mehrere Prompts ist ein Wechsel, der mit dem ersten dieser Prompts endet: Der Router schreibt nur dann einen Eintrag, wenn sich die Stufe ändert.
- `--json` trägt die neuen Felder: `stats.escalationOutcomes`, `stats.fallbacks`, `stats.providers`, `stats.tamper`.

**Provider-Zuordnung: warum es keinen `--providers`-Schalter gibt**
- Die Übergabe sah vor, die Antwort-IDs nachträglich über OpenRouters Generation-Abfrage aufzulösen, es sei denn, Pi gibt den Provider schon bei der Anfrage preis. Das tut Pi 1.5.0: Das Event `provider_stream_event` reicht jeden rohen Stream-Chunk an Extensions weiter, und OpenRouter nennt den Provider in jedem Chunk im Feld `provider` (dasselbe Feld liest die Live-Probe für ihre Spalte „Provider“).
- `extensions/provider-log.ts` merkt sich daraus Antwort-ID und Provider und schreibt am Ende des Turns einen Eintrag `nest-provider`. Der Report verbindet ihn über die Antwort-ID mit der Assistant-Nachricht. Die ID kommt in der Session-Datei an (`message.responseId`; in einer Session-Datei aus dem E2E-Lauf nachgesehen).
- Der Report bleibt damit offline: kein Key, keine Anfrage, kein Schalter.
- Eine Anfrage, die scheitert, bevor ein Stream beginnt (404, 400), hat keinen Eintrag. Der Report liest den Provider dann aus dem Fehlertext, wenn OpenRouter dort `provider_name` nennt, und zeigt sonst „–“. Auch Sessions von vor diesem Stand zeigen „–“.
- Die Extension läuft in der Hauptsession (über das Package) und in Subagents (`subagents.defaultSubagentOnlyExtensions`). Lädt ein Subagent sie doppelt, schreibt sie den Eintrag nur einmal.

**Prüfung auf abgeschwächte Tests im Detail**
- **Vergleich:** Bei jedem deiner Prompts hält das Gate den Arbeitsstand als Git-Tree fest, in einer temporären Kopie des Index. Index, Branch und Stash bleiben unberührt, ignorierte Dateien zählen nicht. Vor dem Check vergleicht es diesen Stand mit dem jetzigen (`git diff -M -U0`).
- **Was gemeldet wird**, jeweils mit Datei und Zeile:
  - gelöschte Testdateien (`*.test.*`, `*.spec.*`, `test_*.py`, `*_test.py`, Code in `test/`, `tests/`, `__tests__/`, `e2e/`, `spec/`). Eine verschobene Testdatei ist keine gelöschte.
  - weniger Testfälle in einer geänderten Testdatei. Gezählt werden Zeilen, die mit `it(`, `test(` oder `def test_` beginnen; entfernte minus hinzugefügte.
  - neue Skip- und Fokus-Marker: `.skip`, `.only`, `.fixme`, `xit`, `xdescribe`, `fit`, `fdescribe`, die Option `{ skip: true }` (nur in Testdateien, weil `query.skip(10)` normaler Code ist); in Python `@pytest.mark.skip`, `xfail`, `pytest.skip(…)`, `unittest.skip`.
  - neue Unterdrückungen: `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable`, `oxlint-disable`, `biome-ignore`; in Python `# type: ignore`, `# noqa`, `pyright: ignore`, `# pylint: disable`.
  - Änderungen an Lint-, Typ- und Test-Konfiguration: Dateien wie `tsconfig*.json`, `eslint.config.*`, `.eslintrc*`, `.oxlintrc.json`, `biome.json`, `vitest.config.*`, `jest.config.*`, `playwright.config.*`, `pytest.ini`, `tox.ini`, `mypy.ini`, `pyrightconfig.json`, `ruff.toml`, `.flake8` (auch neu angelegte und gelöschte). In `package.json` ein geändertes oder entferntes Script und die Schlüssel `jest`, `eslintConfig`, `mocha`, `ava`, `vitest`, `c8`, `nyc`; neue Scripts und Abhängigkeiten nicht. In `pyproject.toml` die Tabellen `[tool.ruff]`, `[tool.pyright]`, `[tool.mypy]`, `[tool.pytest]`, `[tool.coverage]` und verwandte, in `setup.cfg` `[flake8]`, `[mypy]`, `[tool:pytest]`, `[coverage:*]`; Abhängigkeiten und `[tool.uv]` nicht.
  - eigene Muster aus `tamperPatterns`, geprüft gegen jede hinzugefügte Zeile.
- **Was „neu“ heißt:** Ein Marker zählt nur, wenn er netto dazukommt. Eine geänderte Zeile, die ihren Marker behält, ist eine entfernte und eine hinzugefügte Zeile und damit kein Befund.
- **Ablauf:** Ein Befund macht das Gate rot, auch wenn der Check-Befehl grün ist (`… passed, but the weakened-test check has 1 finding. Repair round 1 of 2.`). Der Agent soll die Änderung zurücknehmen oder in einem Satz begründen. Begründet er nur und ändert nichts, endet der Lauf nach dieser einen Runde, und die Liste geht an dich: in der Session als Nachricht, headless auf stderr. Sind die Runden aufgebraucht, ebenso. Das Gate nimmt nie selbst etwas zurück.
- **Router:** Ein Befund in Runde 2 ruft das starke Modell wie jedes rote Gate.
- **Session-Log:** Der Eintrag `quality-gate` trägt die Befunde im Feld `tamper`. `ok` ist jetzt das Urteil des Gates (Check grün und kein Befund), `checkOk` das des Befehls. Der Report zählt die Befunde je Prompt einmal, nach Art, und nennt, wie viele am Ende des Laufs noch da waren.
- **Grenzen:** Die Prüfung arbeitet zeilenweise, ohne Parser. Sie sieht nicht, wenn eine Assertion ausgehöhlt wird (`expect(true).toBe(true)`), wenn `parametrize`-Fälle wegfallen oder wenn ein Test umbenannt wird, sodass der Runner ihn nicht mehr findet. Dafür bleiben der Reviewer und die Zählung in `/nest-handoff`. Außerhalb eines Git-Repos läuft sie nicht und sagt das einmal. `/gate` von Hand führt nur den Befehl aus.
- **Fehlalarme mit Ansage:** Wer ein Projekt aufsetzt, legt Konfigurationsdateien neu an und bekommt dafür Befunde. Das kostet eine Runde auf Flash und eine Liste, die du abnickst. Stört es in einem Repo, hilft `"tamperCheck": false`. `.pi/gate.json` selbst kann der Agent nicht ändern; das Safety-Gate schützt `.pi/`.

**Weitere Befunde:**
- **`agent_before_settle` ersetzt Einträge.** Gibt ein Handler `entries` zurück, ersetzt das die Vorschläge der Handler vor ihm (Pi-Doku, Abschnitt „turn_start / turn_end“). Das Quality-Gate hat bisher nur seine eigenen Einträge zurückgegeben und hängt sie jetzt an die vorhandenen an. Aufgefallen ist es beim neuen `nest-provider`-Eintrag.
- **`SKIP` in `doctor.sh`:** Die Zeile zählt weder als Warnung noch als Fehler und steht nicht in der Summe. `/nest-supervise` übernimmt nur `WARN` und `FAIL` in die Feldnotiz; ohne `--docker` ruft `doctor.sh` Docker gar nicht auf.
- **Feldnotizen finden:** Der Dateiname allein unterscheidet `undertext` nicht von `undertext-web`. `scripts/field-note.ts` liest deshalb zusätzlich die Zeile „Repository / branch“ der Notiz. Eine Notiz ohne die Zeile „Start HEAD → end HEAD“ gilt als geschlossen.
- **Die Zeile „Config under test“** nennt `with uncommitted changes`, wenn der pecker-nest-Checkout nicht sauber ist. Die Zahlen einer solchen Session sind mit anderen nicht vergleichbar.

**Getestet:** 329 Unit-Tests und 25 E2E-Szenarien. Neu sind zwei Szenarien: Ein übersprungener Test geht mit Datei und Zeile an den Agenten zurück und das Gate ist grün, sobald der Marker weg ist; bleibt er, bekommt der Nutzer die Liste, und die Datei bleibt, wie sie ist. Bestehende Szenarien prüfen jetzt zusätzlich den Ausgang eines Wechsels, das Ausweichen bei 404 und 400 im Report, den Provider je Anfrage in der Hauptsession und im Worker. Die Unit-Tests decken jeden Detektor an einem TypeScript- und einem Python-Repo ab, `doctor.sh` mit und ohne `--docker` gegen Stub-Programme und `scripts/field-note.ts` mit Notiz-Fixtures.

**Nicht getestet:**
- **Das Feld `provider` im echten OpenRouter-Stream.** Der Mock schickt es, weil OpenRouter es laut Doku schickt; `openrouter.ai` war aus der Build-Umgebung weiter nicht erreichbar. Zeigt die Tabelle „Providers“ nach der ersten echten Session überall „–“, fehlt das Feld. Dann ist die Abfrage über die Generation-ID der nächste Schritt; die ID steht schon in der Session-Datei.
- **Die Skills selbst.** `/nest-supervise` und `/nest-handoff` sind Anweisungstexte für Claude Code. Getestet ist das Skript, aus dem sie ihre Zeilen nehmen, nicht ihr Ablauf.
- **Die Anzeige in der TUI.** Reparaturrunde und Rückgabe mit Befundliste sind im Print-Modus geprüft.
- **Docker.** Der Daemon lief in der Build-Umgebung nicht; `npm run e2e:docker` ist diesmal nicht gelaufen. Im Container gilt für die neue Prüfung dasselbe wie für den Rest des Gates: Sie braucht `git` im Arbeitsverzeichnis.
- **macOS und Bash 3.2:** `doctor.sh` lief unter Bash 5 auf Linux. Die Änderung nutzt nur Konstrukte, die das Skript schon vorher nutzte.

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
| Knowledge Base mit Token (`--bearer-token-env-var KB_TOKEN`) | OAuth-Anmeldung durch Pi mit seinem Client ID Metadata Document; Tokens in Pis eigenem Speicher | groves MCP-Server nimmt kein statisches Token, seine Tokens leben fünf Minuten, und Pi erneuert kein Token aus einem Header. Befunde in [research/grove-kb-auth.md](research/grove-kb-auth.md). |
| `planner` und `reviewer` mit `mcp:kb/<such-tool>` | Beide ohne Knowledge Base; die Hauptsession schlägt nach | Ein Subagent mit `mcp:kb`-Tool startet nicht, solange grove nicht läuft, und das Tool lässt sich nicht optional machen (Update vom 12.11.). |
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
- **Konfiguration:** `.pi/gate.json` mit `command` (Pflicht), `maxRepairRounds` (Standard 2), `timeoutSeconds` (Standard 600), `tamperCheck` (Standard `true`) und `tamperPatterns` (Standard leer).
- **Prüfung auf abgeschwächte Tests (seit 10.11., zweites Update):** Das Gate vergleicht den Arbeitsstand bei deinem Prompt mit dem jetzigen und meldet mit Datei und Zeile: gelöschte Testdateien, weniger Testfälle in einer geänderten Testdatei, neue Skip- und Fokus-Marker, neue Unterdrückungen, Änderungen an Lint-, Typ- und Test-Konfiguration. Ein Befund zählt wie ein roter Check. `"tamperCheck": false` schaltet die Prüfung ab; `"tamperPatterns"` ergänzt eigene Muster, als Liste regulärer Ausdrücke oder als `{ "pattern": "…", "reason": "…" }`. Die Einzelheiten stehen oben im zweiten Update vom 10.11.
- **Nur in vertrauten Projekten:** Die Datei enthält einen Befehl aus dem Repo.
- **Abbruch:** nach `maxRepairRounds`, wenn eine Runde nichts geändert hat, oder bei Exit-Code 127 (Befehl fehlt, also Umgebungsproblem). Du bekommst dann einen Hinweis, headless auf stderr.
- **Protokoll:** Jedes Ergebnis landet als Eintrag `quality-gate` im Session-Log.

## Safety Gate im Detail

- **bash:** blockiert `rm` mit `-r` und `-f` (in jeder Schreibweise) und rekursives `rm` auf `/`, `~` oder `..`. Ebenso `git push` (auch `git -C … push`, seit 18.11. auch über einen Alias mit `-c alias.…`, `--config-env` oder `git config alias.…`, über `git send-pack` und `git subtree push`), `git reset --hard`, `git clean -f…`, seit 18.11. `gh`-Befehle, die mergen, approven, schließen, kommentieren oder sonst auf GitHub schreiben (`gh pr merge`, `gh api -X POST …`), und Downloads, die in eine Shell oder einen Interpreter gepipt werden (`curl … | sh`, `sh <(curl …)`, `bash -c "$(curl …)"`). Das gilt auch hinter `sudo`, `env`, `xargs`, `timeout`, `bash -c` (auch `sh -lc`, `zsh -ic`) und `find -exec`.
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
