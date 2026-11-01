# Pokémon Coloring Cards

Turn Pokémon TCG card images into black-and-white line art and print them at real card
size (63 × 88 mm, 9 per A4/Letter page) for kids to color.

Runs entirely in the browser — hosted on GitHub Pages, no backend, images never leave your machine.

## Use

1. Add cards: paste image links (e.g. `https://images.pokemontcg.io/sv1/1_hires.png`),
   upload/drop files, or copy an image in another tab and press Ctrl+V.
2. Adjust the lines (presets or sliders). Card text is removed by default.
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
