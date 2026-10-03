# Stormwreck Sheets

A small Owlbear Rodeo extension with character sheets for the six Dragons of Stormwreck Isle
characters. Plain static files, no build step.

## What it does

- One sheet per character: HP, temp HP, AC, initiative, speed, abilities, saves, skills, attacks.
- Click anything to roll. Results go to the shared roll log and pop up for the other players.
- Advantage / disadvantage toggle, crit detection (19–20 for the Champion fighter at level 3).
- Features with limited uses (Second Wind, Action Surge, Lay on Hands, Channel Divinity,
  Stone's Endurance, Ki, Arcane Recovery) show pips and reset on the right kind of rest.
- Spell slots, prepared spells, cantrips, Divine Smite, Disciple of Life bonus healing,
  ritual casting, Arcane Recovery. Spell descriptions included.
- Short rest (spend hit dice) and long rest buttons.
- Death saves.
- DM-only **Level up** button that applies the next level's HP, features, slots and
  (for the wizard) two new spellbook picks.
- All state lives in the Owlbear room, so everyone sees the same numbers. Players pick their
  character once; the DM sees all six as tabs.

## Files

| Path | Purpose |
|------|---------|
| `manifest.json` | Owlbear extension manifest |
| `index.html`, `style.css`, `app.js` | the sheet |
| `characters.json` | all six characters, transcribed from the PDFs, with level 1–3 progression |
| `spells.json` | short SRD descriptions and roll formulas for every spell on the lists |
| `serve.ps1` | tiny local web server for testing (PowerShell, no installs) |

## Installing in Owlbear Rodeo

Owlbear loads extensions from an HTTPS URL, so the folder has to be hosted somewhere public.
GitHub Pages is free and the simplest option:

1. Create a public GitHub repository and upload the contents of this folder to it.
2. Repository → Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. After a minute the site is live at `https://<user>.github.io/<repo>/`.
4. In Owlbear Rodeo: room menu → Extensions → Add → paste
   `https://<user>.github.io/<repo>/manifest.json`.
5. The sheet icon appears in the room's sidebar for everyone in the room.

Because the manifest uses root-relative paths (`/index.html`, `/icon.svg`), the files must be
served from the site root. If you host under a sub-path, change those two paths in
`manifest.json` to match.

## Testing locally

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Then open <http://localhost:8787/>. Outside Owlbear the sheet runs in a local test mode that
stores state in the browser. `?role=PLAYER&name=Tom` shows the player view. Owlbear itself can
also load `http://localhost:8787/manifest.json` for the DM's own browser during development.

## Changing a character

Everything is data. Edit `characters.json` (abilities, attacks, features, spell lists)
and reload. Live state (current HP, level, used slots) is stored in the room; the DM's menu
has *Reset to level 1* per character if the data changes in a way that needs it.
