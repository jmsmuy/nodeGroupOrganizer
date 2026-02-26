# Node Group Organizer

**Repository:** [git@github.com:jmsmuy/nodeGroupOrganizer.git](https://github.com/jmsmuy/nodeGroupOrganizer)

Client-only web app for organizing **nodes** into **groups** under min/max combined weight, while maximizing the total **link weight** inside groups. No server required; everything runs in the browser.

## What it does

- **Nodes** have a weight (e.g. “number of people”).
- **Links** have a weight between pairs of nodes (e.g. “how much they want to sit together”).
- You set **min** and **max** combined weight per group (e.g. table size).
- The solver finds group assignments that respect those bounds and maximize the sum of link weights within groups.
- **Fixed groups**: sets of nodes that must always stay together in one group (e.g. “these guests sit together”). A solution table can contain one fixed group, several fixed groups, or a fixed group plus other nodes.

## How to run

The app is plain HTML + ES modules. Open the HTML files with a **local server** (file:// often blocks modules):

```bash
# From project root
npx serve .
# Then open http://localhost:3000 (generic) or http://localhost:3000/weddingPlan/ (wedding)
```

Or use any static server (e.g. `python -m http.server 8000`) and open the corresponding paths.

- **Generic organizer:** [http://localhost:3000/](http://localhost:3000/) — `index.html` + `app.js`
- **Wedding table planner:** [http://localhost:3000/weddingPlan/](http://localhost:3000/weddingPlan/) — guests = nodes, tables = groups, likeness = link weights; includes tags and fixed groups.

## Project structure

```
nodeGroupOrganizer/
├── solver.js          # Core solver (validate, computeGroups, buildLinkMatrix, …)
├── solver.test.js     # Tests for the solver
├── index.html         # Generic UI
├── app.js             # Generic app (nodes, link matrix, run, results)
├── styles.css         # Generic styles
├── weddingPlan/
│   ├── index.html     # Wedding UI
│   ├── app.js         # Wedding skin (guests, likeness, tags, fixed groups, graph)
│   └── styles.css     # Wedding styles
├── package.json
└── README.md
```

## Tests

```bash
npm test
```

Runs `solver.test.js` with Node’s built-in test runner.

## License

This project is licensed under the [Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/). You may use, share, and adapt it for **non-commercial** purposes only; attribution required. See [LICENSE](LICENSE) for the full text.
