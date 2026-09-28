// Apollo mobile-first dashboard -- entry point for web/index.html, served at
// `/` (the classic split-view dashboard is web/classic.html -> src/main.jsx at
// /classic; see web/vite.config.js's multi-page `rollupOptions.input`). Mirrors main.jsx's own entry point;
// this is a second page sharing the same state layer, not a route inside the
// classic dashboard's bundle.

import { render } from 'preact';
import NextApp from './NextApp.jsx';

render(<NextApp />, document.getElementById('app'));
