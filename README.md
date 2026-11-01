# Pokémon Coloring Cards

Turn Pokémon TCG cards into black-and-white coloring cards and print them at real card
size (63 × 88 mm, 9 per A4/Letter page) for kids to color. Every card gets the same clean
base layout (text and numbers removed, energy symbols as icons); only the artwork is
converted to line art.

Runs entirely in the browser, hosted on GitHub Pages. Card data and images come from
[TCGdex](https://tcgdex.dev) (and pokemontcg.io for its links).

## Use

1. Search for a Pokémon and click the cards you want. Alternatively paste card links,
   upload/drop images or paste from the clipboard (then check each card's *Layout*).
2. Adjust the lines (presets or sliders).
3. Set copies per card, choose paper, **Download PDF**.
4. Print at **100% / "Actual size"**. Page 1 has a 50 mm line to check the scale.

## Develop

Requires Node 18+.

```sh
npm install
npm run dev      # local dev server
npm test         # unit tests (vitest)
npm run build    # production build into dist/
```

Deployment: pushing to `main` runs [.github/workflows/deploy.yml](.github/workflows/deploy.yml).
One-time setup: repository Settings → Pages → Source: **GitHub Actions**.

See [docs/PLAN.md](docs/PLAN.md) for the design and roadmap.
