# የኛ Logo — placement & required files

The official የኛ Bingo logo was **not available in the build environment**, so
placeholder SVGs were committed. Replace them in place — the filenames and paths are
referenced across the app and must not change.

## Files to provide (drop into `public/`)

| File | Purpose | Recommended size |
|---|---|---|
| `public/logo.svg` | Primary horizontal logo — welcome screen, login, lobby header, loading screen, winner screen, admin header. **Replace the placeholder.** | vector |
| `public/logo.png` | Raster fallback of the same horizontal logo. | 640×200 (or 3× for retina) |
| `public/logo-mark.svg` | Square icon-only mark — compact header, PWA. **Replace the placeholder.** | vector |
| `public/favicon.svg` | Browser tab icon (SVG). **Replace the placeholder.** | vector, 64×64 viewBox |
| `public/favicon.png` | Browser tab icon (PNG fallback). | 64×64 |
| `public/icon-192.png` | PWA / Telegram home-screen icon. | 192×192 |
| `public/icon-512.png` | PWA splash / install icon. | 512×512 |
| `public/apple-touch-icon.png` *(optional)* | iOS add-to-home. | 180×180 |

## Where the logo renders in code

- `index.html` — `<link rel="icon">`, `<link rel="apple-touch-icon">`, `<link rel="manifest">`
- `public/manifest.webmanifest` — `icons[]`
- `src/config/brand.ts` — `BRAND.assets.*` (single source of truth for component imports)
- `src/components/common/Logo.tsx` — shared `<Logo />` / `<LogoMark />` used by lobby, login, loading, winner, admin

## Telegram Bot

The bot sends the Mini App button; Telegram shows the Mini App icon from **BotFather**
(`/setuserpic` on the bot, and the Web App short-name icon). Upload `icon-512.png` there.
No repo change needed for that.

## After replacing

No code changes required — the app already points at these paths. Rebuild the frontend
(`npm run build`) and redeploy. Verify the favicon, the lobby header, and the winner screen.
