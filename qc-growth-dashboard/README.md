# Qc Growth Dashboard

## `qc-growth-dashboard` Attio app

### Build

```bash
npm install
```

### Dev Mode

```bash
npm run dev
```

### App structure

This app uses the folder-based App SDK convention. Extensions are discovered from
`src/app/extensions/<id>/extension.tsx`, and workspace settings are discovered from
`src/app/settings/`. There is no central `src/app.ts` registration file.

The included weather action keeps its dialog, GraphQL documents, and server helper together in
`src/app/extensions/show-weather-forecast/`.

### Linting and formatting

```bash
npm run lint
npm run format
```
