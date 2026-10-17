# Liesenberg Elektroplaner – Website

Statische Website (GitHub Pages) mit Anmeldung und Datenbank bei Supabase (EU, Frankfurt).
Ziel-Adresse: **https://planer.liesenberg.biz**

## Was drin ist
- `index.html`, `styles.css`, `planner.js` (Planungslogik, gleich wie die Claude-Version), `app.js` (Anmeldung, Häuser, Beteiligte, Wartungsbuch)
- `config.js` – Supabase-Adresse und öffentlicher Schlüssel (leer = Demo-Modus nur im Browser)
- `vendor/supabase.js` – supabase-js 2.117.2 (MIT), lokal ausgeliefert, damit kein fremdes CDN geladen wird
- `supabase/schema.sql` – Tabellen und Zugriffsregeln
- `impressum.html`, `datenschutz.html` – **Vorlagen, vor dem Veröffentlichen ausfüllen**
- `CNAME` – planer.liesenberg.biz

## Rollen
| Rolle | Darf |
|---|---|
| Besitzer | anlegen, planen, einladen, Rollen ändern, Leute entfernen, Haus löschen |
| Familie | planen, Wartungsbuch schreiben, Haus verlassen |
| Elektriker | planen, Wartungsbuch schreiben, Haus verlassen |

Wer nicht eingeladen ist, sieht nichts. Die Regeln stehen in der Datenbank (Row Level Security), nicht nur in der Website.

## Einrichten (einmalig)
1. **Supabase**: auf supabase.com Konto anlegen → *New project* → Region **Central EU (Frankfurt)**.
2. *SQL Editor* → Inhalt von `supabase/schema.sql` einfügen → *Run*.
3. *Authentication → URL Configuration*: Site URL `https://planer.liesenberg.biz`, bei Redirect URLs dieselbe Adresse eintragen.
4. *Authentication → Emails*: Supabase verschickt ohne eigenes Mail-Konto nur sehr wenige E-Mails pro Stunde.
   Für den Echtbetrieb unter *SMTP Settings* einen Mail-Versand eintragen (z. B. Brevo-SMTP), Absender z. B. planer@liesenberg.biz.
   Den Text der Vorlage „Magic Link“ kann man auf Deutsch ändern.
5. *Project Settings → API*: **Project URL** und **anon public key** in `config.js` eintragen (der anon-Schlüssel darf öffentlich sein; den service_role-Schlüssel nie hier eintragen).
6. **GitHub**: neues öffentliches Repository (z. B. `elektroplaner`), alle Dateien dieses Ordners hochladen, *Settings → Pages* → Branch `main`, Ordner `/ (root)`, Custom domain `planer.liesenberg.biz`, *Enforce HTTPS*.
7. **DNS** beim Domain-Anbieter von liesenberg.biz: `CNAME`-Eintrag `planer` → `michaelliesenberg.github.io`.
8. Impressum und Datenschutz ausfüllen.

## Testen
Getestet am 17.10.2026:
- Datenbankregeln in Postgres 16 mit nachgebildetem Supabase-Login (3 Benutzer: Besitzer, eingeladener Elektriker, Fremder).
- Website in Chromium (Desktop und Handy-Breite): Demo-Modus sowie Anmeldung, Haus anlegen, Speichern, Einladen, Wartungsbuch, Haus löschen mit einem nachgebildeten Supabase-Client.
Noch nicht gegen ein echtes Supabase-Projekt getestet (gibt es noch nicht).
